import { describe, expect, it, vi } from "vitest";
import {
  ModelFamily,
  SupportedRemoteModel,
  type UserConfig,
} from "../components/wordflow/user-config";
import type { EditorBridge, BridgeResult } from "./editor/editor-bridge";
import { VoicePreferencesStore } from "./preferences";
import type { RewriteService } from "./rewrite-service";
import type { SemanticLocator } from "./semantic-locator";
import type {
  RecognitionHandlers,
  SpeechChunk,
  SpeechRecognizer,
  SpeechSynthesizer,
  SynthesisOptions,
} from "./speech/types";
import type {
  EditorSnapshot,
  LocateCandidate,
  ParagraphRef,
  RewritePreview,
  VoiceRange,
} from "./types";
import {
  createInitialVoiceState,
  VoiceCopilotController,
} from "./voice-copilot-controller";

const userConfig: UserConfig = {
  preferredLLM: SupportedRemoteModel["gpt-5-nano-free"],
  llmAPIKeys: {
    [ModelFamily.openAI]: "test-openai-key",
    [ModelFamily.google]: "test-google-key",
    [ModelFamily.local]: "test-local-key",
  },
};

const clone = <T>(value: T): T => structuredClone(value);

const paragraph = (index: number, text: string): ParagraphRef => {
  const nodeFrom = index * 100;
  const from = nodeFrom + 1;
  const to = from + text.length;
  return {
    id: `paragraph-${index}`,
    index,
    nodeType: "paragraph",
    nodeFrom,
    nodeTo: to + 1,
    from,
    to,
    text,
    separatorBefore: index === 0 ? "" : "\n\n",
  };
};

const snapshot = (
  revision = 1,
  texts = ["第一段谈用户信任。", "第二段说明产品价值。", "第三段收束。"],
): EditorSnapshot => ({
  revision,
  paragraphs: texts.map((text, index) => paragraph(index, text)),
  selection: null,
  currentParagraphIndex: 0,
  lastSpokenParagraphIndex: null,
});

const paragraphRange = (value: EditorSnapshot, index: number): VoiceRange => {
  const item = value.paragraphs[index];
  return {
    revision: value.revision,
    from: item.nodeFrom,
    to: item.nodeTo,
    text: item.text,
    paragraphIndexes: [item.index],
    block: true,
  };
};

const ok = <T>(value: T): BridgeResult<T> => ({ ok: true, value });

const fail = <T>(
  reason: "stale-revision" | "preview-not-found" | "intervening-edit",
): BridgeResult<T> => ({ ok: false, reason });

const abortError = () => {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
};

class FakeRecognizer implements SpeechRecognizer {
  supported = true;
  starts: Array<{ language: string; handlers: RecognitionHandlers }> = [];
  stops = 0;
  cancels = 0;

  start(language: string, handlers: RecognitionHandlers) {
    this.starts.push({ language, handlers });
  }

  stop() {
    this.stops += 1;
  }

  cancel() {
    this.cancels += 1;
  }

  latest() {
    const session = this.starts.at(-1);
    if (!session) throw new Error("No recognition session started");
    return session.handlers;
  }
}

interface PendingSpeech {
  chunks: SpeechChunk[];
  options: SynthesisOptions;
  resolve: () => void;
  reject: (error: Error) => void;
}

class FakeSynthesizer implements SpeechSynthesizer {
  supported = true;
  calls: Array<{ chunks: SpeechChunk[]; options: SynthesisOptions }> = [];
  pauses = 0;
  resumes = 0;
  cancels = 0;
  pending: PendingSpeech | null = null;

  speak(chunks: SpeechChunk[], options: SynthesisOptions) {
    this.calls.push({ chunks: clone(chunks), options });
    return new Promise<void>((resolve, reject) => {
      this.pending = { chunks, options, resolve, reject };
    });
  }

  pause() {
    this.pauses += 1;
  }

  resume() {
    this.resumes += 1;
  }

  cancel() {
    this.cancels += 1;
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    pending.options.onError("cancelled");
    pending.reject(abortError());
  }

  startChunk(index = 0) {
    const pending = this.pending;
    if (!pending) throw new Error("No speech is pending");
    const chunk = pending.chunks[index];
    if (!chunk) throw new Error("Unknown speech chunk");
    pending.options.onChunkStart(chunk);
  }

  finish() {
    const pending = this.pending;
    this.pending = null;
    pending?.resolve();
  }

  reject(error = new Error("synthesis failed")) {
    const pending = this.pending;
    this.pending = null;
    pending?.reject(error);
  }
}

class FakeEditor {
  value: EditorSnapshot;
  readonly highlights: Array<{ channel: string; range: VoiceRange | null }> =
    [];
  readonly staged = new Map<string, RewritePreview>();
  readonly discarded: string[] = [];
  readonly applied: string[] = [];
  readonly undone: string[] = [];
  private readonly listeners = new Set<(revision: number) => void>();
  undoPreview: RewritePreview | null = null;
  applyResult: BridgeResult<{ beforeRevision: number; afterRevision: number }> =
    ok({ beforeRevision: 1, afterRevision: 2 });
  undoResult: BridgeResult<{ beforeRevision: number; afterRevision: number }> =
    ok({ beforeRevision: 2, afterRevision: 3 });

  constructor(value = snapshot()) {
    this.value = clone(value);
  }

  getSnapshot(lastSpokenParagraphIndex: number | null = null) {
    return {
      ...clone(this.value),
      lastSpokenParagraphIndex,
    };
  }

  highlight(channel: string, range: VoiceRange | null) {
    this.highlights.push({ channel, range: range ? clone(range) : null });
    return ok(undefined);
  }

  stagePreview(preview: RewritePreview) {
    this.staged.set(preview.id, clone(preview));
    return ok(undefined);
  }

  discardPreview(previewId: string) {
    this.discarded.push(previewId);
    this.staged.delete(previewId);
    return ok(undefined);
  }

  applyReplacement(previewId: string) {
    this.applied.push(previewId);
    this.staged.delete(previewId);
    if (this.applyResult.ok) {
      this.value.revision = this.applyResult.value.afterRevision;
      this.emitRevision(this.value.revision);
    }
    return this.applyResult;
  }

  previewUndoLastVoiceEdit() {
    return this.undoPreview
      ? ok(clone(this.undoPreview))
      : fail("intervening-edit");
  }

  undoLastVoiceEdit(previewId: string) {
    this.undone.push(previewId);
    if (this.undoResult.ok) {
      this.value.revision = this.undoResult.value.afterRevision;
      this.emitRevision(this.value.revision);
    }
    return this.undoResult;
  }

  onRevisionChange(listener: (revision: number) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitRevision(revision: number) {
    this.value.revision = revision;
    for (const listener of [...this.listeners]) listener(revision);
  }
}

const createDeferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
};

const drainMicrotasks = async (count = 8) => {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
};

const createController = (
  options: {
    editor?: FakeEditor;
    recognizer?: FakeRecognizer;
    synthesizer?: FakeSynthesizer;
    locate?: (
      query: string,
      value: EditorSnapshot,
      signal?: AbortSignal,
    ) => Promise<LocateCandidate[]>;
    rewrite?: (input: {
      snapshot: EditorSnapshot;
      range: VoiceRange;
      constraints: string[];
      signal?: AbortSignal;
    }) => Promise<string>;
    requestTimeoutMs?: number;
    scheduler?: {
      setTimeout(callback: () => void, delay: number): unknown;
      clearTimeout(handle: unknown): void;
    };
  } = {},
) => {
  const editor = options.editor ?? new FakeEditor();
  const recognizer = options.recognizer ?? new FakeRecognizer();
  const synthesizer = options.synthesizer ?? new FakeSynthesizer();
  const locate = vi.fn(
    async (
      query: string,
      value: EditorSnapshot,
      context: { signal?: AbortSignal },
    ) => options.locate?.(query, value, context.signal) ?? [],
  );
  const rewrite = vi.fn(
    async (input: {
      snapshot: EditorSnapshot;
      range: VoiceRange;
      constraints: string[];
      signal?: AbortSignal;
    }) => options.rewrite?.(input) ?? "改写后的文本。",
  );
  const preferences = new VoicePreferencesStore(null);
  const controller = new VoiceCopilotController({
    recognizer,
    synthesizer,
    editor: editor as unknown as EditorBridge,
    locator: { locate } as unknown as SemanticLocator,
    rewriter: { rewrite } as unknown as RewriteService,
    preferences,
    getModelContext: () => ({ userConfig, userID: "test-user" }),
    requestTimeoutMs: options.requestTimeoutMs,
    scheduler: options.scheduler,
  });
  return {
    controller,
    editor,
    recognizer,
    synthesizer,
    locate,
    rewrite,
    preferences,
  };
};

describe("VoiceCopilotController", () => {
  it("creates the approved idle state without sharing mutable child objects", () => {
    const first = createInitialVoiceState();
    const second = createInitialVoiceState();

    expect(first).toEqual({
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
    expect(first.candidates).not.toBe(second.candidates);
    expect(first.playback).not.toBe(second.playback);
  });

  it("initializes document readiness and exposes only deep state snapshots in events", () => {
    const { controller } = createController();
    const seen: EditorSnapshot[] = [];
    const details: unknown[] = [];
    controller.addEventListener("state-change", (event) => {
      details.push((event as CustomEvent).detail);
    });

    expect(controller.state).toMatchObject({
      phase: "idle",
      documentReady: true,
      playback: { rate: 1 },
    });
    const exposed = controller.state;
    exposed.playback.rate = 2;
    exposed.candidates.push({
      range: paragraphRange(snapshot(), 0),
      score: 1,
      reason: "mutated outside",
    });

    controller.setRate(1.3);

    expect(controller.state.playback.rate).toBe(1.3);
    expect(controller.state.candidates).toEqual([]);
    expect(details).toHaveLength(1);
    const detail = details[0] as typeof controller.state;
    detail.playback.rate = 0.5;
    expect(controller.state.playback.rate).toBe(1.3);
    expect(seen).toEqual([]);
  });

  it("moves idle through listening and final transcript understanding after vocabulary normalization", async () => {
    const { controller, recognizer, preferences } = createController();
    preferences.addVocabulary({ spoken: "下一节", written: "下一段" });

    controller.startListening();
    recognizer.latest().onStart();
    recognizer.latest().onPartial("读下一节");

    expect(controller.state).toMatchObject({
      phase: "listening",
      partialTranscript: "读下一节",
    });

    recognizer.latest().onFinal("读下一节");
    await Promise.resolve();

    expect(controller.state).toMatchObject({
      transcript: "读下一段",
      partialTranscript: "",
      phase: "reading",
    });
  });

  it("ignores recognition callbacks from an older listening session", () => {
    const { controller, recognizer } = createController();

    controller.startListening();
    const oldHandlers = recognizer.latest();
    controller.startListening();
    const currentHandlers = recognizer.latest();
    oldHandlers.onPartial("旧会话");
    currentHandlers.onPartial("新会话");

    expect(controller.state.partialTranscript).toBe("新会话");
  });

  it("decomposes document and cross-block selections into real content speech chunks before playback", async () => {
    const value = snapshot();
    value.selection = {
      revision: value.revision,
      from: value.paragraphs[0].from + 2,
      to: value.paragraphs[1].to - 2,
      text: "用户信任。\n\n第二段说明产品价",
      paragraphIndexes: [0, 1],
      block: false,
    };
    const { controller, editor, synthesizer } = createController({
      editor: new FakeEditor(value),
    });

    const reading = controller.read({ kind: "selection" });
    await Promise.resolve();

    expect(synthesizer.calls).toHaveLength(1);
    expect(synthesizer.calls[0].chunks.map((chunk) => chunk.range)).toEqual([
      {
        revision: 1,
        from: value.paragraphs[0].from + 2,
        to: value.paragraphs[0].to,
        text: "段谈用户信任。",
        paragraphIndexes: [0],
        block: false,
      },
      {
        revision: 1,
        from: value.paragraphs[1].from,
        to: value.paragraphs[1].to - 2,
        text: "第二段说明产品价",
        paragraphIndexes: [1],
        block: false,
      },
    ]);
    expect(editor.highlights).toEqual([]);

    synthesizer.startChunk();
    expect(editor.highlights).toEqual([
      {
        channel: "playback",
        range: synthesizer.calls[0].chunks[0].range,
      },
    ]);
    synthesizer.finish();
    await reading;

    expect(controller.state).toMatchObject({
      phase: "idle",
      playback: { active: false, paragraphIndex: null },
    });
    expect(editor.highlights.at(-1)).toEqual({
      channel: "playback",
      range: null,
    });
  });

  it("uses the last started paragraph as the anchor for next and previous reads", async () => {
    const { controller, synthesizer } = createController();

    const first = controller.read({ kind: "current" });
    await Promise.resolve();
    synthesizer.startChunk();
    synthesizer.finish();
    await first;

    const next = controller.read({ kind: "next" });
    await Promise.resolve();
    expect(synthesizer.calls[1].chunks.map((chunk) => chunk.text)).toEqual([
      "第二段说明产品价值。",
    ]);
    synthesizer.startChunk();
    synthesizer.finish();
    await next;

    const previous = controller.read({ kind: "previous" });
    await Promise.resolve();
    expect(synthesizer.calls[2].chunks.map((chunk) => chunk.text)).toEqual([
      "第一段谈用户信任。",
    ]);
    synthesizer.finish();
    await previous;
  });

  it("returns to an existing preview after player navigation instead of hiding its staged confirmation", async () => {
    const { controller, synthesizer } = createController();
    await controller.submitTranscript("改写当前段");
    const preview = controller.state.preview;
    if (!preview) throw new Error("Expected preview");

    const reading = controller.read({ kind: "next" });
    await Promise.resolve();
    synthesizer.finish();
    await reading;

    expect(controller.state).toMatchObject({
      phase: "preview",
      preview: { id: preview.id },
    });
  });

  it("reads a whole document as paragraph content ranges rather than block node ranges", async () => {
    const { controller, synthesizer } = createController();
    const reading = controller.read({ kind: "document" });
    await Promise.resolve();

    expect(synthesizer.calls[0].chunks.map((chunk) => chunk.range)).toEqual([
      expect.objectContaining({
        from: 1,
        to: 10,
        text: "第一段谈用户信任。",
        paragraphIndexes: [0],
        block: false,
      }),
      expect.objectContaining({
        from: 101,
        to: 111,
        text: "第二段说明产品价值。",
        paragraphIndexes: [1],
        block: false,
      }),
      expect.objectContaining({
        from: 201,
        to: 207,
        text: "第三段收束。",
        paragraphIndexes: [2],
        block: false,
      }),
    ]);
    synthesizer.finish();
    await reading;
  });

  it("pauses, resumes, clamps rate, and ignores an old speech callback after stop", async () => {
    const { controller, editor, synthesizer } = createController();
    const reading = controller.read({ kind: "current" });
    await Promise.resolve();
    const staleOptions = synthesizer.calls[0].options;
    const staleChunk = synthesizer.calls[0].chunks[0];

    controller.pause();
    controller.resume();
    controller.setRate(99);
    expect(synthesizer.pauses).toBe(1);
    expect(synthesizer.resumes).toBe(1);
    expect(controller.state.playback.rate).toBe(2);

    controller.stop();
    staleOptions.onChunkStart(staleChunk);
    await reading;

    expect(controller.state.phase).toBe("idle");
    expect(
      editor.highlights.filter((item) => item.range === staleChunk.range),
    ).toEqual([]);
    controller.setRate(-1);
    expect(controller.state.playback.rate).toBe(0.5);
  });

  it("settles standalone playback controls instead of leaving the controller understanding", async () => {
    const { controller, preferences } = createController();

    await controller.submitTranscript("暂停");
    expect(controller.state).toMatchObject({ phase: "idle", errorCode: null });

    await controller.submitTranscript("快一点");
    expect(controller.state).toMatchObject({ phase: "idle", errorCode: null });
    expect(preferences.value.rate).toBe(1.1);
  });

  it("executes a unique locate → read → rewrite plan in order without mutating before preview", async () => {
    const value = snapshot();
    const locating = createDeferred<LocateCandidate[]>();
    const { controller, editor, locate, rewrite, synthesizer } =
      createController({
        editor: new FakeEditor(value),
        locate: async () => locating.promise,
      });

    const submitted = controller.submitTranscript(
      "找到讲用户信任的那段，读一下，再改得更直接",
    );
    await Promise.resolve();
    expect(locate).toHaveBeenCalledTimes(1);
    expect(rewrite).not.toHaveBeenCalled();
    expect(synthesizer.calls).toEqual([]);

    locating.resolve([
      {
        range: paragraphRange(value, 0),
        score: 1,
        reason: "精确匹配",
      },
    ]);
    await drainMicrotasks();
    expect(synthesizer.calls[0].chunks.map((chunk) => chunk.text)).toEqual([
      "第一段谈用户信任。",
    ]);
    expect(rewrite).not.toHaveBeenCalled();

    synthesizer.startChunk();
    synthesizer.finish();
    await drainMicrotasks();
    await submitted;

    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(rewrite.mock.calls[0][0]).toMatchObject({
      range: paragraphRange(value, 0),
      constraints: ["改得更直接"],
    });
    expect(editor.applied).toEqual([]);
    expect(editor.staged).toHaveLength(1);
    expect(controller.state).toMatchObject({
      phase: "preview",
      preview: {
        originalText: "第一段谈用户信任。",
        replacementText: "改写后的文本。",
        mode: "rewrite",
      },
    });
  });

  it("pauses a close locate result for clarification and resumes only from a valid candidate", async () => {
    const value = snapshot();
    const { controller, locate, synthesizer } = createController({
      locate: async () => [
        { range: paragraphRange(value, 0), score: 0.81, reason: "候选一" },
        { range: paragraphRange(value, 1), score: 0.75, reason: "候选二" },
      ],
    });

    void controller.submitTranscript("找到讲用户信任的那段，读一下");
    await drainMicrotasks();

    expect(locate).toHaveBeenCalledTimes(1);
    expect(controller.state).toMatchObject({
      phase: "clarifying",
      candidates: [{ reason: "候选一" }, { reason: "候选二" }],
    });
    expect(synthesizer.calls).toEqual([]);

    await controller.chooseCandidate(99);
    expect(controller.state).toMatchObject({
      phase: "error",
      errorCode: "stale-candidate",
    });
    expect(synthesizer.calls).toEqual([]);
  });

  it("requires clarification for multiple semantic candidates even when one score is much higher", async () => {
    const { controller, synthesizer, rewrite } = createController({
      locate: async (_query, value) => [
        { range: paragraphRange(value, 0), score: 0.99, reason: "高分" },
        { range: paragraphRange(value, 1), score: 0.01, reason: "仍需确认" },
      ],
    });

    await controller.submitTranscript(
      "找到讲用户信任的那段，读一下，再改得更直接",
    );

    expect(controller.state).toMatchObject({
      phase: "clarifying",
      candidates: [{ score: 0.99 }, { score: 0.01 }],
    });
    expect(synthesizer.calls).toHaveLength(0);
    expect(rewrite).not.toHaveBeenCalled();
  });

  it("continues a paused compound plan after a fresh candidate selection", async () => {
    const value = snapshot();
    const { controller, synthesizer } = createController({
      locate: async () => [
        { range: paragraphRange(value, 0), score: 0.8, reason: "候选一" },
        { range: paragraphRange(value, 1), score: 0.76, reason: "候选二" },
      ],
    });

    await controller.submitTranscript("找到讲用户信任的那段，读一下");
    const resume = controller.chooseCandidate(1);
    await Promise.resolve();

    expect(synthesizer.calls[0].chunks.map((chunk) => chunk.text)).toEqual([
      "第二段说明产品价值。",
    ]);
    synthesizer.finish();
    await resume;
    expect(controller.state.phase).toBe("idle");
  });

  it("returns to idle after an unambiguous locate-only command while retaining no pending action", async () => {
    const value = snapshot();
    const { controller } = createController({
      locate: async () => [
        { range: paragraphRange(value, 0), score: 1, reason: "唯一候选" },
      ],
    });

    await controller.submitTranscript("找到讲用户信任的那段");

    expect(controller.state).toMatchObject({
      phase: "idle",
      candidates: [],
      preview: null,
      errorCode: null,
    });
  });

  it("stages a rewrite preview without document mutation, then confirms exactly its bridge-stored id", async () => {
    const { controller, editor } = createController();

    await controller.submitTranscript("改写当前段");
    const preview = controller.state.preview;
    if (!preview) throw new Error("Expected a rewrite preview");

    expect(editor.staged.get(preview.id)).toEqual(preview);
    expect(editor.applied).toEqual([]);

    controller.confirmPreview();

    expect(editor.applied).toEqual([preview.id]);
    expect(editor.discarded).toEqual([]);
    expect(controller.state).toMatchObject({
      phase: "applied",
      preview: null,
      errorCode: null,
    });
  });

  it("discards rejected previews and immediately invalidates a preview after an external revision", async () => {
    const rejected = createController();
    await rejected.controller.submitTranscript("改写当前段");
    const rejectedPreview = rejected.controller.state.preview;
    if (!rejectedPreview) throw new Error("Expected a rejected preview");

    rejected.controller.rejectPreview();
    expect(rejected.editor.discarded).toEqual([rejectedPreview.id]);
    expect(rejected.editor.applied).toEqual([]);
    expect(rejected.controller.state).toMatchObject({
      phase: "idle",
      preview: null,
    });

    const stale = createController();
    await stale.controller.submitTranscript("改写当前段");
    const stalePreview = stale.controller.state.preview;
    if (!stalePreview) throw new Error("Expected a stale preview");
    stale.editor.emitRevision(stalePreview.revision + 1);

    expect(stale.editor.discarded).toEqual([stalePreview.id]);
    expect(stale.editor.applied).toEqual([]);
    expect(stale.controller.state).toMatchObject({
      phase: "error",
      errorCode: "stale-preview",
      preview: null,
    });
  });

  it("shows and confirms an inverse undo preview without applying a replacement", () => {
    const editor = new FakeEditor();
    const range = paragraphRange(editor.value, 0);
    editor.undoPreview = {
      id: "undo-preview",
      revision: editor.value.revision,
      range,
      originalText: "改写后的文本。",
      replacementText: range.text,
      segments: [
        { kind: "delete", text: "改写后的文本。" },
        { kind: "insert", text: range.text },
      ],
      mode: "undo",
    };
    const { controller } = createController({ editor });

    controller.requestUndo();
    expect(controller.state).toMatchObject({
      phase: "preview",
      preview: { id: "undo-preview", mode: "undo" },
    });
    expect(editor.applied).toEqual([]);

    controller.confirmUndo();
    expect(editor.undone).toEqual(["undo-preview"]);
    expect(editor.applied).toEqual([]);
    expect(editor.discarded).toEqual([]);
    expect(controller.state).toMatchObject({
      phase: "applied",
      preview: null,
      errorCode: null,
    });
  });

  it("speaks preview original from document coordinates but never highlights a temporary replacement range", async () => {
    const { controller, editor, synthesizer } = createController();
    await controller.submitTranscript("改写当前段");
    const preview = controller.state.preview;
    if (!preview) throw new Error("Expected preview");

    const original = controller.speakOriginal();
    await Promise.resolve();
    expect(synthesizer.calls[0].chunks[0].range).toMatchObject({
      from: editor.value.paragraphs[0].from,
      to: editor.value.paragraphs[0].to,
      block: false,
    });
    synthesizer.startChunk();
    synthesizer.finish();
    await original;

    const highlightsBeforeReplacement = editor.highlights.length;
    const replacement = controller.speakReplacement();
    await Promise.resolve();
    expect(synthesizer.calls[1].chunks[0].range).toEqual({
      revision: editor.value.revision,
      from: 0,
      to: preview.replacementText.length,
      text: preview.replacementText,
      paragraphIndexes: [],
      block: false,
    });
    synthesizer.startChunk();
    expect(editor.highlights.slice(highlightsBeforeReplacement)).toEqual([
      { channel: "playback", range: null },
    ]);
    synthesizer.finish();
    await replacement;
  });

  it("clears a live original playback highlight before speaking an unhighlighted replacement", async () => {
    const { controller, editor, synthesizer } = createController();
    await controller.submitTranscript("改写当前段");

    const original = controller.speakOriginal();
    await Promise.resolve();
    synthesizer.startChunk();
    expect(editor.highlights.at(-1)).toMatchObject({
      channel: "playback",
      range: expect.any(Object),
    });

    const replacement = controller.speakReplacement();
    await Promise.resolve();
    expect(editor.highlights.at(-1)).toEqual({
      channel: "playback",
      range: null,
    });
    synthesizer.startChunk();
    expect(editor.highlights.at(-1)).toEqual({
      channel: "playback",
      range: null,
    });

    synthesizer.finish();
    await Promise.all([original, replacement]);
  });

  it("maps recognition capability and service errors without staging or applying text", () => {
    const unsupportedRecognizer = new FakeRecognizer();
    unsupportedRecognizer.supported = false;
    const unsupported = createController({ recognizer: unsupportedRecognizer });
    unsupported.controller.startListening();
    expect(unsupported.controller.state).toMatchObject({
      phase: "error",
      errorCode: "speech-unsupported",
    });
    expect(unsupported.editor.staged).toHaveLength(0);
    expect(unsupported.editor.applied).toEqual([]);

    for (const code of [
      "no-speech",
      "permission-denied",
      "network",
      "language-not-supported",
    ] as const) {
      const current = createController();
      current.controller.startListening();
      current.recognizer.latest().onError(code);
      expect(current.controller.state).toMatchObject({
        phase: "error",
        errorCode: code,
      });
      expect(current.editor.staged).toHaveLength(0);
      expect(current.editor.applied).toEqual([]);
    }

    const cancelled = createController();
    cancelled.controller.startListening();
    cancelled.recognizer.latest().onError("aborted");
    expect(cancelled.controller.state).toMatchObject({
      phase: "idle",
      errorCode: null,
    });
  });

  it("cancels locator and rewrite requests, clears the compound queue, and ignores late results", async () => {
    const locating = createDeferred<LocateCandidate[]>();
    let locateSignal: AbortSignal | undefined;
    const located = createController({
      locate: async (_query, _snapshot, signal) => {
        locateSignal = signal;
        return locating.promise;
      },
    });

    const locatingCommand = located.controller.submitTranscript(
      "找到讲用户信任的那段，读一下，再改得更直接",
    );
    await Promise.resolve();
    located.controller.cancel();
    expect(locateSignal?.aborted).toBe(true);
    expect(located.recognizer.cancels).toBeGreaterThan(0);
    expect(located.synthesizer.cancels).toBeGreaterThan(0);
    expect(located.controller.state).toMatchObject({
      phase: "idle",
      preview: null,
    });
    locating.resolve([
      {
        range: paragraphRange(located.editor.value, 0),
        score: 1,
        reason: "旧结果",
      },
    ]);
    await locatingCommand;
    expect(located.synthesizer.calls).toEqual([]);
    expect(located.rewrite).not.toHaveBeenCalled();
    expect(located.editor.applied).toEqual([]);

    const rewriting = createDeferred<string>();
    let rewriteSignal: AbortSignal | undefined;
    const rewritten = createController({
      rewrite: async (input) => {
        rewriteSignal = input.signal;
        return rewriting.promise;
      },
    });
    const rewriteCommand = rewritten.controller.submitTranscript("改写当前段");
    await Promise.resolve();
    rewritten.controller.cancel();
    expect(rewriteSignal?.aborted).toBe(true);
    rewriting.resolve("迟到的改写");
    await rewriteCommand;
    expect(rewritten.editor.staged).toHaveLength(0);
    expect(rewritten.editor.applied).toEqual([]);
  });

  it("marks model results stale when the document changes before a rewrite returns", async () => {
    const deferred = createDeferred<string>();
    const { controller, editor } = createController({
      rewrite: async () => deferred.promise,
    });

    const rewrite = controller.submitTranscript("改写当前段");
    await Promise.resolve();
    editor.emitRevision(editor.value.revision + 1);
    deferred.resolve("不能应用的改写");
    await rewrite;

    expect(controller.state).toMatchObject({
      phase: "error",
      errorCode: "stale-preview",
      preview: null,
    });
    expect(editor.staged).toHaveLength(0);
    expect(editor.applied).toEqual([]);
  });

  it("aborts a timed out model request and leaves both staging and document writes at zero", async () => {
    const deferred = createDeferred<string>();
    const timers: Array<() => void> = [];
    let signal: AbortSignal | undefined;
    const { controller, editor } = createController({
      requestTimeoutMs: 25,
      scheduler: {
        setTimeout(callback) {
          timers.push(callback);
          return callback;
        },
        clearTimeout() {},
      },
      rewrite: async (input) => {
        signal = input.signal;
        return deferred.promise;
      },
    });

    const rewriting = controller.submitTranscript("改写当前段");
    await Promise.resolve();
    expect(timers).toHaveLength(1);
    timers[0]();
    await drainMicrotasks();

    expect(signal?.aborted).toBe(true);
    expect(controller.state).toMatchObject({
      phase: "error",
      errorCode: "timeout",
      preview: null,
    });
    expect(editor.staged).toHaveLength(0);
    expect(editor.applied).toEqual([]);
    deferred.resolve("太晚了");
    await rewriting;
  });

  it("does not let an intervening bridge failure issue a second write", async () => {
    const editor = new FakeEditor();
    editor.applyResult = fail("intervening-edit");
    const { controller } = createController({ editor });
    await controller.submitTranscript("改写当前段");
    const preview = controller.state.preview;
    if (!preview) throw new Error("Expected preview");

    controller.confirmPreview();
    controller.confirmPreview();

    expect(editor.applied).toEqual([preview.id]);
    expect(controller.state).toMatchObject({
      phase: "error",
      errorCode: "stale-preview",
      preview: null,
    });
  });

  it("discards an existing staged preview before a new transcript begins", async () => {
    const { controller, editor, synthesizer } = createController();
    await controller.submitTranscript("改写当前段");
    const preview = controller.state.preview;
    if (!preview) throw new Error("Expected preview");

    const next = controller.submitTranscript("读当前段");
    await Promise.resolve();

    expect(editor.discarded).toEqual([preview.id]);
    expect(controller.state.preview).toBeNull();
    expect(editor.highlights).toContainEqual({
      channel: "target",
      range: null,
    });
    synthesizer.finish();
    await next;
  });

  it("cancels prior speech when a new direct read starts and stops a compound queue before rewrite", async () => {
    const direct = createController();
    void direct.controller.read({ kind: "current" });
    await Promise.resolve();
    const oldOptions = direct.synthesizer.calls[0].options;
    const oldChunk = direct.synthesizer.calls[0].chunks[0];
    void direct.controller.read({ kind: "next" });
    await Promise.resolve();
    expect(direct.synthesizer.cancels).toBeGreaterThan(0);
    oldOptions.onChunkStart(oldChunk);
    expect(
      direct.editor.highlights.some(
        (highlight) =>
          highlight.channel === "playback" &&
          highlight.range?.text === oldChunk.text,
      ),
    ).toBe(false);

    const compound = createController({
      locate: async (_query, value) => [
        { range: paragraphRange(value, 0), score: 1, reason: "唯一候选" },
      ],
    });
    const command = compound.controller.submitTranscript(
      "找到讲用户信任的那段，读一下，再改得更直接",
    );
    await drainMicrotasks();
    expect(compound.synthesizer.calls).toHaveLength(1);
    compound.controller.stop();
    await command;
    expect(compound.rewrite).not.toHaveBeenCalled();
    expect(compound.controller.state.phase).toBe("idle");
  });

  it("rejects a same-revision candidate whose content does not match the current document", async () => {
    const value = snapshot();
    const target = value.paragraphs[0];
    const { controller, synthesizer } = createController({
      locate: async () => [
        {
          range: {
            revision: value.revision,
            from: target.from,
            to: target.to,
            text: "伪造段落",
            paragraphIndexes: [target.index],
            block: false,
          },
          score: 1,
          reason: "不可信候选",
        },
      ],
    });

    void controller.submitTranscript("找到讲用户信任的那段，读一下");
    await drainMicrotasks();

    expect(controller.state).toMatchObject({
      phase: "error",
      errorCode: "not-found",
    });
    expect(synthesizer.calls).toEqual([]);
  });

  it("cancels active speech and clears playback state when an external revision arrives", async () => {
    const { controller, editor, synthesizer } = createController();
    void controller.read({ kind: "current" });
    await Promise.resolve();
    synthesizer.startChunk();
    editor.emitRevision(editor.value.revision + 1);

    expect(synthesizer.cancels).toBeGreaterThan(0);
    expect(controller.state).toMatchObject({
      phase: "idle",
      playback: { active: false, paragraphIndex: null },
    });
  });

  it("stops an active recognition session and returns idle when the recognizer ends", () => {
    const { controller, recognizer } = createController();
    controller.startListening();
    recognizer.latest().onStart();

    controller.stopListening();
    expect(recognizer.stops).toBe(1);
    recognizer.latest().onEnd();

    expect(controller.state).toMatchObject({
      phase: "idle",
      partialTranscript: "",
    });
  });

  it("keeps a rewrite preview available when playback is stopped from the preview state", async () => {
    const { controller, synthesizer } = createController();
    await controller.submitTranscript("改写当前段");
    const preview = controller.state.preview;
    if (!preview) throw new Error("Expected preview");

    const speaking = controller.speakOriginal();
    await Promise.resolve();
    controller.stop();
    await speaking;

    expect(synthesizer.cancels).toBeGreaterThan(0);
    expect(controller.state).toMatchObject({
      phase: "preview",
      preview: { id: preview.id },
      playback: { active: false },
    });
  });

  it("invalidates and stops preview playback when the underlying document changes", async () => {
    const { controller, editor, synthesizer } = createController();
    await controller.submitTranscript("改写当前段");
    const preview = controller.state.preview;
    if (!preview) throw new Error("Expected preview");

    const speaking = controller.speakOriginal();
    await Promise.resolve();
    const cancelsBeforeRevision = synthesizer.cancels;
    editor.emitRevision(preview.revision + 1);
    synthesizer.finish();
    await speaking;

    expect(synthesizer.cancels).toBeGreaterThan(cancelsBeforeRevision);
    expect(controller.state).toMatchObject({
      phase: "error",
      errorCode: "stale-preview",
      preview: null,
      playback: { active: false },
    });
  });

  it("destroy aborts pending work, discards staged previews, and ignores late callbacks", async () => {
    const pending = createDeferred<LocateCandidate[]>();
    let signal: AbortSignal | undefined;
    const running = createController({
      locate: async (_query, _snapshot, currentSignal) => {
        signal = currentSignal;
        return pending.promise;
      },
    });
    const events: unknown[] = [];
    running.controller.addEventListener("state-change", (event) =>
      events.push((event as CustomEvent).detail),
    );

    const command =
      running.controller.submitTranscript("找到讲用户信任的那段，读一下");
    await Promise.resolve();
    const eventCountAtDestroy = events.length;
    running.controller.destroy();
    expect(signal?.aborted).toBe(true);
    expect(running.recognizer.cancels).toBeGreaterThan(0);
    expect(running.synthesizer.cancels).toBeGreaterThan(0);

    pending.resolve([
      {
        range: paragraphRange(running.editor.value, 0),
        score: 1,
        reason: "迟到",
      },
    ]);
    await command;
    running.editor.emitRevision(running.editor.value.revision + 1);

    expect(running.synthesizer.calls).toEqual([]);
    expect(running.editor.applied).toEqual([]);
    expect(events).toHaveLength(eventCountAtDestroy + 1);

    const previewOwner = createController();
    await previewOwner.controller.submitTranscript("改写当前段");
    const preview = previewOwner.controller.state.preview;
    if (!preview) throw new Error("Expected preview before destroy");
    previewOwner.controller.destroy();
    expect(previewOwner.editor.discarded).toEqual([preview.id]);
  });
});
