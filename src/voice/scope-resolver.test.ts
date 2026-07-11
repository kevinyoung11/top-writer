// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { EditorBridge } from "./editor/editor-bridge";
import { VoiceHighlightExtension } from "./editor/voice-highlight-extension";
import type {
  EditorSnapshot,
  ParagraphRef,
  VoiceRange,
  VoiceScope,
} from "./types";
import { resolveScope, toSpeechContentRanges } from "./scope-resolver";

const paragraphs: ParagraphRef[] = [
  {
    id: "p0",
    index: 0,
    nodeType: "paragraph",
    nodeFrom: 0,
    nodeTo: 5,
    from: 1,
    to: 4,
    text: "甲段。",
    separatorBefore: "",
  },
  {
    id: "nested-p1",
    index: 1,
    nodeType: "paragraph",
    nodeFrom: 10,
    nodeTo: 17,
    from: 12,
    to: 15,
    text: "中\n段",
    separatorBefore: "\n\n",
  },
  {
    id: "p2",
    index: 2,
    nodeType: "paragraph",
    nodeFrom: 20,
    nodeTo: 25,
    from: 21,
    to: 24,
    text: "末段！",
    separatorBefore: "\n\n",
  },
];

const jsdomEditors: Editor[] = [];
const jsdomBridges: EditorBridge[] = [];

afterEach(() => {
  while (jsdomBridges.length > 0) jsdomBridges.pop()?.destroy();
  while (jsdomEditors.length > 0) {
    const editor = jsdomEditors.pop();
    if (editor && !editor.isDestroyed) editor.destroy();
  }
  document.body.replaceChildren();
});

const snapshot = (patch: Partial<EditorSnapshot> = {}): EditorSnapshot => ({
  revision: 9,
  paragraphs: paragraphs.map((paragraph) => ({ ...paragraph })),
  selection: null,
  currentParagraphIndex: 1,
  lastSpokenParagraphIndex: 2,
  ...patch,
});

const range = (patch: Partial<VoiceRange> = {}): VoiceRange => ({
  revision: 9,
  from: 12,
  to: 15,
  text: "中\n段",
  paragraphIndexes: [1],
  block: false,
  ...patch,
});

const resolve = (
  scope: VoiceScope,
  value: EditorSnapshot = snapshot(),
  target: VoiceRange | null = null,
) => resolveScope(scope, value, target);

describe("resolveScope", () => {
  it("returns null for fixed document scopes on an empty snapshot", () => {
    const empty = snapshot({
      paragraphs: [],
      currentParagraphIndex: 0,
      lastSpokenParagraphIndex: null,
    });

    for (const scope of [
      { kind: "document" },
      { kind: "current" },
      { kind: "previous" },
      { kind: "next" },
      { kind: "paragraph", index: 0 },
    ] as const) {
      expect(resolve(scope, empty)).toBeNull();
    }
  });

  it("builds document and paragraph ranges from node coordinates", () => {
    expect(resolve({ kind: "document" })).toEqual({
      revision: 9,
      from: 0,
      to: 25,
      text: "甲段。\n\n中\n段\n\n末段！",
      paragraphIndexes: [0, 1, 2],
      block: true,
    });
    expect(resolve({ kind: "paragraph", index: 1 })).toEqual({
      revision: 9,
      from: 10,
      to: 17,
      text: "中\n段",
      paragraphIndexes: [1],
      block: true,
    });
  });

  it("uses bridge-provided structural separators for document text", () => {
    const value = snapshot({
      paragraphs: [
        { ...paragraphs[0], text: "Alpha", separatorBefore: "" },
        {
          ...paragraphs[1],
          text: "Beta",
          separatorBefore: "\n[horizontal rule]\n",
        },
        { ...paragraphs[2], text: "Gamma", separatorBefore: "\u2028" },
      ],
    });

    expect(resolve({ kind: "document" }, value)).toMatchObject({
      text: "Alpha\n[horizontal rule]\nBeta\u2028Gamma",
      paragraphIndexes: [0, 1, 2],
    });
  });

  it("rejects multi-paragraph document scopes with absent or invalid separators", () => {
    const missingSeparator = snapshot({
      paragraphs: [
        { ...paragraphs[0], separatorBefore: "" },
        { ...paragraphs[1], separatorBefore: undefined },
      ],
    });
    const invalidSeparator = snapshot({
      paragraphs: [
        { ...paragraphs[0], separatorBefore: "" },
        {
          ...paragraphs[1],
          separatorBefore: 42 as unknown as string,
        },
      ],
    });

    expect(resolve({ kind: "document" }, missingSeparator)).toBeNull();
    expect(resolve({ kind: "document" }, invalidSeparator)).toBeNull();
  });

  it("matches the EditorBridge canonical document text around a horizontal rule", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit, VoiceHighlightExtension],
      content: "<p>Alpha</p><hr><p>Beta</p>",
    });
    document.body.append(editor.view.dom);
    jsdomEditors.push(editor);
    const bridge = new EditorBridge(editor);
    jsdomBridges.push(bridge);

    const bridgeSnapshot = bridge.getSnapshot();
    const first = bridgeSnapshot.paragraphs[0];
    const last =
      bridgeSnapshot.paragraphs[bridgeSnapshot.paragraphs.length - 1];
    const expectedText = editor.state.doc.textBetween(
      first.from,
      last.to,
      "\n\n",
      "\n",
    );
    const resolved = resolve({ kind: "document" }, bridgeSnapshot);

    expect(resolved?.text).toBe(expectedText);
    expect(resolved?.paragraphIndexes).toEqual([0, 1]);
  });

  it("uses selection then valid last-spoken then cursor for effective scope", () => {
    const selection = range({
      revision: 4,
      from: 13,
      to: 15,
      text: "\n段",
    });

    expect(resolve({ kind: "effective" }, snapshot({ selection }))).toEqual({
      ...selection,
      paragraphIndexes: [1],
      block: false,
    });
    expect(
      resolve(
        { kind: "effective" },
        snapshot({ selection: null, lastSpokenParagraphIndex: 2 }),
      )?.paragraphIndexes,
    ).toEqual([2]);
    expect(
      resolve(
        { kind: "effective" },
        snapshot({ selection: null, lastSpokenParagraphIndex: 99 }),
      )?.paragraphIndexes,
    ).toEqual([1]);
  });

  it("anchors current, previous, and next at valid last-spoken without wrapping", () => {
    expect(resolve({ kind: "current" })?.paragraphIndexes).toEqual([2]);
    expect(resolve({ kind: "previous" })?.paragraphIndexes).toEqual([1]);
    expect(resolve({ kind: "next" })).toBeNull();

    const firstAnchor = snapshot({
      lastSpokenParagraphIndex: 0,
      currentParagraphIndex: 2,
    });
    expect(resolve({ kind: "previous" }, firstAnchor)).toBeNull();
    expect(resolve({ kind: "next" }, firstAnchor)?.paragraphIndexes).toEqual([
      1,
    ]);
  });

  it("falls back to cursor for navigation when last-spoken is invalid", () => {
    const cursorAnchor = snapshot({ lastSpokenParagraphIndex: -1 });

    expect(
      resolve({ kind: "current" }, cursorAnchor)?.paragraphIndexes,
    ).toEqual([1]);
    expect(
      resolve({ kind: "previous" }, cursorAnchor)?.paragraphIndexes,
    ).toEqual([0]);
    expect(resolve({ kind: "next" }, cursorAnchor)?.paragraphIndexes).toEqual([
      2,
    ]);

    const invalid = snapshot({
      lastSpokenParagraphIndex: 99,
      currentParagraphIndex: 99,
    });
    expect(resolve({ kind: "current" }, invalid)).toBeNull();
  });

  it("rejects invalid paragraph indexes and semantic scopes", () => {
    for (const index of [-1, 3, 1.5, Number.NaN]) {
      expect(resolve({ kind: "paragraph", index })).toBeNull();
    }
    expect(resolve({ kind: "semantic", query: "信任" })).toBeNull();
  });

  it("returns selection only for selection scope and detects full-node blocks", () => {
    expect(resolve({ kind: "selection" })).toBeNull();

    const partial = range({
      revision: 3,
      from: 13,
      to: 14,
      text: "\n",
      block: true,
    });
    expect(
      resolve({ kind: "selection" }, snapshot({ selection: partial })),
    ).toEqual({ ...partial, paragraphIndexes: [1], block: false });

    const fullNodes = range({
      revision: 2,
      from: 0,
      to: 17,
      text: "甲段。\n\n中\n段",
      paragraphIndexes: [0, 1],
      block: false,
    });
    expect(
      resolve({ kind: "selection" }, snapshot({ selection: fullNodes })),
    ).toEqual({ ...fullNodes, paragraphIndexes: [0, 1], block: true });
  });

  it("returns a cloned resolved target and preserves its stale revision", () => {
    const target = range({ revision: 2, paragraphIndexes: [1, 2] });
    const result = resolve({ kind: "resolved-target" }, snapshot(), target);

    expect(result).toEqual(target);
    expect(result).not.toBe(target);
    expect(result?.paragraphIndexes).not.toBe(target.paragraphIndexes);
    expect(resolve({ kind: "resolved-target" })).toBeNull();
  });

  it("does not mutate inputs and returns independently mutable outputs", () => {
    const selection = range({ paragraphIndexes: [1] });
    const input = snapshot({ selection });
    const target = range({ revision: 5, paragraphIndexes: [2] });
    const beforeSnapshot = structuredClone(input);
    const beforeTarget = structuredClone(target);

    const result = resolve({ kind: "selection" }, input, target);
    if (!result) throw new Error("Expected range");
    result.paragraphIndexes.push(99);
    result.text = "mutated";

    expect(input).toEqual(beforeSnapshot);
    expect(target).toEqual(beforeTarget);
  });
});

describe("toSpeechContentRanges", () => {
  it("decomposes paragraph and document block ranges into content coordinates", () => {
    expect(
      toSpeechContentRanges(
        range({ from: 10, to: 17, block: true }),
        snapshot(),
      ),
    ).toEqual([
      {
        revision: 9,
        from: 12,
        to: 15,
        text: "中\n段",
        paragraphIndexes: [1],
        block: false,
      },
    ]);

    const documentRange = resolve({ kind: "document" });
    if (!documentRange) throw new Error("Expected document range");
    expect(toSpeechContentRanges(documentRange, snapshot())).toEqual([
      {
        revision: 9,
        from: 1,
        to: 4,
        text: "甲段。",
        paragraphIndexes: [0],
        block: false,
      },
      {
        revision: 9,
        from: 12,
        to: 15,
        text: "中\n段",
        paragraphIndexes: [1],
        block: false,
      },
      {
        revision: 9,
        from: 21,
        to: 24,
        text: "末段！",
        paragraphIndexes: [2],
        block: false,
      },
    ]);
  });

  it("clips partial and cross-paragraph selections from paragraph content", () => {
    const stalePartial = range({
      revision: 4,
      from: 13,
      to: 15,
      text: "caller text is ignored",
      paragraphIndexes: [1],
    });
    expect(toSpeechContentRanges(stalePartial, snapshot())).toEqual([
      {
        revision: 4,
        from: 13,
        to: 15,
        text: "\n段",
        paragraphIndexes: [1],
        block: false,
      },
    ]);

    const crossSelection = range({
      revision: 6,
      from: 2,
      to: 14,
      text: "cross",
      paragraphIndexes: [0, 1],
    });
    expect(toSpeechContentRanges(crossSelection, snapshot())).toEqual([
      {
        revision: 6,
        from: 2,
        to: 4,
        text: "段。",
        paragraphIndexes: [0],
        block: false,
      },
      {
        revision: 6,
        from: 12,
        to: 14,
        text: "中\n",
        paragraphIndexes: [1],
        block: false,
      },
    ]);
  });

  it("returns empty for empty/no-intersection ranges and remains pure", () => {
    const input = range({
      revision: 1,
      from: 6,
      to: 9,
      text: "gap",
      paragraphIndexes: [],
    });
    const inputSnapshot = snapshot();
    const beforeRange = structuredClone(input);
    const beforeSnapshot = structuredClone(inputSnapshot);

    expect(toSpeechContentRanges(input, inputSnapshot)).toEqual([]);
    expect(
      toSpeechContentRanges(
        range({ from: 13, to: 13, text: "", paragraphIndexes: [1] }),
        inputSnapshot,
      ),
    ).toEqual([]);
    expect(input).toEqual(beforeRange);
    expect(inputSnapshot).toEqual(beforeSnapshot);
  });
});
