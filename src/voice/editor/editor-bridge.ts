import type { Editor } from "@tiptap/core";
import {
  Fragment,
  Slice,
  type Node as ProseMirrorNode,
  type Schema,
} from "@tiptap/pm/model";
import { closeHistory, undo } from "@tiptap/pm/history";
import type {
  DiffSegment,
  EditorSnapshot,
  ParagraphRef,
  RewritePreview,
  VoiceRange,
} from "../types";
import {
  setVoiceHighlight,
  VOICE_EDIT_META,
  voiceEditorStatePluginKey,
  type VoiceHighlightChannel,
} from "./voice-highlight-extension";
import {
  acceptAgentSuggestion as acceptSuggestion,
  acceptAllAgentSuggestions as acceptAllSuggestions,
  addAgentSuggestions as addSuggestions,
  currentAgentSuggestion as currentSuggestion,
  listAgentSuggestions as listSuggestions,
  nextAgentSuggestion as nextSuggestion,
  previousAgentSuggestion as previousSuggestion,
  rejectAgentSuggestion as rejectSuggestion,
  rejectAllAgentSuggestions as rejectAllSuggestions,
  type AgentSuggestion,
  type AgentSuggestionResult,
} from "../../agent/agent-suggestion-extension";
import { hashOriginalText } from "../../agent/edit-protocol";
import type { AgentEditOperation } from "../../agent/types";

export { VOICE_EDIT_META } from "./voice-highlight-extension";

export type BridgeFailure =
  | "stale-revision"
  | "invalid-range"
  | "pending-legacy-edit"
  | "preview-not-found"
  | "intervening-edit"
  | "nothing-to-undo";

export type BridgeResult<T> =
  { ok: true; value: T } | { ok: false; reason: BridgeFailure };

interface LastVoiceEdit {
  beforeDoc: ProseMirrorNode;
  afterDoc: ProseMirrorNode;
  preview: RewritePreview;
  appliedRange: VoiceRange;
  afterRevision: number;
}

interface StagedPreview {
  source: RewritePreview;
  snapshot: RewritePreview;
  integrity: string;
}

let fallbackOpaqueId = 0;

const success = <T>(value: T): BridgeResult<T> => ({ ok: true, value });

const failure = <T>(reason: BridgeFailure): BridgeResult<T> => ({
  ok: false,
  reason,
});

const cloneRange = (range: VoiceRange): VoiceRange => ({
  ...range,
  paragraphIndexes: [...range.paragraphIndexes],
});

const cloneSegments = (segments: DiffSegment[]): DiffSegment[] =>
  segments.map((segment) => ({ ...segment }));

const clonePreview = (preview: RewritePreview): RewritePreview => ({
  ...preview,
  range: cloneRange(preview.range),
  segments: cloneSegments(preview.segments),
});

const previewIntegrity = (preview: RewritePreview) =>
  JSON.stringify({
    id: preview.id,
    revision: preview.revision,
    range: {
      revision: preview.range.revision,
      from: preview.range.from,
      to: preview.range.to,
      text: preview.range.text,
      paragraphIndexes: preview.range.paragraphIndexes,
      block: preview.range.block,
    },
    originalText: preview.originalText,
    replacementText: preview.replacementText,
    segments: preview.segments,
    mode: preview.mode,
  });

const createOpaqueId = () => {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  fallbackOpaqueId += 1;
  return `voice-preview-${Date.now().toString(36)}-${fallbackOpaqueId.toString(36)}`;
};

const textForRange = (doc: ProseMirrorNode, from: number, to: number) =>
  doc.textBetween(from, to, "\n\n", "\n");

const rangeIsValid = (
  doc: ProseMirrorNode,
  range: Pick<VoiceRange, "from" | "to">,
) =>
  Number.isInteger(range.from) &&
  Number.isInteger(range.to) &&
  range.from >= 0 &&
  range.from <= range.to &&
  range.to <= doc.content.size;

const diffReconstructsPreview = (preview: RewritePreview) => {
  let originalText = "";
  let replacementText = "";

  for (const segment of preview.segments) {
    if (
      (segment.kind !== "equal" &&
        segment.kind !== "insert" &&
        segment.kind !== "delete") ||
      typeof segment.text !== "string"
    ) {
      return false;
    }

    if (segment.kind !== "insert") originalText += segment.text;
    if (segment.kind !== "delete") replacementText += segment.text;
  }

  return (
    originalText === preview.originalText &&
    replacementText === preview.replacementText
  );
};

const overlaps = (
  rangeFrom: number,
  rangeTo: number,
  itemFrom: number,
  itemTo: number,
) => {
  if (rangeFrom === rangeTo) {
    return rangeFrom >= itemFrom && rangeFrom <= itemTo;
  }
  return rangeFrom < itemTo && rangeTo > itemFrom;
};

const hasLegacyConflict = (
  doc: ProseMirrorNode,
  range: Pick<VoiceRange, "from" | "to">,
) => {
  let conflict = false;

  doc.descendants((node, position) => {
    if (conflict) return false;

    const nodeFrom = position;
    const nodeTo = position + node.nodeSize;

    if (
      node.type.name === "collapse" &&
      overlaps(range.from, range.to, nodeFrom, nodeTo)
    ) {
      conflict = true;
      return false;
    }

    if (
      node.isTextblock &&
      Boolean(node.attrs["is-loading"]) &&
      overlaps(range.from, range.to, nodeFrom, nodeTo)
    ) {
      conflict = true;
      return false;
    }

    if (
      node.isText &&
      overlaps(range.from, range.to, nodeFrom, nodeTo) &&
      node.marks.some(
        (mark) =>
          mark.type.name === "edit-highlight" ||
          mark.type.name === "loading-highlight",
      )
    ) {
      conflict = true;
      return false;
    }
  });

  return conflict;
};

const inlineContent = (schema: Schema, text: string) => {
  const hardBreakType = schema.nodes.hardBreak;
  if (!hardBreakType && text.includes("\n")) {
    throw new Error("The editor schema must provide a hardBreak node.");
  }

  const nodes: ProseMirrorNode[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length > 0) nodes.push(schema.text(line));
    if (index < lines.length - 1) nodes.push(hardBreakType.create());
  }
  return Fragment.fromArray(nodes);
};

const plainTextSlice = (schema: Schema, text: string) => {
  if (text === "") return Slice.empty;

  const paragraphType = schema.nodes.paragraph;
  if (!paragraphType) {
    throw new Error("The editor schema must provide a paragraph node.");
  }

  const paragraphs = text
    .split("\n\n")
    .map((paragraph) =>
      paragraphType.create(null, inlineContent(schema, paragraph)),
    );
  return Slice.maxOpen(Fragment.fromArray(paragraphs));
};

const isCrossTextblockRange = (
  doc: ProseMirrorNode,
  range: Pick<VoiceRange, "from" | "to">,
) => {
  const from = doc.resolve(range.from);
  const to = doc.resolve(range.to);
  return !from.sameParent(to) || !from.parent.isTextblock;
};

export class EditorBridge {
  private readonly editor: Editor;
  private readonly stagedPreviews = new Map<string, StagedPreview>();
  private readonly sharedVoicePreviewIds = new Set<string>();
  private readonly revisionListeners = new Set<(revision: number) => void>();
  private lastVoiceEdit: LastVoiceEdit | null = null;
  private undoPreviewId: string | null = null;
  private lastObservedRevision = 0;
  private destroyed = false;
  private readonly transactionListener = () => {
    if (this.destroyed) return;

    const revision = this.getRevision();
    if (revision <= this.lastObservedRevision) return;

    this.lastObservedRevision = revision;
    for (const listener of [...this.revisionListeners]) {
      if (this.destroyed) return;
      if (this.lastObservedRevision !== revision) return;
      if (!this.revisionListeners.has(listener)) continue;
      try {
        listener(revision);
      } catch {
        // Listener failures must not interrupt the editor transaction.
      }
    }
  };

  constructor(editor: Editor) {
    this.editor = editor;
    if (!voiceEditorStatePluginKey.getState(editor.state)) {
      throw new Error(
        "EditorBridge requires VoiceHighlightExtension to be registered.",
      );
    }
    this.lastObservedRevision = this.getRevision();
    this.editor.on("transaction", this.transactionListener);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.editor.off("transaction", this.transactionListener);
    this.stagedPreviews.clear();
    this.sharedVoicePreviewIds.clear();
    this.revisionListeners.clear();
    this.lastVoiceEdit = null;
    this.undoPreviewId = null;
  }

  getRevision() {
    const state = voiceEditorStatePluginKey.getState(this.editor.state);
    if (!state) {
      throw new Error(
        "EditorBridge requires VoiceHighlightExtension to be registered.",
      );
    }
    return state.revision;
  }

  addAgentSuggestions(
    operations: readonly AgentEditOperation[],
    canCommit?: () => boolean,
  ): Promise<AgentSuggestionResult<string[]>> {
    if (this.destroyed) {
      return Promise.resolve({ ok: false, reason: "agent-suggestions-unavailable" });
    }
    return addSuggestions(this.editor, operations, canCommit);
  }

  listAgentSuggestions(): AgentSuggestion[] {
    return this.destroyed ? [] : listSuggestions(this.editor);
  }

  currentAgentSuggestion(): AgentSuggestion | null {
    return this.destroyed ? null : currentSuggestion(this.editor);
  }

  nextAgentSuggestion(): AgentSuggestion | null {
    return this.destroyed ? null : nextSuggestion(this.editor);
  }

  previousAgentSuggestion(): AgentSuggestion | null {
    return this.destroyed ? null : previousSuggestion(this.editor);
  }

  rejectAgentSuggestion(id?: string): AgentSuggestionResult<string> {
    if (this.destroyed) return { ok: false, reason: "agent-suggestions-unavailable" };
    return rejectSuggestion(this.editor, id);
  }

  acceptAgentSuggestion(id?: string): AgentSuggestionResult<string> {
    if (this.destroyed) return { ok: false, reason: "agent-suggestions-unavailable" };
    return acceptSuggestion(this.editor, id);
  }

  rejectAllAgentSuggestions(): AgentSuggestionResult<string[]> {
    if (this.destroyed) return { ok: false, reason: "agent-suggestions-unavailable" };
    return rejectAllSuggestions(this.editor);
  }

  acceptAllAgentSuggestions(): AgentSuggestionResult<string[]> {
    if (this.destroyed) return { ok: false, reason: "agent-suggestions-unavailable" };
    return acceptAllSuggestions(this.editor);
  }

  getSnapshot(lastSpokenParagraphIndex: number | null = null): EditorSnapshot {
    const { doc, selection } = this.editor.state;
    const paragraphs: ParagraphRef[] = [];

    doc.descendants((node, position) => {
      if (!node.isTextblock) return;

      const nodeFrom = position;
      const nodeTo = position + node.nodeSize;
      const from = nodeFrom + 1;
      const to = nodeTo - 1;
      const index = paragraphs.length;
      const previous = paragraphs[index - 1];
      paragraphs.push({
        id: `${node.type.name}-${nodeFrom}-${nodeTo}`,
        index,
        nodeType: node.type.name,
        nodeFrom,
        nodeTo,
        from,
        to,
        text: textForRange(doc, from, to),
        separatorBefore: previous ? textForRange(doc, previous.to, from) : "",
      });
    });

    const indexesForSelection = this.paragraphIndexesForRange(
      paragraphs,
      selection.from,
      selection.to,
    );
    const currentParagraphIndex =
      paragraphs.find(
        (paragraph) =>
          selection.from >= paragraph.from && selection.from <= paragraph.to,
      )?.index ??
      paragraphs.find(
        (paragraph) =>
          selection.from >= paragraph.nodeFrom &&
          selection.from <= paragraph.nodeTo,
      )?.index ??
      -1;

    const selectedRange: VoiceRange | null = selection.empty
      ? null
      : {
          revision: this.getRevision(),
          from: selection.from,
          to: selection.to,
          text: textForRange(doc, selection.from, selection.to),
          paragraphIndexes: indexesForSelection,
          block: indexesForSelection.length > 1,
        };

    return {
      revision: this.getRevision(),
      paragraphs,
      selection: selectedRange,
      currentParagraphIndex,
      lastSpokenParagraphIndex,
    };
  }

  highlight(
    channel: VoiceHighlightChannel,
    range: VoiceRange | null,
  ): BridgeResult<void> {
    if (this.destroyed) return failure("invalid-range");

    if (range === null) {
      setVoiceHighlight(this.editor, channel, null);
      return success(undefined);
    }

    if (range.revision !== this.getRevision()) {
      return failure("stale-revision");
    }
    if (!this.rangeMatchesDocument(range)) {
      return failure("invalid-range");
    }

    setVoiceHighlight(this.editor, channel, range);
    return success(undefined);
  }

  stagePreview(preview: RewritePreview): BridgeResult<void> {
    if (this.destroyed) return failure("invalid-range");
    if (preview.mode !== "rewrite") return failure("invalid-range");
    return this.storePreview(preview);
  }

  /**
   * Adapts a voice rewrite preview to the shared review facade. Editors that
   * predate AgentSuggestionExtension keep the existing staged-preview path.
   */
  async stageVoiceRewriteSuggestion(
    preview: RewritePreview,
  ): Promise<BridgeResult<void>> {
    const staged = this.stagePreview(preview);
    if (!staged.ok) return staged;

    const hash = await hashOriginalText(preview.originalText);
    if (!hash.ok) return staged;

    const operation: AgentEditOperation = {
      id: preview.id,
      type: "replaceRange",
      revision: preview.revision,
      from: preview.range.from,
      to: preview.range.to,
      originalTextHash: hash.hash,
      replacement: preview.replacementText,
      reason: "voice-rewrite",
    };
    const added = await this.addAgentSuggestions(
      [operation],
      () => !this.destroyed && this.stagedPreviews.has(preview.id),
    );
    if (added.ok) {
      this.sharedVoicePreviewIds.add(preview.id);
      return staged;
    }
    if (added.reason === "agent-suggestions-unavailable") return staged;

    this.stagedPreviews.delete(preview.id);
    return failure(
      added.reason === "stale-revision" ? "stale-revision" : "invalid-range",
    );
  }

  discardPreview(previewId: string): BridgeResult<void> {
    if (this.destroyed) return failure("preview-not-found");
    if (!this.stagedPreviews.delete(previewId)) {
      return failure("preview-not-found");
    }
    if (this.sharedVoicePreviewIds.delete(previewId)) {
      this.rejectAgentSuggestion(previewId);
    }
    if (this.undoPreviewId === previewId) {
      this.undoPreviewId = null;
    }
    return success(undefined);
  }

  onRevisionChange(listener: (revision: number) => void): () => void {
    if (this.destroyed) return () => {};

    const subscription = (revision: number) => listener(revision);
    this.revisionListeners.add(subscription);
    return () => {
      this.revisionListeners.delete(subscription);
    };
  }

  private storePreview(preview: RewritePreview): BridgeResult<void> {
    if (
      preview.revision !== this.getRevision() ||
      preview.range.revision !== preview.revision
    ) {
      return failure("stale-revision");
    }

    if (
      preview.id.length === 0 ||
      this.stagedPreviews.has(preview.id) ||
      preview.originalText !== preview.range.text ||
      preview.originalText === preview.replacementText ||
      !this.rangeMatchesDocument(preview.range) ||
      !diffReconstructsPreview(preview)
    ) {
      return failure("invalid-range");
    }

    if (hasLegacyConflict(this.editor.state.doc, preview.range)) {
      return failure("pending-legacy-edit");
    }

    const snapshot = clonePreview(preview);
    this.stagedPreviews.set(preview.id, {
      source: preview,
      snapshot,
      integrity: previewIntegrity(snapshot),
    });
    return success(undefined);
  }

  applyReplacement(
    previewId: string,
  ): BridgeResult<{ beforeRevision: number; afterRevision: number }> {
    if (this.destroyed) return failure("preview-not-found");

    const staged = this.stagedPreviews.get(previewId);
    if (!staged) return failure("preview-not-found");
    if (staged.snapshot.mode !== "rewrite") {
      return failure("invalid-range");
    }
    this.stagedPreviews.delete(previewId);
    const useSharedSuggestion = this.sharedVoicePreviewIds.delete(previewId);
    if (previewIntegrity(staged.source) !== staged.integrity) {
      if (useSharedSuggestion) this.rejectAgentSuggestion(previewId);
      return failure("invalid-range");
    }
    const preview = staged.snapshot;

    const beforeRevision = this.getRevision();
    if (
      preview.revision !== beforeRevision ||
      preview.range.revision !== beforeRevision
    ) {
      return failure("stale-revision");
    }
    if (!this.previewMatchesDocument(preview)) {
      return failure("invalid-range");
    }
    if (hasLegacyConflict(this.editor.state.doc, preview.range)) {
      return failure("pending-legacy-edit");
    }

    const beforeDoc = this.editor.state.doc;
    const transaction = closeHistory(this.editor.state.tr);

    if (
      !isCrossTextblockRange(beforeDoc, preview.range) &&
      !preview.replacementText.includes("\n")
    ) {
      transaction.insertText(
        preview.replacementText,
        preview.range.from,
        preview.range.to,
      );
    } else {
      transaction.replaceRange(
        preview.range.from,
        preview.range.to,
        plainTextSlice(this.editor.state.schema, preview.replacementText),
      );
    }

    const appliedFrom = transaction.mapping.map(preview.range.from, -1);
    const appliedTo = transaction.mapping.map(preview.range.to, 1);
    if (useSharedSuggestion) {
      const accepted = this.acceptAgentSuggestion(preview.id);
      if (!accepted.ok) {
        return failure(
          accepted.reason === "stale-revision"
            ? "stale-revision"
            : accepted.reason === "suggestion-not-found"
              ? "preview-not-found"
              : "invalid-range",
        );
      }
    } else {
      transaction.setMeta(VOICE_EDIT_META, true);
      this.editor.view.dispatch(transaction);
    }

    const afterRevision = this.getRevision();
    if (this.destroyed) {
      return success({ beforeRevision, afterRevision });
    }
    const afterDoc = this.editor.state.doc;
    const paragraphs = this.getSnapshot().paragraphs;
    const paragraphIndexes = this.paragraphIndexesForRange(
      paragraphs,
      appliedFrom,
      appliedTo,
    );
    const appliedText = textForRange(afterDoc, appliedFrom, appliedTo);
    const appliedRange: VoiceRange = {
      revision: afterRevision,
      from: appliedFrom,
      to: appliedTo,
      text: appliedText,
      paragraphIndexes,
      block: paragraphIndexes.length > 1,
    };

    this.lastVoiceEdit = {
      beforeDoc,
      afterDoc,
      preview,
      appliedRange,
      afterRevision,
    };
    this.undoPreviewId = null;

    return success({ beforeRevision, afterRevision });
  }

  previewUndoLastVoiceEdit(): BridgeResult<RewritePreview> {
    if (this.destroyed) return failure("nothing-to-undo");

    const edit = this.lastVoiceEdit;
    if (!edit) return failure("nothing-to-undo");
    if (
      this.getRevision() !== edit.afterRevision ||
      !this.editor.state.doc.eq(edit.afterDoc)
    ) {
      return failure("intervening-edit");
    }

    if (this.undoPreviewId) {
      this.stagedPreviews.delete(this.undoPreviewId);
    }

    const inverse: RewritePreview = {
      id: createOpaqueId(),
      revision: edit.afterRevision,
      range: cloneRange(edit.appliedRange),
      originalText: edit.appliedRange.text,
      replacementText: edit.preview.originalText,
      segments: edit.preview.segments.map((segment) => ({
        ...segment,
        kind:
          segment.kind === "insert"
            ? "delete"
            : segment.kind === "delete"
              ? "insert"
              : "equal",
      })),
      mode: "undo",
    };
    const staged = this.storePreview(inverse);
    if (!staged.ok) return staged;

    this.undoPreviewId = inverse.id;
    return success(inverse);
  }

  undoLastVoiceEdit(
    previewId: string,
  ): BridgeResult<{ beforeRevision: number; afterRevision: number }> {
    if (this.destroyed) return failure("preview-not-found");

    const staged = this.stagedPreviews.get(previewId);
    if (!staged) return failure("preview-not-found");
    if (
      staged.snapshot.mode !== "undo" ||
      staged.snapshot.id !== this.undoPreviewId
    ) {
      return failure("invalid-range");
    }
    this.stagedPreviews.delete(previewId);
    this.undoPreviewId = null;
    if (previewIntegrity(staged.source) !== staged.integrity) {
      return failure("invalid-range");
    }
    const preview = staged.snapshot;

    const edit = this.lastVoiceEdit;
    if (!edit) return failure("nothing-to-undo");
    if (
      this.getRevision() !== edit.afterRevision ||
      preview.revision !== edit.afterRevision ||
      !this.editor.state.doc.eq(edit.afterDoc)
    ) {
      return failure("intervening-edit");
    }

    const beforeRevision = this.getRevision();
    const didUndo = undo(this.editor.state, (transaction) => {
      this.editor.view.dispatch(transaction);
    });
    if (!didUndo || !this.editor.state.doc.eq(edit.beforeDoc)) {
      throw new Error("Voice edit history isolation invariant failed.");
    }

    const afterRevision = this.getRevision();
    this.lastVoiceEdit = null;
    return success({ beforeRevision, afterRevision });
  }

  private rangeMatchesDocument(range: VoiceRange) {
    const doc = this.editor.state.doc;
    return (
      rangeIsValid(doc, range) &&
      textForRange(doc, range.from, range.to) === range.text
    );
  }

  private previewMatchesDocument(preview: RewritePreview) {
    return (
      preview.originalText === preview.range.text &&
      this.rangeMatchesDocument(preview.range) &&
      diffReconstructsPreview(preview)
    );
  }

  private paragraphIndexesForRange(
    paragraphs: ParagraphRef[],
    from: number,
    to: number,
  ) {
    return paragraphs
      .filter((paragraph) => {
        if (from === to) {
          return from >= paragraph.from && from <= paragraph.to;
        }
        return from < paragraph.nodeTo && to > paragraph.nodeFrom;
      })
      .map((paragraph) => paragraph.index);
  }
}
