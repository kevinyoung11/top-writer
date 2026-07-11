import type { UserConfig } from "../components/wordflow/user-config";
import { parseVoicePlan } from "./command-parser";
import { buildDiffSegments } from "./diff";
import type { EditorBridge } from "./editor/editor-bridge";
import { normalizeTranscript, type VoicePreferencesStore } from "./preferences";
import type { RewriteService } from "./rewrite-service";
import type { SemanticLocator } from "./semantic-locator";
import { resolveScope, toSpeechContentRanges } from "./scope-resolver";
import { splitRangeIntoSpeechChunks } from "./speech/browser-synthesizer";
import type {
  SpeechChunk,
  SpeechRecognizer,
  SpeechSynthesizer,
} from "./speech/types";
import type {
  LocateCandidate,
  RewritePreview,
  VoiceAction,
  VoiceCopilotState,
  VoiceRange,
  VoiceScope,
} from "./types";

export interface VoiceCopilotScheduler {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface VoiceCopilotDependencies {
  recognizer: SpeechRecognizer;
  synthesizer: SpeechSynthesizer;
  editor: EditorBridge;
  locator: SemanticLocator;
  rewriter: RewriteService;
  preferences: VoicePreferencesStore;
  getModelContext(): { userConfig: UserConfig; userID: string };
  requestTimeoutMs?: number;
  scheduler?: VoiceCopilotScheduler;
}

export const createInitialVoiceState = (): VoiceCopilotState => ({
  phase: "idle",
  documentReady: false,
  transcript: "",
  partialTranscript: "",
  plan: null,
  candidates: [],
  preview: null,
  message: "",
  errorCode: null,
  playback: {
    active: false,
    paused: false,
    paragraphIndex: null,
    rate: 1,
  },
});

const cloneRange = (range: VoiceRange): VoiceRange => ({
  ...range,
  paragraphIndexes: [...range.paragraphIndexes],
});

const clonePreview = (preview: RewritePreview): RewritePreview => ({
  ...preview,
  range: cloneRange(preview.range),
  segments: preview.segments.map((segment) => ({ ...segment })),
});

const cloneCandidate = (candidate: LocateCandidate): LocateCandidate => ({
  ...candidate,
  range: cloneRange(candidate.range),
});

const cloneState = (state: VoiceCopilotState): VoiceCopilotState => ({
  ...state,
  plan: state.plan
    ? {
        ...state.plan,
        actions: state.plan.actions.map((action) => ({
          ...action,
          scope: action.scope ? { ...action.scope } : null,
          constraints: [...action.constraints],
        })),
      }
    : null,
  candidates: state.candidates.map(cloneCandidate),
  preview: state.preview ? clonePreview(state.preview) : null,
  playback: { ...state.playback },
});

const isAbortError = (error: unknown) =>
  (error instanceof Error && error.name === "AbortError") ||
  (typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError");

const clampRate = (rate: number) => Math.max(0.5, Math.min(2, rate));

const DEFAULT_MODEL_TIMEOUT_MS = 20_000;

class ModelTimeoutError extends Error {
  constructor() {
    super("Voice model request timed out");
    this.name = "VoiceModelTimeoutError";
  }
}

const createAbortError = () => {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
};

const defaultScheduler: VoiceCopilotScheduler = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) =>
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

let fallbackPreviewCounter = 0;

const createPreviewId = () => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  fallbackPreviewCounter += 1;
  return `voice-preview-${Date.now().toString(36)}-${fallbackPreviewCounter}`;
};

export class VoiceCopilotController extends EventTarget {
  private readonly dependencies: VoiceCopilotDependencies;
  private stateValue: VoiceCopilotState;
  private operationToken = 0;
  private speechToken = 0;
  private recognitionToken = 0;
  private lastSpokenParagraphIndex: number | null = null;
  private pendingActions: VoiceAction[] = [];
  private resolvedTarget: VoiceRange | null = null;
  private activeAbortController: AbortController | null = null;
  private staleRevisionOperationToken: number | null = null;
  private selfConfirmationActive = false;
  private ignoredSelfRevision: number | null = null;
  private destroyed = false;
  private readonly unsubscribeRevision: () => void;
  private readonly scheduler: VoiceCopilotScheduler;
  private readonly requestTimeoutMs: number;

  constructor(dependencies: VoiceCopilotDependencies) {
    super();
    this.dependencies = dependencies;
    this.scheduler = dependencies.scheduler ?? defaultScheduler;
    this.requestTimeoutMs =
      typeof dependencies.requestTimeoutMs === "number" &&
      Number.isFinite(dependencies.requestTimeoutMs)
        ? Math.max(0, dependencies.requestTimeoutMs)
        : DEFAULT_MODEL_TIMEOUT_MS;
    const snapshot = dependencies.editor.getSnapshot();
    this.stateValue = createInitialVoiceState();
    this.stateValue.documentReady = snapshot.paragraphs.length > 0;
    this.stateValue.playback.rate = clampRate(
      dependencies.preferences.value.rate,
    );
    this.unsubscribeRevision = dependencies.editor.onRevisionChange(
      (revision) => this.onRevisionChange(revision),
    );
  }

  get state(): VoiceCopilotState {
    return cloneState(this.stateValue);
  }

  startListening(): void {
    if (this.destroyed) return;
    if (this.stateValue.phase !== "idle") this.cancel();
    if (!this.dependencies.recognizer.supported) {
      this.setError("speech-unsupported", "当前浏览器不支持语音识别。");
      return;
    }

    const token = ++this.recognitionToken;
    const language = this.dependencies.preferences.value.language;
    this.transition({
      phase: "listening",
      partialTranscript: "",
      message: "正在聆听。",
      errorCode: null,
      candidates: [],
      preview: null,
    });

    try {
      this.dependencies.recognizer.start(language, {
        onStart: () => {
          if (!this.isRecognitionCurrent(token)) return;
          this.transition({ phase: "listening", message: "正在聆听。" });
        },
        onPartial: (text) => {
          if (!this.isRecognitionCurrent(token)) return;
          this.transition({ partialTranscript: text });
        },
        onFinal: (text) => {
          if (!this.isRecognitionCurrent(token)) return;
          this.recognitionToken += 1;
          void this.submitTranscript(text);
        },
        onEnd: () => {
          if (!this.isRecognitionCurrent(token)) return;
          this.recognitionToken += 1;
          if (this.stateValue.phase === "listening") {
            this.transition({ phase: "idle", partialTranscript: "" });
          }
        },
        onError: (code) => {
          if (!this.isRecognitionCurrent(token)) return;
          this.recognitionToken += 1;
          if (code === "aborted") {
            this.transition({ phase: "idle", partialTranscript: "" });
            return;
          }
          this.setError(code, this.messageForRecognitionError(code));
        },
      });
    } catch {
      if (this.isRecognitionCurrent(token)) {
        this.recognitionToken += 1;
        this.setError("recognition-failed", "语音识别未能启动。");
      }
    }
  }

  stopListening(): void {
    if (this.destroyed) return;
    try {
      this.dependencies.recognizer.stop();
    } catch {
      this.setError("recognition-failed", "语音识别未能停止。");
    }
  }

  async submitTranscript(transcript: string): Promise<void> {
    if (this.destroyed) return;
    const token = ++this.operationToken;
    this.recognitionToken += 1;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    const preview = this.stateValue.preview;
    if (preview) this.dependencies.editor.discardPreview(preview.id);
    try {
      this.dependencies.recognizer.cancel();
    } catch {
      // A stale recognizer cannot affect this new operation token.
    }
    this.stopSpeech(true);
    this.pendingActions = [];
    this.resolvedTarget = null;

    const normalized = normalizeTranscript(
      transcript,
      this.dependencies.preferences.value.vocabulary,
    );
    const plan = parseVoicePlan(normalized);
    this.transition({
      phase: "understanding",
      transcript: normalized,
      partialTranscript: "",
      plan,
      candidates: [],
      preview: null,
      message: "正在理解指令。",
      errorCode: null,
    });

    if (plan.actions.length === 0) {
      this.setError("unsupported-command", "暂时无法理解这条语音指令。");
      return;
    }

    this.pendingActions = plan.actions.map((action) => ({
      ...action,
      scope: action.scope ? { ...action.scope } : null,
      constraints: [...action.constraints],
    }));
    await this.runActions(token);
  }

  async read(scope: VoiceScope): Promise<void> {
    if (this.destroyed) return;
    const token = ++this.operationToken;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.stopSpeech(false);
    this.pendingActions = [];
    this.resolvedTarget = null;
    await this.readScope(
      scope,
      token,
      this.stateValue.preview ? "preview" : "idle",
    );
  }

  async chooseCandidate(index: number): Promise<void> {
    if (this.destroyed || this.stateValue.phase !== "clarifying") return;
    const candidate = this.stateValue.candidates[index];
    const snapshot = this.snapshot();
    if (
      !Number.isInteger(index) ||
      !candidate ||
      !this.candidateIsCurrent(candidate, snapshot)
    ) {
      this.pendingActions = [];
      this.dependencies.editor.highlight("candidate", null);
      this.setError("stale-candidate", "候选段落已过期，请重新定位。");
      return;
    }

    this.resolvedTarget = cloneRange(candidate.range);
    this.dependencies.editor.highlight("candidate", null);
    this.transition({
      phase: "understanding",
      candidates: [],
      message: "已选择目标段落。",
      errorCode: null,
    });
    await this.runActions(this.operationToken);
  }

  confirmPreview(): void {
    const preview = this.stateValue.preview;
    if (
      this.destroyed ||
      this.selfConfirmationActive ||
      !preview ||
      preview.mode !== "rewrite"
    ) {
      return;
    }

    this.selfConfirmationActive = true;
    try {
      const result = this.dependencies.editor.applyReplacement(preview.id);
      if (!result.ok) {
        this.failPreview(
          preview,
          result.reason === "stale-revision" ||
            result.reason === "intervening-edit" ||
            result.reason === "preview-not-found"
            ? "stale-preview"
            : "preview-failed",
          "无法应用该预览，正文没有被再次修改。",
        );
        return;
      }
      this.ignoredSelfRevision = result.value.afterRevision;
      this.pendingActions = [];
      this.dependencies.editor.highlight("target", null);
      this.transition({
        phase: "applied",
        preview: null,
        candidates: [],
        message: "改写已应用，可随时撤回。",
        errorCode: null,
        playback: this.idlePlayback(),
      });
    } finally {
      this.selfConfirmationActive = false;
    }
  }

  /**
   * Lets the shared Agent Editor review bar commit the active voice rewrite
   * without bypassing the voice preview and undo bookkeeping.
   */
  acceptSharedReviewSuggestion(suggestionId?: string): boolean {
    const preview = this.stateValue.preview;
    const id = suggestionId ?? this.dependencies.editor.currentAgentSuggestion()?.id;
    if (
      !preview ||
      preview.mode !== "rewrite" ||
      id !== preview.id ||
      !this.dependencies.editor
        .listAgentSuggestions()
        .some((suggestion) => suggestion.id === preview.id)
    ) {
      return false;
    }

    this.confirmPreview();
    return this.stateValue.phase === "applied" && this.stateValue.preview === null;
  }

  rejectPreview(): void {
    const preview = this.stateValue.preview;
    if (this.destroyed || !preview) return;
    this.dependencies.editor.discardPreview(preview.id);
    this.pendingActions = [];
    this.dependencies.editor.highlight("target", null);
    this.transition({
      phase: "idle",
      preview: null,
      candidates: [],
      message: "已保留原文。",
      errorCode: null,
      playback: this.idlePlayback(),
    });
  }

  /**
   * Lets the shared Agent Editor review bar reject the active voice rewrite
   * through the same cleanup path used by the voice panel.
   */
  rejectSharedReviewSuggestion(suggestionId?: string): boolean {
    const preview = this.stateValue.preview;
    const id = suggestionId ?? this.dependencies.editor.currentAgentSuggestion()?.id;
    if (
      !preview ||
      preview.mode !== "rewrite" ||
      id !== preview.id ||
      !this.dependencies.editor
        .listAgentSuggestions()
        .some((suggestion) => suggestion.id === preview.id)
    ) {
      return false;
    }

    this.rejectPreview();
    return this.stateValue.phase === "idle" && this.stateValue.preview === null;
  }

  requestUndo(): void {
    if (this.destroyed) return;
    if (this.stateValue.preview) this.rejectPreview();
    const result = this.dependencies.editor.previewUndoLastVoiceEdit();
    if (!result.ok) {
      this.setError(
        result.reason === "intervening-edit"
          ? "stale-preview"
          : "nothing-to-undo",
        "没有可安全撤回的语音改动。",
      );
      return;
    }
    this.transition({
      phase: "preview",
      preview: result.value,
      candidates: [],
      message: "撤回预览已准备好，请确认是否恢复原文。",
      errorCode: null,
    });
  }

  confirmUndo(): void {
    const preview = this.stateValue.preview;
    if (
      this.destroyed ||
      this.selfConfirmationActive ||
      !preview ||
      preview.mode !== "undo"
    ) {
      return;
    }

    this.selfConfirmationActive = true;
    try {
      const result = this.dependencies.editor.undoLastVoiceEdit(preview.id);
      if (!result.ok) {
        this.failPreview(
          preview,
          "stale-preview",
          "无法撤回该预览，正文没有被再次修改。",
        );
        return;
      }
      this.ignoredSelfRevision = result.value.afterRevision;
      this.pendingActions = [];
      this.dependencies.editor.highlight("target", null);
      this.transition({
        phase: "applied",
        preview: null,
        candidates: [],
        message: "已恢复原文。",
        errorCode: null,
        playback: this.idlePlayback(),
      });
    } finally {
      this.selfConfirmationActive = false;
    }
  }

  async speakOriginal(): Promise<void> {
    const preview = this.stateValue.preview;
    if (this.destroyed || !preview) return;
    const token = ++this.operationToken;
    this.stopSpeech(false);
    const snapshot = this.snapshot();
    if (snapshot.revision !== preview.revision) {
      this.failPreview(
        preview,
        "stale-preview",
        "正文已变化，改写预览已过期。",
      );
      return;
    }
    const chunks = toSpeechContentRanges(preview.range, snapshot).flatMap(
      splitRangeIntoSpeechChunks,
    );
    await this.speakChunks(chunks, token, snapshot.revision, "preview", true);
  }

  async speakReplacement(): Promise<void> {
    const preview = this.stateValue.preview;
    if (this.destroyed || !preview) return;
    const token = ++this.operationToken;
    // A replacement uses temporary, non-document coordinates. Clear only an
    // interrupted original-preview playback marker before it starts; target
    // and candidate decorations still describe the live document preview.
    this.stopSpeech(false);
    this.dependencies.editor.highlight("playback", null);
    const snapshot = this.snapshot();
    if (snapshot.revision !== preview.revision) {
      this.failPreview(
        preview,
        "stale-preview",
        "正文已变化，改写预览已过期。",
      );
      return;
    }
    const temporaryRange: VoiceRange = {
      revision: snapshot.revision,
      from: 0,
      to: preview.replacementText.length,
      text: preview.replacementText,
      paragraphIndexes: [],
      block: false,
    };
    await this.speakChunks(
      splitRangeIntoSpeechChunks(temporaryRange),
      token,
      snapshot.revision,
      "preview",
      false,
    );
  }

  pause(): void {
    if (!this.stateValue.playback.active) return;
    this.dependencies.synthesizer.pause();
    this.transition({
      playback: { ...this.stateValue.playback, paused: true },
    });
  }

  resume(): void {
    if (!this.stateValue.playback.active) return;
    this.dependencies.synthesizer.resume();
    this.transition({
      playback: { ...this.stateValue.playback, paused: false },
    });
  }

  stop(): void {
    if (this.destroyed) return;
    const shouldPreservePreview = this.stateValue.preview !== null;
    this.operationToken += 1;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.pendingActions = [];
    this.stopSpeech(true);
    this.transition({
      phase: shouldPreservePreview ? "preview" : "idle",
      message: shouldPreservePreview ? "已停止朗读预览。" : "",
      errorCode: null,
      playback: this.idlePlayback(),
    });
  }

  setRate(rate: number): void {
    if (this.destroyed || !Number.isFinite(rate)) return;
    const nextRate = clampRate(rate);
    this.dependencies.preferences.update({ rate: nextRate });
    this.transition({
      playback: { ...this.stateValue.playback, rate: nextRate },
    });
  }

  cancel(): void {
    if (this.destroyed) return;
    this.operationToken += 1;
    this.recognitionToken += 1;
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.pendingActions = [];
    this.resolvedTarget = null;
    const preview = this.stateValue.preview;
    if (preview) this.dependencies.editor.discardPreview(preview.id);
    try {
      this.dependencies.recognizer.cancel();
    } catch {
      // The next operation is still guarded by its token.
    }
    this.stopSpeech(true);
    this.transition({
      ...createInitialVoiceState(),
      documentReady:
        this.dependencies.editor.getSnapshot().paragraphs.length > 0,
      playback: {
        active: false,
        paused: false,
        paragraphIndex: null,
        rate: this.stateValue.playback.rate,
      },
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.cancel();
    this.destroyed = true;
    this.unsubscribeRevision();
  }

  private async runActions(token: number): Promise<void> {
    while (this.isOperationCurrent(token) && this.pendingActions.length > 0) {
      const action = this.pendingActions.shift();
      if (!action) break;
      const continueQueue = await this.executeAction(action, token);
      if (!continueQueue || !this.isOperationCurrent(token)) return;
      if (this.stateValue.phase === "error") return;
    }
    if (
      this.isOperationCurrent(token) &&
      this.pendingActions.length === 0 &&
      this.stateValue.phase === "understanding"
    ) {
      this.transition({ phase: "idle", message: "", errorCode: null });
    }
  }

  private async executeAction(
    action: VoiceAction,
    token: number,
  ): Promise<boolean> {
    switch (action.intent) {
      case "read":
        if (!action.scope) {
          this.setError("range-unavailable", "找不到可朗读的文本范围。");
          return false;
        }
        await this.readScope(
          action.scope,
          token,
          this.pendingActions.length > 0 ? "understanding" : "idle",
        );
        return this.stateValue.phase !== "error";
      case "locate":
        return this.locate(action, token);
      case "rewrite":
        return this.rewrite(action, token);
      case "control":
        return this.runControl(action.control);
      case "undo":
        this.requestUndo();
        return false;
      default:
        this.setError("unsupported-command", "该语音动作暂未准备好。");
        return false;
    }
  }

  private runControl(control: VoiceAction["control"]): boolean {
    switch (control) {
      case "pause":
        this.pause();
        return true;
      case "resume":
        this.resume();
        return true;
      case "stop":
        this.stop();
        return false;
      case "faster":
        this.setRate(this.stateValue.playback.rate + 0.1);
        return true;
      case "slower":
        this.setRate(this.stateValue.playback.rate - 0.1);
        return true;
      default:
        this.setError("unsupported-command", "无法执行该播放控制。");
        return false;
    }
  }

  private async locate(action: VoiceAction, token: number): Promise<boolean> {
    if (action.scope?.kind !== "semantic") {
      this.setError("range-unavailable", "找不到要定位的文本范围。");
      return false;
    }
    const query = action.scope.query;
    const snapshot = this.snapshot();
    if (snapshot.paragraphs.length === 0) {
      this.setError("document-empty", "文档中没有可定位的内容。");
      return false;
    }

    const controller = this.beginModelRequest();
    try {
      const context = this.dependencies.getModelContext();
      const candidates = await this.runModelRequest(controller, () =>
        this.dependencies.locator.locate(query, snapshot, {
          ...context,
          signal: controller.signal,
        }),
      );
      if (!this.isOperationCurrent(token)) return false;
      if (
        this.dependencies.editor.getSnapshot().revision !== snapshot.revision
      ) {
        this.setError("stale-candidate", "正文已变化，请重新定位。");
        return false;
      }
      const validCandidates = candidates
        .filter((candidate) => this.candidateIsCurrent(candidate, snapshot))
        .slice(0, 3);
      if (validCandidates.length === 0) {
        this.setError("not-found", "没有找到匹配的段落。");
        return false;
      }
      if (this.isUnambiguous(validCandidates)) {
        this.resolvedTarget = cloneRange(validCandidates[0].range);
        this.dependencies.editor.highlight("candidate", null);
        return true;
      }

      this.dependencies.editor.highlight("candidate", validCandidates[0].range);
      this.transition({
        phase: "clarifying",
        candidates: validCandidates,
        message: "找到了多个可能的段落，请选择一个。",
        errorCode: null,
      });
      return false;
    } catch (error) {
      if (!this.isOperationCurrent(token)) return false;
      if (this.staleRevisionOperationToken === token) {
        this.staleRevisionOperationToken = null;
        this.setError("stale-candidate", "正文已变化，请重新定位。");
        return false;
      }
      if (error instanceof ModelTimeoutError) {
        this.setError("timeout", "服务响应超时，正文没有被修改。");
        return false;
      }
      if (isAbortError(error)) {
        this.transition({ phase: "idle", message: "", errorCode: null });
        return false;
      }
      this.setError("locate-failed", "定位失败，正文没有被修改。");
      return false;
    } finally {
      this.finishModelRequest(controller);
    }
  }

  private async rewrite(action: VoiceAction, token: number): Promise<boolean> {
    if (!action.scope) {
      this.setError("range-unavailable", "找不到要改写的文本范围。");
      return false;
    }
    const snapshot = this.snapshot();
    const range = resolveScope(action.scope, snapshot, this.resolvedTarget);
    if (!range) {
      this.setError("range-unavailable", "找不到要改写的文本范围。");
      return false;
    }
    if (range.revision !== snapshot.revision) {
      this.setError("stale-preview", "正文已变化，请重新生成预览。");
      return false;
    }

    this.dependencies.editor.highlight("target", range);
    const controller = this.beginModelRequest();
    try {
      const context = this.dependencies.getModelContext();
      const replacement = await this.runModelRequest(controller, () =>
        this.dependencies.rewriter.rewrite({
          snapshot,
          range: cloneRange(range),
          constraints: [...action.constraints],
          userConfig: context.userConfig,
          userID: context.userID,
          signal: controller.signal,
        }),
      );
      if (!this.isOperationCurrent(token)) return false;
      if (
        this.dependencies.editor.getSnapshot().revision !== snapshot.revision
      ) {
        this.setError("stale-preview", "正文已变化，请重新生成预览。");
        return false;
      }
      const preview: RewritePreview = {
        id: createPreviewId(),
        revision: snapshot.revision,
        range: cloneRange(range),
        originalText: range.text,
        replacementText: replacement,
        segments: buildDiffSegments(range.text, replacement),
        mode: "rewrite",
      };
      const bridge = this.dependencies.editor as EditorBridge & {
        stageVoiceRewriteSuggestion?: (
          value: RewritePreview,
        ) => Promise<ReturnType<EditorBridge["stagePreview"]>>;
      };
      const staged = bridge.stageVoiceRewriteSuggestion
        ? await bridge.stageVoiceRewriteSuggestion(preview)
        : bridge.stagePreview(preview);
      if (!this.isOperationCurrent(token)) {
        this.dependencies.editor.discardPreview(preview.id);
        return false;
      }
      if (!staged.ok) {
        this.setError(
          staged.reason === "stale-revision"
            ? "stale-preview"
            : "preview-failed",
          "无法创建安全的改写预览。",
        );
        return false;
      }
      this.transition({
        phase: "preview",
        preview,
        message: "改写预览已准备好，请确认是否应用。",
        errorCode: null,
      });
      return false;
    } catch (error) {
      if (!this.isOperationCurrent(token)) return false;
      if (this.staleRevisionOperationToken === token) {
        this.staleRevisionOperationToken = null;
        this.setError("stale-preview", "正文已变化，请重新生成预览。");
        return false;
      }
      if (error instanceof ModelTimeoutError) {
        this.setError("timeout", "服务响应超时，正文没有被修改。");
        return false;
      }
      if (isAbortError(error)) {
        this.transition({ phase: "idle", message: "", errorCode: null });
        return false;
      }
      this.setError(
        error instanceof Error ? error.message : "rewrite-failed",
        "改写失败，正文没有被修改。",
      );
      return false;
    } finally {
      this.finishModelRequest(controller);
    }
  }

  private beginModelRequest(): AbortController {
    this.activeAbortController?.abort();
    const controller = new AbortController();
    this.activeAbortController = controller;
    return controller;
  }

  private finishModelRequest(controller: AbortController): void {
    if (this.activeAbortController === controller) {
      this.activeAbortController = null;
    }
  }

  private runModelRequest<T>(
    controller: AbortController,
    request: () => Promise<T>,
  ): Promise<T> {
    let pending: Promise<T>;
    try {
      pending = request();
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.requestTimeoutMs <= 0) return pending;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let handle: unknown;
      const settle = (callback: () => void) => {
        if (settled) return;
        settled = true;
        controller.signal.removeEventListener("abort", onAbort);
        this.scheduler.clearTimeout(handle);
        callback();
      };
      const onAbort = () =>
        settle(() =>
          reject(timedOut ? new ModelTimeoutError() : createAbortError()),
        );
      handle = this.scheduler.setTimeout(() => {
        if (settled) return;
        timedOut = true;
        controller.abort();
      }, this.requestTimeoutMs);
      controller.signal.addEventListener("abort", onAbort, { once: true });
      pending.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    });
  }

  private candidateIsCurrent(
    candidate: LocateCandidate,
    snapshot: ReturnType<VoiceCopilotController["snapshot"]>,
  ): boolean {
    const range = candidate.range;
    if (
      range.revision !== snapshot.revision ||
      !Number.isSafeInteger(range.from) ||
      !Number.isSafeInteger(range.to) ||
      range.from >= range.to ||
      range.paragraphIndexes.length === 0
    ) {
      return false;
    }
    const paragraphs = snapshot.paragraphs.filter(
      (paragraph) =>
        range.from < paragraph.nodeTo && range.to > paragraph.nodeFrom,
    );
    if (
      paragraphs.length !== range.paragraphIndexes.length ||
      paragraphs.some(
        (paragraph, index) => paragraph.index !== range.paragraphIndexes[index],
      )
    ) {
      return false;
    }
    const first = paragraphs[0];
    const last = paragraphs[paragraphs.length - 1];
    if (
      !first ||
      !last ||
      range.from < first.nodeFrom ||
      range.to > last.nodeTo
    ) {
      return false;
    }

    let text = "";
    for (const [index, paragraph] of paragraphs.entries()) {
      if (index > 0) {
        if (typeof paragraph.separatorBefore !== "string") return false;
        text += paragraph.separatorBefore;
      }
      const from = Math.max(range.from, paragraph.from);
      const to = Math.min(range.to, paragraph.to);
      if (to < from) return false;
      const slice = paragraph.text.slice(
        from - paragraph.from,
        to - paragraph.from,
      );
      if (slice.length !== to - from) return false;
      text += slice;
    }
    return text.length > 0 && text === range.text;
  }

  private isUnambiguous(candidates: readonly LocateCandidate[]): boolean {
    // Locator returns exactly one candidate for a unique local/exact result.
    // A score gap is not permission to guess when more than one paragraph was
    // returned: rewriting or reading the wrong paragraph is worse than asking.
    return candidates.length === 1;
  }

  private async readScope(
    scope: VoiceScope,
    token: number,
    finalPhase: "idle" | "understanding" | "preview",
  ): Promise<void> {
    const snapshot = this.snapshot();
    const range = resolveScope(scope, snapshot, this.resolvedTarget);
    if (!range) {
      this.setError("range-unavailable", "找不到可朗读的文本范围。");
      return;
    }
    const chunks = toSpeechContentRanges(range, snapshot).flatMap(
      splitRangeIntoSpeechChunks,
    );
    if (chunks.length === 0) {
      this.transition({ phase: finalPhase, message: "没有可朗读的文本。" });
      return;
    }

    await this.speakChunks(chunks, token, snapshot.revision, finalPhase, true);
  }

  private async speakChunks(
    chunks: SpeechChunk[],
    token: number,
    revision: number,
    finalPhase: "idle" | "understanding" | "preview",
    highlightDocument: boolean,
  ): Promise<void> {
    if (chunks.length === 0) {
      this.transition({ phase: finalPhase, message: "没有可朗读的文本。" });
      return;
    }

    const speechToken = ++this.speechToken;
    const preferences = this.dependencies.preferences.value;
    this.transition({
      phase: "reading",
      message: "正在朗读。",
      errorCode: null,
      playback: {
        active: true,
        paused: false,
        paragraphIndex: null,
        rate: this.stateValue.playback.rate,
      },
    });

    try {
      await this.dependencies.synthesizer.speak(chunks, {
        language: preferences.language,
        rate: this.stateValue.playback.rate,
        voiceURI: preferences.voiceURI,
        onChunkStart: (chunk) => {
          if (!this.isSpeechCurrent(speechToken, token, revision)) {
            return;
          }
          if (highlightDocument) {
            this.dependencies.editor.highlight("playback", chunk.range);
            this.lastSpokenParagraphIndex =
              chunk.range.paragraphIndexes[0] ?? this.lastSpokenParagraphIndex;
          }
          this.transition({
            playback: {
              active: true,
              paused: false,
              paragraphIndex: chunk.range.paragraphIndexes[0] ?? null,
              rate: this.stateValue.playback.rate,
            },
          });
        },
        onError: () => {},
      });
    } catch (error) {
      if (!this.isSpeechCurrent(speechToken, token, revision)) return;
      if (isAbortError(error)) {
        this.transition({ phase: finalPhase, playback: this.idlePlayback() });
        return;
      }
      this.setError("synthesis-failed", "朗读失败，正文没有被修改。");
      return;
    }

    if (!this.isSpeechCurrent(speechToken, token, revision)) return;
    if (highlightDocument) this.dependencies.editor.highlight("playback", null);
    this.transition({
      phase: finalPhase,
      message: "",
      playback: this.idlePlayback(),
    });
  }

  private stopSpeech(clearHighlights: boolean): void {
    this.speechToken += 1;
    try {
      this.dependencies.synthesizer.cancel();
    } catch {
      // Generation tokens prevent stale callbacks from changing state.
    }
    if (clearHighlights) {
      this.dependencies.editor.highlight("playback", null);
      this.dependencies.editor.highlight("candidate", null);
      this.dependencies.editor.highlight("target", null);
    }
  }

  private snapshot() {
    return this.dependencies.editor.getSnapshot(this.lastSpokenParagraphIndex);
  }

  private isOperationCurrent(token: number) {
    return !this.destroyed && token === this.operationToken;
  }

  private isSpeechCurrent(
    speechToken: number,
    operationToken: number,
    revision: number,
  ) {
    return (
      this.isOperationCurrent(operationToken) &&
      speechToken === this.speechToken &&
      this.dependencies.editor.getSnapshot().revision === revision
    );
  }

  private isRecognitionCurrent(token: number) {
    return !this.destroyed && token === this.recognitionToken;
  }

  private onRevisionChange(revision: number): void {
    if (this.destroyed || this.selfConfirmationActive) return;
    if (revision === this.ignoredSelfRevision) {
      this.ignoredSelfRevision = null;
      return;
    }
    const preview = this.stateValue.preview;
    if (revision === preview?.revision) return;
    if (preview) {
      const rebaseSharedVoicePreview = (
        this.dependencies.editor as EditorBridge & {
          rebaseSharedVoiceRewritePreview?: (
            previewId: string,
          ) => RewritePreview | null;
        }
      ).rebaseSharedVoiceRewritePreview;
      const rebased = rebaseSharedVoicePreview?.call(
        this.dependencies.editor,
        preview.id,
      );
      if (rebased) {
        this.transition({ preview: rebased });
        return;
      }
      this.failPreview(
        preview,
        "stale-preview",
        "正文已变化，改写预览已过期。",
      );
      return;
    }
    if (this.activeAbortController) {
      this.staleRevisionOperationToken = this.operationToken;
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    if (this.stateValue.playback.active) {
      this.operationToken += 1;
      this.stopSpeech(true);
      this.transition({
        phase: "idle",
        message: "正文已变化，已停止朗读。",
        errorCode: null,
        playback: this.idlePlayback(),
      });
    }
  }

  private failPreview(
    preview: RewritePreview,
    code: string,
    message: string,
  ): void {
    this.activeAbortController?.abort();
    this.activeAbortController = null;
    this.stopSpeech(true);
    this.dependencies.editor.discardPreview(preview.id);
    this.pendingActions = [];
    this.transition({
      phase: "error",
      preview: null,
      candidates: [],
      message,
      errorCode: code,
      playback: this.idlePlayback(),
    });
  }

  private idlePlayback() {
    return {
      active: false,
      paused: false,
      paragraphIndex: null,
      rate: this.stateValue.playback.rate,
    };
  }

  private transition(patch: Partial<VoiceCopilotState>): void {
    this.stateValue = {
      ...this.stateValue,
      ...patch,
      candidates: patch.candidates
        ? patch.candidates.map(cloneCandidate)
        : this.stateValue.candidates,
      preview:
        patch.preview === undefined
          ? this.stateValue.preview
          : patch.preview
            ? clonePreview(patch.preview)
            : null,
      playback: patch.playback
        ? { ...patch.playback }
        : { ...this.stateValue.playback },
    };
    this.dispatchEvent(
      new CustomEvent<VoiceCopilotState>("state-change", {
        detail: cloneState(this.stateValue),
      }),
    );
  }

  private setError(code: string, message: string): void {
    this.pendingActions = [];
    this.transition({
      phase: "error",
      message,
      errorCode: code,
      playback: this.idlePlayback(),
    });
  }

  private messageForRecognitionError(code: string): string {
    const messages: Record<string, string> = {
      "no-speech": "没有听清，请再说一次。",
      "permission-denied": "请允许麦克风权限后重试。",
      "audio-capture": "无法访问麦克风。",
      network: "语音识别网络异常。",
      "language-not-supported": "当前语音语言不可用。",
      "service-not-allowed": "语音服务不可用。",
      unknown: "语音识别发生错误。",
    };
    return messages[code] ?? messages.unknown;
  }
}
