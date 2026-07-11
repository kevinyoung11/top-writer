// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import Paragraph from "@tiptap/extension-paragraph";
import { redo, redoDepth, undo, undoDepth } from "@tiptap/pm/history";
import { Plugin, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Collapse } from "../../components/text-editor/collapse-node";
import { EditHighlight } from "../../components/text-editor/edit-highlight";
import { LoadingHighlight } from "../../components/text-editor/loading-highlight";
import type { RewritePreview, VoiceRange } from "../types";
import { EditorBridge, type BridgeResult } from "./editor-bridge";
import { VoiceHighlightExtension } from "./voice-highlight-extension";

const DEFAULT_CONTENT =
  "<p>第一段内容。</p><p>第二段谈用户信任。</p><p>第三段内容。</p>";

const editors: Editor[] = [];

class InertWorker extends EventTarget {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  postMessage() {}
  terminate() {}
}

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  clear() {
    this.values.clear();
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

type TestTextEditor = HTMLElement & {
  floatingMenuBox: Promise<HTMLElement>;
  popperSidebarBox: Promise<HTMLElement>;
  updateSidebarMenu: () => Promise<void>;
  textGenLocalWorker: Worker;
  updateComplete: Promise<boolean>;
  editor: Editor | null;
  initEditor(): void;
  getVoiceEditorBridge(): EditorBridge | null;
};

const createTextEditorElement = async () => {
  const textEditorModule = await vi.importActual<Record<string, unknown>>(
    "../../components/text-editor/text-editor",
  );
  const TextEditorConstructor =
    textEditorModule.WordflowTextEditor as CustomElementConstructor;
  const memoryStorage = new MemoryStorage();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: memoryStorage,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: memoryStorage,
  });

  const textEditor = document.createElement(
    "wordflow-text-editor",
  ) as TestTextEditor;
  textEditor.floatingMenuBox = Promise.resolve(document.createElement("div"));
  textEditor.popperSidebarBox = Promise.resolve(document.createElement("div"));
  textEditor.updateSidebarMenu = async () => {};
  textEditor.textGenLocalWorker = new InertWorker() as unknown as Worker;
  return { textEditor, TextEditorConstructor };
};

const LegacyParagraph = Paragraph.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      "is-loading": {
        default: null,
      },
    };
  },
});

const createEditor = (
  content: string = DEFAULT_CONTENT,
  withLegacyExtensions = false,
) => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: withLegacyExtensions
      ? [
          StarterKit.configure({ paragraph: false }),
          LegacyParagraph,
          EditHighlight,
          LoadingHighlight,
          Collapse,
          VoiceHighlightExtension,
        ]
      : [StarterKit, VoiceHighlightExtension],
    content,
  });

  document.body.append(editor.view.dom);
  editors.push(editor);
  return editor;
};

const expectOk = <T>(result: BridgeResult<T>) => {
  if (!result.ok) {
    throw new Error(`Expected success, received ${result.reason}`);
  }
  return result.value;
};

const rangeForParagraph = (
  bridge: EditorBridge,
  paragraphIndex: number,
): VoiceRange => {
  const snapshot = bridge.getSnapshot();
  const paragraph = snapshot.paragraphs[paragraphIndex];

  return {
    revision: snapshot.revision,
    from: paragraph.from,
    to: paragraph.to,
    text: paragraph.text,
    paragraphIndexes: [paragraphIndex],
    block: true,
  };
};

const rangeFromPositions = (
  bridge: EditorBridge,
  editor: Editor,
  from: number,
  to: number,
): VoiceRange => {
  const snapshot = bridge.getSnapshot();
  const paragraphIndexes = snapshot.paragraphs
    .filter((paragraph) => from <= paragraph.to && to >= paragraph.from)
    .map((paragraph) => paragraph.index);

  return {
    revision: snapshot.revision,
    from,
    to,
    text: editor.state.doc.textBetween(from, to, "\n\n", "\n"),
    paragraphIndexes,
    block: paragraphIndexes.length > 1,
  };
};

const makePreview = (
  range: VoiceRange,
  replacementText: string,
  id = `preview-${range.revision}-${range.from}-${range.to}`,
  mode: RewritePreview["mode"] = "rewrite",
): RewritePreview => ({
  id,
  revision: range.revision,
  range,
  originalText: range.text,
  replacementText,
  segments: [
    ...(range.text === ""
      ? []
      : ([{ kind: "delete", text: range.text }] as const)),
    ...(replacementText === ""
      ? []
      : ([{ kind: "insert", text: replacementText }] as const)),
  ],
  mode,
});

afterEach(() => {
  while (editors.length > 0) {
    const editor = editors.pop();
    if (editor && !editor.isDestroyed) editor.destroy();
  }
});

describe("EditorBridge", () => {
  it("snapshots paragraphs, selection, cursor paragraph, and revision", () => {
    const editor = createEditor(
      "<h2>标题</h2><ul><li><p>嵌套段落</p><p></p></li></ul><p>结尾<br>换行</p>",
    );
    const bridge = new EditorBridge(editor);
    const initial = bridge.getSnapshot();
    const nestedParagraph = initial.paragraphs[1];

    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(
          editor.state.doc,
          nestedParagraph.from,
          nestedParagraph.from + 2,
        ),
      ),
    );

    const snapshot = bridge.getSnapshot(3);

    expect(snapshot.revision).toBe(0);
    expect(snapshot.paragraphs.map((paragraph) => paragraph.nodeType)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "paragraph",
    ]);
    expect(snapshot.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      "标题",
      "嵌套段落",
      "",
      "结尾\n换行",
    ]);
    for (const paragraph of snapshot.paragraphs) {
      expect(paragraph.nodeFrom).toBeLessThan(paragraph.from);
      expect(paragraph.nodeTo).toBeGreaterThan(paragraph.to);
      expect(
        editor.state.doc.textBetween(
          paragraph.from,
          paragraph.to,
          "\n\n",
          "\n",
        ),
      ).toBe(paragraph.text);
    }
    expect(snapshot.selection).toMatchObject({
      text: "嵌套",
      paragraphIndexes: [1],
      block: false,
    });
    expect(snapshot.currentParagraphIndex).toBe(1);
    expect(snapshot.lastSpokenParagraphIndex).toBe(3);

    bridge.destroy();
  });

  it("increments revision only when the document changes", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const first = bridge.getSnapshot().paragraphs[0];

    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, first.from + 1),
      ),
    );
    expect(bridge.getRevision()).toBe(0);

    expectOk(bridge.highlight("target", rangeForParagraph(bridge, 0)));
    expect(bridge.getRevision()).toBe(0);

    editor.view.dispatch(editor.state.tr.insertText("新", first.from));
    expect(bridge.getRevision()).toBe(1);

    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, first.from + 1),
      ),
    );
    expectOk(bridge.highlight("target", null));
    expect(bridge.getRevision()).toBe(1);

    bridge.destroy();
  });

  it("discards a staged rewrite preview without mutating the editor", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const preview = makePreview(
      rangeForParagraph(bridge, 1),
      "不应写入的预览文本",
      "discard-rewrite",
    );
    const beforeDoc = editor.getJSON();
    const beforeRevision = bridge.getRevision();
    const beforeUndoDepth = undoDepth(editor.state);
    const beforeRedoDepth = redoDepth(editor.state);

    expectOk(bridge.stagePreview(preview));
    expect(bridge.discardPreview(preview.id)).toEqual({
      ok: true,
      value: undefined,
    });

    expect(editor.getJSON()).toEqual(beforeDoc);
    expect(bridge.getRevision()).toBe(beforeRevision);
    expect(undoDepth(editor.state)).toBe(beforeUndoDepth);
    expect(redoDepth(editor.state)).toBe(beforeRedoDepth);
    expect(bridge.applyReplacement(preview.id)).toEqual({
      ok: false,
      reason: "preview-not-found",
    });
    expect(bridge.discardPreview(preview.id)).toEqual({
      ok: false,
      reason: "preview-not-found",
    });

    bridge.destroy();
  });

  it("discards the current undo preview and allows a fresh undo preview", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const rewrite = makePreview(
      rangeForParagraph(bridge, 1),
      "已经应用的改写",
      "discard-undo-rewrite",
    );

    expectOk(bridge.stagePreview(rewrite));
    expectOk(bridge.applyReplacement(rewrite.id));
    const beforeDiscardDoc = editor.getJSON();
    const beforeDiscardRevision = bridge.getRevision();
    const beforeDiscardUndoDepth = undoDepth(editor.state);
    const beforeDiscardRedoDepth = redoDepth(editor.state);
    const discardedUndoPreview = expectOk(bridge.previewUndoLastVoiceEdit());

    expect(bridge.discardPreview(discardedUndoPreview.id)).toEqual({
      ok: true,
      value: undefined,
    });
    expect(editor.getJSON()).toEqual(beforeDiscardDoc);
    expect(bridge.getRevision()).toBe(beforeDiscardRevision);
    expect(undoDepth(editor.state)).toBe(beforeDiscardUndoDepth);
    expect(redoDepth(editor.state)).toBe(beforeDiscardRedoDepth);
    expect(bridge.undoLastVoiceEdit(discardedUndoPreview.id)).toEqual({
      ok: false,
      reason: "preview-not-found",
    });
    expect(editor.getJSON()).toEqual(beforeDiscardDoc);

    const freshUndoPreview = expectOk(bridge.previewUndoLastVoiceEdit());
    expect(freshUndoPreview.id).not.toBe(discardedUndoPreview.id);
    expectOk(bridge.undoLastVoiceEdit(freshUndoPreview.id));
    expect(bridge.getSnapshot().paragraphs[1].text).toBe(rewrite.originalText);

    bridge.destroy();
  });

  it("notifies active revision listeners only for document revisions", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const firstListenerRevisions: number[] = [];
    const secondListenerRevisions: number[] = [];
    const unsubscribeFirst = bridge.onRevisionChange((revision) => {
      firstListenerRevisions.push(revision);
    });
    const unsubscribeSecond = bridge.onRevisionChange((revision) => {
      secondListenerRevisions.push(revision);
    });
    const preview = makePreview(
      rangeForParagraph(bridge, 0),
      "仅用于确认监听范围",
      "listener-preview",
    );

    expectOk(bridge.highlight("target", preview.range));
    editor.view.dispatch(
      editor.state.tr.setMeta("voice-copilot-listener-test", true),
    );
    expectOk(bridge.stagePreview(preview));
    expectOk(bridge.discardPreview(preview.id));
    expect(firstListenerRevisions).toEqual([]);
    expect(secondListenerRevisions).toEqual([]);

    const firstParagraph = bridge.getSnapshot().paragraphs[0];
    editor.view.dispatch(editor.state.tr.insertText("一", firstParagraph.from));
    expect(firstListenerRevisions).toEqual([1]);
    expect(secondListenerRevisions).toEqual([1]);

    unsubscribeFirst();
    const secondParagraph = bridge.getSnapshot().paragraphs[1];
    editor.view.dispatch(
      editor.state.tr.insertText("二", secondParagraph.from),
    );
    expect(firstListenerRevisions).toEqual([1]);
    expect(secondListenerRevisions).toEqual([1, 2]);

    unsubscribeSecond();
    bridge.destroy();
  });

  it("never calls revision listeners after unsubscribe or bridge destruction", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const received: number[] = [];
    const unsubscribe = bridge.onRevisionChange((revision) => {
      received.push(revision);
    });

    unsubscribe();
    editor.view.dispatch(
      editor.state.tr.insertText(
        "已退订",
        bridge.getSnapshot().paragraphs[0].from,
      ),
    );
    expect(received).toEqual([]);

    const unsubscribeAfterDestroy = bridge.onRevisionChange((revision) => {
      received.push(revision);
    });
    bridge.destroy();
    editor.view.dispatch(
      editor.state.tr.insertText(
        "已销毁",
        bridge.getSnapshot().paragraphs[1].from,
      ),
    );
    unsubscribe();
    unsubscribeAfterDestroy();
    expect(received).toEqual([]);
  });

  it("does not call an unsubscribed or destroyed listener during notification", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const calls: string[] = [];
    let unsubscribeSecond = () => {};

    bridge.onRevisionChange(() => {
      calls.push("first");
      unsubscribeSecond();
    });
    unsubscribeSecond = bridge.onRevisionChange(() => {
      calls.push("second");
    });
    bridge.onRevisionChange(() => {
      calls.push("third");
      bridge.destroy();
    });
    bridge.onRevisionChange(() => {
      calls.push("fourth");
    });

    editor.view.dispatch(
      editor.state.tr.insertText(
        "变更",
        bridge.getSnapshot().paragraphs[0].from,
      ),
    );

    expect(calls).toEqual(["first", "third"]);
  });

  it("isolates a throwing revision listener during voice apply and undo", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const originalDocument = editor.getJSON();
    const deliveredRevisions: number[] = [];
    const rewrite = makePreview(
      rangeForParagraph(bridge, 1),
      "即使监听器失败也要安全应用",
      "throwing-listener-rewrite",
    );

    bridge.onRevisionChange(() => {
      throw new Error("listener failure");
    });
    bridge.onRevisionChange((revision) => {
      deliveredRevisions.push(revision);
    });
    expectOk(bridge.stagePreview(rewrite));

    expect(() => expectOk(bridge.applyReplacement(rewrite.id))).not.toThrow();
    expect(bridge.getSnapshot().paragraphs[1].text).toBe(
      rewrite.replacementText,
    );
    expect(bridge.getRevision()).toBe(1);
    expect(deliveredRevisions).toEqual([1]);

    const inverse = expectOk(bridge.previewUndoLastVoiceEdit());
    expect(() => expectOk(bridge.undoLastVoiceEdit(inverse.id))).not.toThrow();
    expect(editor.getJSON()).toEqual(originalDocument);
    expect(bridge.getRevision()).toBe(2);
    expect(deliveredRevisions).toEqual([1, 2]);
    expect(bridge.previewUndoLastVoiceEdit()).toEqual({
      ok: false,
      reason: "nothing-to-undo",
    });

    bridge.destroy();
  });

  it("never delivers an obsolete revision after a nested document change", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const firstListenerRevisions: number[] = [];
    const secondListenerRevisions: number[] = [];

    bridge.onRevisionChange((revision) => {
      firstListenerRevisions.push(revision);
      if (revision === 1) {
        const nestedParagraph = bridge.getSnapshot().paragraphs[1];
        editor.view.dispatch(
          editor.state.tr.insertText("嵌套", nestedParagraph.from),
        );
      }
    });
    bridge.onRevisionChange((revision) => {
      secondListenerRevisions.push(revision);
    });

    const outerParagraph = bridge.getSnapshot().paragraphs[0];
    editor.view.dispatch(
      editor.state.tr.insertText("外层", outerParagraph.from),
    );

    expect(bridge.getRevision()).toBe(2);
    expect(firstListenerRevisions).toEqual([1, 2]);
    expect(secondListenerRevisions).toEqual([2]);

    bridge.destroy();
  });

  it("notifies when an appended transaction changes a metadata-only root transaction", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const deliveredRevisions: number[] = [];
    const rootTransactionChanges: boolean[] = [];
    let hasAppended = false;
    const appendDocumentChangeMeta = "append-document-change";

    editor.registerPlugin(
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          if (
            hasAppended ||
            !transactions.some((transaction) =>
              transaction.getMeta(appendDocumentChangeMeta),
            )
          ) {
            return null;
          }
          hasAppended = true;
          return newState.tr.insertText("附加", 1);
        },
      }),
    );
    editor.on("transaction", ({ transaction }) => {
      rootTransactionChanges.push(transaction.docChanged);
    });
    bridge.onRevisionChange((revision) => {
      deliveredRevisions.push(revision);
    });

    editor.view.dispatch(
      editor.state.tr.setMeta(appendDocumentChangeMeta, true),
    );

    expect(rootTransactionChanges).toEqual([false]);
    expect(editor.getText()).toContain("附加");
    expect(bridge.getRevision()).toBe(1);
    expect(deliveredRevisions).toEqual([1]);

    bridge.destroy();
  });

  it("does not recreate preview state when destroyed during voice apply", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const rewrite = makePreview(
      rangeForParagraph(bridge, 1),
      "销毁中的改写仍可完成",
      "destroy-during-apply",
    );
    let transactionCount = 0;

    editor.on("transaction", () => {
      transactionCount += 1;
    });
    bridge.onRevisionChange(() => {
      bridge.destroy();
    });
    expectOk(bridge.stagePreview(rewrite));

    expect(() => expectOk(bridge.applyReplacement(rewrite.id))).not.toThrow();
    expect(bridge.getRevision()).toBe(1);
    expect(bridge.getSnapshot().paragraphs[1].text).toBe(
      rewrite.replacementText,
    );
    const documentAfterApply = editor.getJSON();
    const transactionsAfterApply = transactionCount;
    const destroyedPreview = makePreview(
      rangeForParagraph(bridge, 0),
      "销毁后不能暂存",
      "destroyed-preview",
    );

    expect(bridge.previewUndoLastVoiceEdit()).toEqual({
      ok: false,
      reason: "nothing-to-undo",
    });
    expect(bridge.undoLastVoiceEdit("destroyed-undo")).toEqual({
      ok: false,
      reason: "preview-not-found",
    });
    expect(bridge.stagePreview(destroyedPreview)).toEqual({
      ok: false,
      reason: "invalid-range",
    });
    expect(bridge.applyReplacement("destroyed-apply")).toEqual({
      ok: false,
      reason: "preview-not-found",
    });
    expect(bridge.discardPreview("destroyed-discard")).toEqual({
      ok: false,
      reason: "preview-not-found",
    });
    expect(bridge.highlight("target", null)).toEqual({
      ok: false,
      reason: "invalid-range",
    });
    expect(editor.getJSON()).toEqual(documentAfterApply);
    expect(transactionCount).toBe(transactionsAfterApply);
  });

  it("highlights a range with decorations without changing revision or history", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const snapshot = bridge.getSnapshot();
    const range = rangeFromPositions(
      bridge,
      editor,
      snapshot.paragraphs[0].from + 1,
      snapshot.paragraphs[1].to - 1,
    );
    const beforeDoc = editor.getJSON();
    const beforeRevision = bridge.getRevision();
    const beforeUndoDepth = undoDepth(editor.state);

    expectOk(bridge.highlight("playback", range));

    expect(editor.getJSON()).toEqual(beforeDoc);
    expect(bridge.getRevision()).toBe(beforeRevision);
    expect(undoDepth(editor.state)).toBe(beforeUndoDepth);
    expect(
      editor.view.dom.querySelectorAll(
        '[data-voice-highlight-channel="playback"]',
      ).length,
    ).toBeGreaterThanOrEqual(2);

    bridge.destroy();
  });

  it("merges channels, decorates full and empty textblocks, and clears on edits", () => {
    const editor = createEditor("<p>整段</p><p></p><p>尾段</p>");
    const bridge = new EditorBridge(editor);
    const snapshot = bridge.getSnapshot();

    expectOk(bridge.highlight("target", rangeForParagraph(bridge, 0)));
    expectOk(bridge.highlight("candidate", rangeForParagraph(bridge, 1)));

    expect(
      editor.view.dom.querySelector('[data-voice-highlight-channel="target"]'),
    ).not.toBeNull();
    expect(
      editor.view.dom.querySelector(
        '[data-voice-highlight-channel="candidate"]',
      ),
    ).not.toBeNull();

    editor.view.dispatch(
      editor.state.tr.insertText("改", snapshot.paragraphs[2].from),
    );

    expect(
      editor.view.dom.querySelector("[data-voice-highlight-channel]"),
    ).toBeNull();

    bridge.destroy();
  });

  it("applies a confirmed single-paragraph replacement in one transaction", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const range = rangeForParagraph(bridge, 1);
    const preview = makePreview(range, "更直接的信任表达。", "single");
    const beforeDoc = editor.getJSON();
    const beforeRevision = bridge.getRevision();
    const beforeUndoDepth = undoDepth(editor.state);
    const documentTransactions: number[] = [];

    editor.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) {
        documentTransactions.push(transaction.steps.length);
      }
    });

    expectOk(bridge.stagePreview(preview));
    expect(editor.getJSON()).toEqual(beforeDoc);
    expect(bridge.getRevision()).toBe(beforeRevision);
    expect(undoDepth(editor.state)).toBe(beforeUndoDepth);

    expect(bridge.undoLastVoiceEdit(preview.id)).toEqual({
      ok: false,
      reason: "invalid-range",
    });
    expect(editor.getJSON()).toEqual(beforeDoc);
    expect(bridge.getRevision()).toBe(beforeRevision);
    expect(undoDepth(editor.state)).toBe(beforeUndoDepth);

    const applied = expectOk(bridge.applyReplacement(preview.id));

    expect(applied).toEqual({
      beforeRevision,
      afterRevision: beforeRevision + 1,
    });
    expect(documentTransactions).toEqual([1]);
    expect(bridge.getSnapshot().paragraphs[1].text).toBe("更直接的信任表达。");
    expect(bridge.applyReplacement(preview.id)).toEqual({
      ok: false,
      reason: "preview-not-found",
    });

    bridge.destroy();
  });

  it("rejects no-op previews without changing the document or manual history", () => {
    const editor = createEditor("<p>abc</p>");
    const bridge = new EditorBridge(editor);
    const initialDoc = editor.getJSON();
    const initialParagraph = bridge.getSnapshot().paragraphs[0];

    editor.view.dispatch(
      editor.state.tr.insertText("X", initialParagraph.from + 1),
    );
    expect(bridge.getSnapshot().paragraphs[0].text).toBe("aXbc");

    const afterManualEdit = editor.getJSON();
    const revision = bridge.getRevision();
    const historyDepth = undoDepth(editor.state);
    const redoHistoryDepth = redoDepth(editor.state);
    const paragraph = bridge.getSnapshot().paragraphs[0];
    const insertionPoint = paragraph.from + 2;
    const emptyRange = rangeFromPositions(
      bridge,
      editor,
      insertionPoint,
      insertionPoint,
    );

    expect(
      bridge.stagePreview(makePreview(emptyRange, "", "noop-empty")),
    ).toEqual({ ok: false, reason: "invalid-range" });
    expect(
      bridge.stagePreview(
        makePreview(
          rangeForParagraph(bridge, 0),
          paragraph.text,
          "noop-identical",
        ),
      ),
    ).toEqual({ ok: false, reason: "invalid-range" });

    expect(editor.getJSON()).toEqual(afterManualEdit);
    expect(bridge.getRevision()).toBe(revision);
    expect(undoDepth(editor.state)).toBe(historyDepth);
    expect(redoDepth(editor.state)).toBe(redoHistoryDepth);
    expect(bridge.previewUndoLastVoiceEdit()).toEqual({
      ok: false,
      reason: "nothing-to-undo",
    });

    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.getJSON()).toEqual(initialDoc);
    bridge.destroy();
  });

  it("replaces cross-block plain text with a ProseMirror Slice", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const snapshot = bridge.getSnapshot();
    const range = rangeFromPositions(
      bridge,
      editor,
      snapshot.paragraphs[0].from + 2,
      snapshot.paragraphs[1].to - 2,
    );
    const replacement = "<img onerror=alert(1)>\n硬换行\n\n新段落";
    const preview = makePreview(range, replacement, "cross-block");

    expectOk(bridge.stagePreview(preview));
    expectOk(bridge.applyReplacement(preview.id));

    const inverse = expectOk(bridge.previewUndoLastVoiceEdit());
    expect(inverse.originalText).toBe(replacement);
    expect(inverse.range.text).toBe(replacement);
    expect(
      editor.state.doc.textBetween(
        inverse.range.from,
        inverse.range.to,
        "\n\n",
        "\n",
      ),
    ).toBe(replacement);
    expect(editor.view.dom.querySelector("img")).toBeNull();
    expect(editor.view.dom.textContent).toContain("<img onerror=alert(1)>");
    expect(JSON.stringify(editor.getJSON())).toContain("hardBreak");

    bridge.destroy();
  });

  it("rejects an apply when preview revision is stale", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const preview = makePreview(
      rangeForParagraph(bridge, 0),
      "过期内容",
      "stale",
    );

    expectOk(bridge.stagePreview(preview));
    editor.view.dispatch(
      editor.state.tr.insertText("人工编辑", preview.range.from),
    );
    const afterManualEdit = editor.getJSON();

    expect(bridge.applyReplacement(preview.id)).toEqual({
      ok: false,
      reason: "stale-revision",
    });
    expect(editor.getJSON()).toEqual(afterManualEdit);
    expect(bridge.applyReplacement(preview.id)).toEqual({
      ok: false,
      reason: "preview-not-found",
    });

    bridge.destroy();
  });

  it("rejects ranges that intersect legacy edit or loading marks", () => {
    const scenarios = [
      {
        name: "edit-highlight",
        install(
          editor: Editor,
          paragraphFrom: number,
          paragraphNodeFrom: number,
        ) {
          const mark = editor.state.schema.marks["edit-highlight"].create({
            color: "#fff",
            oldText: "旧",
            id: "legacy-edit",
          });
          editor.view.dispatch(
            editor.state.tr.addMark(paragraphFrom, paragraphFrom + 2, mark),
          );
          return { from: paragraphFrom + 1, to: paragraphFrom + 1 };
        },
      },
      {
        name: "loading-highlight",
        install(
          editor: Editor,
          paragraphFrom: number,
          paragraphNodeFrom: number,
        ) {
          const mark = editor.state.schema.marks["loading-highlight"].create();
          editor.view.dispatch(
            editor.state.tr.addMark(paragraphFrom, paragraphFrom + 2, mark),
          );
          return { from: paragraphFrom, to: paragraphFrom + 1 };
        },
      },
      {
        name: "collapse",
        install(
          editor: Editor,
          paragraphFrom: number,
          paragraphNodeFrom: number,
        ) {
          const collapse = editor.state.schema.nodes.collapse.create({
            "deleted-text": "已删除",
            id: "legacy-collapse",
          });
          const position = paragraphFrom + 1;
          editor.view.dispatch(editor.state.tr.insert(position, collapse));
          return { from: position, to: position };
        },
      },
      {
        name: "paragraph is-loading attribute",
        install(
          editor: Editor,
          paragraphFrom: number,
          paragraphNodeFrom: number,
        ) {
          const paragraph = editor.state.doc.nodeAt(paragraphNodeFrom);
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(paragraphNodeFrom, undefined, {
              ...paragraph?.attrs,
              "is-loading": true,
            }),
          );
          return { from: paragraphFrom, to: paragraphFrom + 1 };
        },
      },
    ];

    for (const scenario of scenarios) {
      const editor = createEditor(DEFAULT_CONTENT, true);
      const bridge = new EditorBridge(editor);
      const paragraph = bridge.getSnapshot().paragraphs[0];
      const positions = scenario.install(
        editor,
        paragraph.from,
        paragraph.nodeFrom,
      );
      const range = rangeFromPositions(
        bridge,
        editor,
        positions.from,
        positions.to,
      );
      const preview = makePreview(
        range,
        `${scenario.name}新内容`,
        `legacy-${scenario.name}`,
      );

      expect(bridge.stagePreview(preview), scenario.name).toEqual({
        ok: false,
        reason: "pending-legacy-edit",
      });
      bridge.destroy();
    }
  });

  it("undoes only when no later document change has occurred", () => {
    const cleanEditor = createEditor();
    const cleanBridge = new EditorBridge(cleanEditor);
    const beforeDoc = cleanEditor.getJSON();
    const preview = makePreview(
      rangeForParagraph(cleanBridge, 1),
      "已确认的语音改写",
      "undo-clean",
    );

    expectOk(cleanBridge.stagePreview(preview));
    expectOk(cleanBridge.applyReplacement(preview.id));
    const afterDoc = cleanEditor.getJSON();
    const inverse = expectOk(cleanBridge.previewUndoLastVoiceEdit());

    expect(inverse.mode).toBe("undo");
    expect(inverse.originalText).toBe(preview.replacementText);
    expect(inverse.replacementText).toBe(preview.originalText);
    expect(inverse.segments).toEqual(
      preview.segments.map((segment) => ({
        ...segment,
        kind:
          segment.kind === "insert"
            ? "delete"
            : segment.kind === "delete"
              ? "insert"
              : "equal",
      })),
    );
    const afterApplyRevision = cleanBridge.getRevision();
    const afterApplyUndoDepth = undoDepth(cleanEditor.state);
    const afterApplyRedoDepth = redoDepth(cleanEditor.state);
    expect(cleanBridge.applyReplacement(inverse.id)).toEqual({
      ok: false,
      reason: "invalid-range",
    });
    expect(cleanEditor.getJSON()).toEqual(afterDoc);
    expect(cleanBridge.getRevision()).toBe(afterApplyRevision);
    expect(undoDepth(cleanEditor.state)).toBe(afterApplyUndoDepth);
    expect(redoDepth(cleanEditor.state)).toBe(afterApplyRedoDepth);

    expectOk(cleanBridge.undoLastVoiceEdit(inverse.id));
    expect(cleanEditor.getJSON()).toEqual(beforeDoc);
    expect(redo(cleanEditor.state, cleanEditor.view.dispatch)).toBe(true);
    expect(cleanEditor.getJSON()).toEqual(afterDoc);
    expect(redoDepth(cleanEditor.state)).toBe(0);
    expect(cleanBridge.undoLastVoiceEdit(inverse.id)).toEqual({
      ok: false,
      reason: "preview-not-found",
    });
    cleanBridge.destroy();

    const dirtyEditor = createEditor();
    const dirtyBridge = new EditorBridge(dirtyEditor);
    const dirtyPreview = makePreview(
      rangeForParagraph(dirtyBridge, 1),
      "稍后会过期",
      "undo-dirty",
    );
    expectOk(dirtyBridge.stagePreview(dirtyPreview));
    expectOk(dirtyBridge.applyReplacement(dirtyPreview.id));
    const dirtyInverse = expectOk(dirtyBridge.previewUndoLastVoiceEdit());
    const finalParagraph = dirtyBridge.getSnapshot().paragraphs[2];
    dirtyEditor.view.dispatch(
      dirtyEditor.state.tr.insertText("后续手动修改", finalParagraph.to),
    );
    const afterInterveningEdit = dirtyEditor.getJSON();

    expect(dirtyBridge.undoLastVoiceEdit(dirtyInverse.id)).toEqual({
      ok: false,
      reason: "intervening-edit",
    });
    expect(dirtyEditor.getJSON()).toEqual(afterInterveningEdit);
    dirtyBridge.destroy();
  });

  it("keeps typing before, voice apply, and typing after as separate history events", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const initialDoc = editor.getJSON();
    const first = bridge.getSnapshot().paragraphs[0];

    editor.view.dispatch(editor.state.tr.insertText("前", first.from));
    const afterTypingBefore = editor.getJSON();

    const preview = makePreview(
      rangeForParagraph(bridge, 1),
      "语音改写事件",
      "history",
    );
    expectOk(bridge.stagePreview(preview));
    expectOk(bridge.applyReplacement(preview.id));
    const afterVoiceApply = editor.getJSON();

    const last = bridge.getSnapshot().paragraphs[2];
    editor.view.dispatch(editor.state.tr.insertText("后", last.to));

    expect(undoDepth(editor.state)).toBe(3);
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.getJSON()).toEqual(afterVoiceApply);
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.getJSON()).toEqual(afterTypingBefore);
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.getJSON()).toEqual(initialDoc);

    bridge.destroy();
  });

  it("validates ranges, original text, diff reconstruction, and opaque ids", () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const range = rangeForParagraph(bridge, 0);

    expect(
      bridge.stagePreview({
        ...makePreview(range, "新文", "wrong-original"),
        originalText: "被篡改的原文",
      }),
    ).toEqual({ ok: false, reason: "invalid-range" });

    expect(
      bridge.stagePreview({
        ...makePreview(range, "新文", "wrong-diff"),
        segments: [{ kind: "equal", text: "不相关" }],
      }),
    ).toEqual({ ok: false, reason: "invalid-range" });

    expect(
      bridge.stagePreview({
        ...makePreview(range, "新文", "wrong-range"),
        range: { ...range, to: editor.state.doc.content.size + 1 },
      }),
    ).toEqual({ ok: false, reason: "invalid-range" });

    expect(
      bridge.stagePreview(
        makePreview(range, "不允许伪造撤回", "external-undo", "undo"),
      ),
    ).toEqual({ ok: false, reason: "invalid-range" });

    const stored = makePreview(range, "安全副本", "opaque");
    expectOk(bridge.stagePreview(stored));
    stored.replacementText = "外部篡改";
    stored.segments = [{ kind: "insert", text: "外部篡改" }];
    expect(bridge.applyReplacement(stored.id)).toEqual({
      ok: false,
      reason: "invalid-range",
    });
    expect(bridge.getSnapshot().paragraphs[0].text).toBe(range.text);

    const valid = makePreview(range, "安全副本", "opaque-valid");
    expectOk(bridge.stagePreview(valid));
    expectOk(bridge.applyReplacement(valid.id));
    expect(bridge.getSnapshot().paragraphs[0].text).toBe("安全副本");

    bridge.destroy();
  });

  it("fails fast without the extension and destroys idempotently without owning Editor", () => {
    const missingExtensionEditor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit],
      content: DEFAULT_CONTENT,
    });
    editors.push(missingExtensionEditor);

    expect(() => new EditorBridge(missingExtensionEditor)).toThrow(
      /VoiceHighlightExtension/,
    );

    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    expectOk(
      bridge.stagePreview(makePreview(rangeForParagraph(bridge, 0), "副本")),
    );

    bridge.destroy();
    bridge.destroy();

    expect(editor.isDestroyed).toBe(false);
    expect(editor.getJSON()).toBeDefined();
  });

  it("registers one bridge on WordflowTextEditor and exposes its lifecycle event", async () => {
    const { textEditor, TextEditorConstructor } =
      await createTextEditorElement();

    expect(customElements.get("wordflow-text-editor")).toBe(
      TextEditorConstructor,
    );

    const received = { readyEvent: null as CustomEvent<EditorBridge> | null };
    const getReadyEvent = (): CustomEvent<EditorBridge> => {
      if (received.readyEvent === null) {
        throw new Error("Expected editor-bridge-ready event");
      }
      return received.readyEvent;
    };
    textEditor.addEventListener("editor-bridge-ready", (event) => {
      received.readyEvent = event as CustomEvent<EditorBridge>;
    });
    document.body.append(textEditor);
    await textEditor.updateComplete;

    const bridge = textEditor.getVoiceEditorBridge();
    const ownedEditor = textEditor.editor;

    textEditor.initEditor();

    expect(bridge).toBeInstanceOf(EditorBridge);
    expect(textEditor.getVoiceEditorBridge()).toBe(bridge);
    expect(getReadyEvent().detail).toBe(bridge);
    expect(getReadyEvent().bubbles).toBe(true);
    expect(getReadyEvent().composed).toBe(true);
    expect(ownedEditor).not.toBeNull();

    textEditor.remove();

    expect(ownedEditor?.isDestroyed).toBe(true);
    expect(textEditor.getVoiceEditorBridge()).toBeNull();

    received.readyEvent = null;
    document.body.append(textEditor);
    await textEditor.updateComplete;

    const reconnectedBridge = textEditor.getVoiceEditorBridge();
    const reconnectedEditor = textEditor.editor;
    expect(reconnectedBridge).toBeInstanceOf(EditorBridge);
    expect(reconnectedBridge).not.toBe(bridge);
    expect(reconnectedEditor).not.toBe(ownedEditor);
    expect(reconnectedEditor?.isDestroyed).toBe(false);
    expect(getReadyEvent().detail).toBe(reconnectedBridge);

    textEditor.remove();
    expect(reconnectedEditor?.isDestroyed).toBe(true);
  });

  it("does not initialize while detached and initializes once after reconnect", async () => {
    const { textEditor } = await createTextEditorElement();
    const readyEvents: CustomEvent<EditorBridge>[] = [];
    textEditor.addEventListener("editor-bridge-ready", (event) => {
      readyEvents.push(event as CustomEvent<EditorBridge>);
    });

    document.body.append(textEditor);
    textEditor.remove();
    await textEditor.updateComplete;

    expect(textEditor.isConnected).toBe(false);
    expect(textEditor.editor).toBeNull();
    expect(textEditor.getVoiceEditorBridge()).toBeNull();
    expect(readyEvents).toHaveLength(0);

    document.body.append(textEditor);
    await textEditor.updateComplete;

    const editor = textEditor.editor;
    const bridge = textEditor.getVoiceEditorBridge();
    expect(editor).not.toBeNull();
    expect(bridge).toBeInstanceOf(EditorBridge);
    expect(readyEvents).toHaveLength(1);
    expect(readyEvents[0].detail).toBe(bridge);

    textEditor.initEditor();
    expect(textEditor.editor).toBe(editor);
    expect(textEditor.getVoiceEditorBridge()).toBe(bridge);
    expect(readyEvents).toHaveLength(1);

    textEditor.remove();
    expect(editor?.isDestroyed).toBe(true);
  });

  it("preserves the complete document when WordflowTextEditor reconnects", async () => {
    const { textEditor } = await createTextEditorElement();
    const readyEvents: CustomEvent<EditorBridge>[] = [];
    textEditor.addEventListener("editor-bridge-ready", (event) => {
      readyEvents.push(event as CustomEvent<EditorBridge>);
    });
    document.body.append(textEditor);
    await textEditor.updateComplete;

    const firstEditor = textEditor.editor;
    const firstBridge = textEditor.getVoiceEditorBridge();
    if (!firstEditor || !firstBridge) {
      throw new Error("Expected the first editor and bridge to initialize");
    }
    const preservedHeading = `重连后必须保留的标题${"正文".repeat(
      firstEditor.state.doc.content.size + 10,
    )}`;
    const distinctiveDocument = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [
            {
              type: "text",
              marks: [{ type: "bold" }],
              text: preservedHeading,
            },
          ],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "嵌套列表正文" }],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "独特的用户文档结尾。" }],
        },
      ],
    };
    const currentSelection = firstEditor.state.selection;
    const replacementDocument =
      firstEditor.schema.nodeFromJSON(distinctiveDocument);
    const transaction = firstEditor.state.tr.replaceWith(
      0,
      firstEditor.state.doc.content.size,
      replacementDocument.content,
    );
    transaction.setSelection(
      TextSelection.create(
        transaction.doc,
        currentSelection.anchor,
        currentSelection.head,
      ),
    );
    firstEditor.view.dispatch(transaction);
    const expectedDocument = firstEditor.getJSON();
    const expectedText = firstEditor.getText();

    textEditor.remove();
    expect(firstEditor.isDestroyed).toBe(true);

    document.body.append(textEditor);
    await textEditor.updateComplete;

    const reconnectedEditor = textEditor.editor;
    const reconnectedBridge = textEditor.getVoiceEditorBridge();
    expect(reconnectedEditor).not.toBeNull();
    expect(reconnectedEditor).not.toBe(firstEditor);
    expect(reconnectedBridge).toBeInstanceOf(EditorBridge);
    expect(reconnectedBridge).not.toBe(firstBridge);
    expect(reconnectedEditor?.getJSON()).toEqual(expectedDocument);
    expect(reconnectedEditor?.getText()).toBe(expectedText);
    expect(readyEvents).toHaveLength(2);
    expect(readyEvents[1].detail).toBe(reconnectedBridge);

    textEditor.remove();
    expect(reconnectedEditor?.isDestroyed).toBe(true);
  });
});
