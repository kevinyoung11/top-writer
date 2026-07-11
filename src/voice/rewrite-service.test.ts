// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ModelFamily,
  SupportedRemoteModel,
  type UserConfig,
} from "../components/wordflow/user-config";
import type {
  GenerateTextRequest,
  TextGenerationService,
} from "../llms/text-generation-service";
import { RewriteService, RewriteServiceError } from "./rewrite-service";
import { resolveScope } from "./scope-resolver";
import type { EditorSnapshot, ParagraphRef, VoiceRange } from "./types";
import { EditorBridge } from "./editor/editor-bridge";
import { VoiceHighlightExtension } from "./editor/voice-highlight-extension";

const userConfig: UserConfig = {
  preferredLLM: SupportedRemoteModel["gpt-5-nano-free"],
  llmAPIKeys: {
    [ModelFamily.openAI]: "openai-secret-that-must-not-enter-the-prompt",
    [ModelFamily.google]: "google-secret-that-must-not-enter-the-prompt",
    [ModelFamily.local]: "local-secret-that-must-not-enter-the-prompt",
  },
};

const editors: Editor[] = [];

const createEditorBridge = (content: string) => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, VoiceHighlightExtension],
    content,
  });
  document.body.append(editor.view.dom);
  editors.push(editor);
  return { editor, bridge: new EditorBridge(editor) };
};

afterEach(() => {
  while (editors.length > 0) {
    const editor = editors.pop();
    if (editor && !editor.isDestroyed) editor.destroy();
  }
});

const paragraph = (
  index: number,
  text: string,
  separatorBefore?: string,
): ParagraphRef => {
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
    separatorBefore,
  };
};

const texts = [
  "P00：PRIVATE-P00 不应发给模型。",
  "P01：PRIVATE-P01 不应发给模型。",
  "P02：紧邻前文。",
  "P03：前缀选中片段后缀。",
  "P04：紧邻后文。",
  "P05：PRIVATE-P05 不应发给模型。",
  "P06：PRIVATE-P06 不应发给模型。",
  "P07：PRIVATE-P07 不应发给模型。",
  "P08：PRIVATE-P08 不应发给模型。",
  "P09：PRIVATE-P09 不应发给模型。",
  "P10：PRIVATE-P10 不应发给模型。",
  "P11：PRIVATE-P11 不应发给模型。",
];

const snapshot = (): EditorSnapshot => ({
  revision: 23,
  paragraphs: texts.map((text, index) =>
    paragraph(index, text, index === 0 ? "" : "\n\n"),
  ),
  selection: {
    revision: 23,
    from: 303,
    to: 307,
    text: "SELECTION-SHOULD-NOT-LEAK",
    paragraphIndexes: [3],
    block: false,
  },
  currentParagraphIndex: 3,
  lastSpokenParagraphIndex: null,
});

const targetRange = (doc = snapshot()): VoiceRange => {
  const target = doc.paragraphs[3];
  const prefix = "P03：前缀";
  const text = "选中片段";
  const from = target.from + prefix.length;
  return {
    revision: doc.revision,
    from,
    to: from + text.length,
    text,
    paragraphIndexes: [3],
    block: false,
  };
};

const crossPartialRange = (doc = snapshot()): VoiceRange => {
  const first = doc.paragraphs[3];
  const last = doc.paragraphs[4];
  const firstOffset = "P03：前缀".length;
  const lastOffset = "P04：紧邻".length;
  if (typeof last.separatorBefore !== "string") {
    throw new Error("Expected a structural separator for the fixture");
  }
  return {
    revision: doc.revision,
    from: first.from + firstOffset,
    to: last.from + lastOffset,
    text: `${first.text.slice(firstOffset)}${last.separatorBefore}${last.text.slice(0, lastOffset)}`,
    paragraphIndexes: [3, 4],
    block: false,
  };
};

const createGenerator = (result: string | Error) => {
  const generate = vi.fn<(request: GenerateTextRequest) => Promise<string>>(
    async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  );
  return {
    generate,
    service: { generate } as unknown as TextGenerationService,
  };
};

const firstGeneratedRequest = (
  generate: ReturnType<typeof createGenerator>["generate"],
): GenerateTextRequest => {
  const firstCall = generate.mock.calls[0];
  if (!firstCall) throw new Error("Expected the generator to be called");
  return firstCall[0];
};

const requestInput = (
  result: {
    doc?: EditorSnapshot;
    range?: VoiceRange;
    signal?: AbortSignal;
  } = {},
) => ({
  snapshot: result.doc ?? snapshot(),
  range: result.range ?? targetRange(result.doc),
  constraints: ["更直接", "保留事实"],
  userConfig,
  userID: "user-sensitive-id-that-must-not-enter-the-prompt",
  signal: result.signal,
});

describe("RewriteService", () => {
  it("sends only a partial target and its immediate outer neighbors in four JSON-labeled prompt sections", async () => {
    const generated = createGenerator("  改写后的文本  ");
    const service = new RewriteService(generated.service);
    const doc = snapshot();
    const range = targetRange(doc);

    await expect(service.rewrite(requestInput({ doc, range }))).resolves.toBe(
      "改写后的文本",
    );

    expect(generated.generate).toHaveBeenCalledTimes(1);
    const request = firstGeneratedRequest(generated.generate);
    expect(request).toMatchObject({
      temperature: 0.2,
      userConfig,
      userID: "user-sensitive-id-that-must-not-enter-the-prompt",
      useCache: false,
    });
    expect(request.prompt).toContain(
      `前文：${JSON.stringify(doc.paragraphs[2].text)}`,
    );
    expect(request.prompt).toContain(`目标原文：${JSON.stringify(range.text)}`);
    expect(request.prompt).toContain(
      `后文：${JSON.stringify(doc.paragraphs[4].text)}`,
    );
    expect(request.prompt).toContain(
      `修改要求：${JSON.stringify(["更直接", "保留事实"])}`,
    );
    expect(request.prompt).not.toContain(doc.paragraphs[3].text);
    for (const hidden of [
      "P00",
      "P01",
      "P05",
      "P06",
      "P07",
      "P08",
      "P09",
      "P10",
      "P11",
      "SELECTION-SHOULD-NOT-LEAK",
      "openai-secret-that-must-not-enter-the-prompt",
      "user-sensitive-id-that-must-not-enter-the-prompt",
      "303",
    ]) {
      expect(request.prompt).not.toContain(hidden);
    }
  });

  it("uses the neighbors outside the first and last paragraph for a cross-block target", async () => {
    const doc = snapshot();
    const range = crossPartialRange(doc);
    const generated = createGenerator("跨块改写");
    const service = new RewriteService(generated.service);

    await expect(service.rewrite(requestInput({ doc, range }))).resolves.toBe(
      "跨块改写",
    );

    const prompt = firstGeneratedRequest(generated.generate).prompt;
    expect(prompt).toContain(`前文：${JSON.stringify(doc.paragraphs[2].text)}`);
    expect(prompt).toContain(`目标原文：${JSON.stringify(range.text)}`);
    expect(prompt).toContain(`后文：${JSON.stringify(doc.paragraphs[5].text)}`);
    expect(prompt).not.toContain(doc.paragraphs[1].text);
    expect(prompt).not.toContain(doc.paragraphs[6].text);
  });

  it("uses the bridge's exact structural separator for an HR-spanning selection", async () => {
    const { editor, bridge } = createEditorBridge(
      "<p>Alpha</p><hr><p>Beta</p>",
    );
    const initial = bridge.getSnapshot();
    const first = initial.paragraphs[0];
    const second = initial.paragraphs[1];
    const from = first.from + 1;
    const to = second.to - 1;
    editor.view.dispatch(
      editor.state.tr.setSelection(
        TextSelection.create(editor.state.doc, from, to),
      ),
    );
    const doc = bridge.getSnapshot();
    const range = doc.selection;
    if (!range) throw new Error("Expected the cross-block selection");

    const expectedSeparator = editor.state.doc.textBetween(
      doc.paragraphs[0].to,
      doc.paragraphs[1].from,
      "\n\n",
      "\n",
    );
    expect(doc.paragraphs[1].separatorBefore).toBe(expectedSeparator);
    expect(range.text).toBe(
      editor.state.doc.textBetween(from, to, "\n\n", "\n"),
    );

    const generated = createGenerator("替换内容");
    const service = new RewriteService(generated.service);
    await expect(service.rewrite(requestInput({ doc, range }))).resolves.toBe(
      "替换内容",
    );
    expect(firstGeneratedRequest(generated.generate).prompt).toContain(
      `目标原文：${JSON.stringify(range.text)}`,
    );
  });

  it("passes a bridge-resolved document range with canonical HR separators to rewrite", async () => {
    const { editor, bridge } = createEditorBridge(
      "<p>Alpha</p><hr><p>Beta</p>",
    );
    const doc = bridge.getSnapshot();
    const range = resolveScope({ kind: "document" }, doc, null);
    if (!range) throw new Error("Expected the document scope to resolve");

    expect(range.text).toBe(
      editor.state.doc.textBetween(range.from, range.to, "\n\n", "\n"),
    );
    const generated = createGenerator("全文替换内容");
    const service = new RewriteService(generated.service);

    await expect(service.rewrite(requestInput({ doc, range }))).resolves.toBe(
      "全文替换内容",
    );
    expect(generated.generate).toHaveBeenCalledTimes(1);
    expect(firstGeneratedRequest(generated.generate).prompt).toContain(
      `目标原文：${JSON.stringify(range.text)}`,
    );
  });

  it("rejects a cross-block range without an exact structural separator before generating", async () => {
    const doc = snapshot();
    const range = crossPartialRange(doc);
    doc.paragraphs[4] = {
      ...doc.paragraphs[4],
      separatorBefore: undefined,
    };
    const generated = createGenerator("should not run");
    const service = new RewriteService(generated.service);

    await expect(
      service.rewrite(requestInput({ doc, range })),
    ).rejects.toMatchObject({
      name: "RewriteServiceError",
      code: "invalid-range",
    });
    expect(generated.generate).not.toHaveBeenCalled();
  });

  it("preserves a partial hard-break slice from the snapshot text", async () => {
    const doc = snapshot();
    doc.paragraphs[3] = paragraph(3, "P03：前\n缀选中片段后缀。");
    const target = doc.paragraphs[3];
    const start = "P03：前".length;
    const text = "\n缀选中片段";
    const range: VoiceRange = {
      revision: doc.revision,
      from: target.from + start,
      to: target.from + start + text.length,
      text,
      paragraphIndexes: [3],
      block: false,
    };
    const generated = createGenerator("带换行的改写");
    const service = new RewriteService(generated.service);

    await expect(service.rewrite(requestInput({ doc, range }))).resolves.toBe(
      "带换行的改写",
    );

    expect(firstGeneratedRequest(generated.generate).prompt).toContain(
      `目标原文：${JSON.stringify(text)}`,
    );
  });

  it("accepts a full paragraph block only when its snapshot text matches", async () => {
    const doc = snapshot();
    const target = doc.paragraphs[3];
    const range: VoiceRange = {
      revision: doc.revision,
      from: target.nodeFrom,
      to: target.nodeTo,
      text: target.text,
      paragraphIndexes: [3],
      block: true,
    };
    const generated = createGenerator("整段改写");
    const service = new RewriteService(generated.service);

    await expect(service.rewrite(requestInput({ doc, range }))).resolves.toBe(
      "整段改写",
    );

    expect(firstGeneratedRequest(generated.generate).prompt).toContain(
      `目标原文：${JSON.stringify(target.text)}`,
    );
  });

  it("rejects forged single and cross-block partial source text before it reaches the generator", async () => {
    const doc = snapshot();
    const forgedRanges = [
      { ...targetRange(doc), text: "PRIVATE-FORGED-SINGLE" },
      { ...crossPartialRange(doc), text: "PRIVATE-FORGED-CROSS" },
    ];

    for (const range of forgedRanges) {
      const generated = createGenerator("should not run");
      const service = new RewriteService(generated.service);

      await expect(
        service.rewrite(requestInput({ doc, range })),
      ).rejects.toMatchObject({
        name: "RewriteServiceError",
        code: "invalid-range",
      });
      expect(generated.generate).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["", "empty-output"],
    ["  选中片段\n", "unchanged-output"],
    ["```markdown\n改写后的文本\n```", "non-plain-output"],
    ["  ```markdown\n改写后的文本\n  ```", "non-plain-output"],
    ["改写如下：**新文本**", "non-plain-output"],
    ["改写如下：新文本", "non-plain-output"],
    ["以下是改写后的文本：新文本", "non-plain-output"],
    ["修改如下：新文本", "non-plain-output"],
  ] as const)("rejects %s as a typed %s error", async (output, code) => {
    const generated = createGenerator(output);
    const service = new RewriteService(generated.service);

    await expect(service.rewrite(requestInput())).rejects.toMatchObject({
      name: "RewriteServiceError",
      code,
    } satisfies Partial<RewriteServiceError>);
  });

  it.each([
    "正常的纯文本改写。",
    "第一段改写。\n\n第二段改写。",
    "普通句子：保留中文标点，括号（示例）和引号“内容”。",
    "数学表达式 2*3*4，不应被当作 Markdown。",
    "变量 a * b * c，应作为正文保留。",
    "- 此处是正文中的破折号说明。",
    "# 1 号公告",
    "> 此处是可插入的正文。",
    "这是 *强调* 文本，也可能就是原文。",
    "这是 _强调_ 文本，也可能就是原文。",
    "[链接](https://example.com) 也可以是正文。",
    "https://example.com/path 是裸链接文本。",
    "`行内字面量` 是可插入文本。",
  ])("accepts editor-insertable plain or literal text %s", async (output) => {
    const generated = createGenerator(output);
    const service = new RewriteService(generated.service);

    await expect(service.rewrite(requestInput())).resolves.toBe(output);
  });

  it("propagates ordinary provider and AbortError failures without wrapping", async () => {
    const ordinary = new Error("provider offline");
    const abort = new Error("caller stopped");
    abort.name = "AbortError";

    for (const error of [ordinary, abort]) {
      const generated = createGenerator(error);
      const service = new RewriteService(generated.service);
      await expect(service.rewrite(requestInput())).rejects.toBe(error);
    }
  });

  it("rejects a pre-aborted request without calling the generator", async () => {
    const controller = new AbortController();
    controller.abort();
    const generated = createGenerator("should not run");
    const service = new RewriteService(generated.service);

    await expect(
      service.rewrite(requestInput({ signal: controller.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(generated.generate).not.toHaveBeenCalled();
  });

  it("rejects stale revisions and invalid target envelopes before generating", async () => {
    const doc = snapshot();
    const valid = targetRange(doc);
    const invalidRanges: Array<
      [VoiceRange, "stale-revision" | "invalid-range"]
    > = [
      [{ ...valid, revision: doc.revision - 1 }, "stale-revision"],
      [{ ...valid, text: "" }, "invalid-range"],
      [{ ...valid, paragraphIndexes: [] }, "invalid-range"],
      [{ ...valid, paragraphIndexes: [3, 5] }, "invalid-range"],
      [
        {
          ...valid,
          from: doc.paragraphs[2].from,
          to: doc.paragraphs[3].to,
        },
        "invalid-range",
      ],
    ];

    for (const [range, code] of invalidRanges) {
      const generated = createGenerator("should not run");
      const service = new RewriteService(generated.service);

      await expect(
        service.rewrite(requestInput({ doc, range })),
      ).rejects.toMatchObject({
        name: "RewriteServiceError",
        code,
      });
      expect(generated.generate).not.toHaveBeenCalled();
    }
  });

  it("does not mutate the input snapshot or range", async () => {
    const doc = snapshot();
    const range = targetRange(doc);
    const beforeDoc = structuredClone(doc);
    const beforeRange = structuredClone(range);
    const generated = createGenerator("改写后的文本");
    const service = new RewriteService(generated.service);

    await service.rewrite(requestInput({ doc, range }));

    expect(doc).toEqual(beforeDoc);
    expect(range).toEqual(beforeRange);
  });
});
