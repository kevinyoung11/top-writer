import { describe, expect, it, vi } from "vitest";
import {
  ModelFamily,
  SupportedRemoteModel,
  type UserConfig,
} from "../components/wordflow/user-config";
import type {
  GenerateTextRequest,
  TextGenerationService,
} from "../llms/text-generation-service";
import type { EditorSnapshot, ParagraphRef } from "./types";
import { SemanticLocator, shortlistParagraphs } from "./semantic-locator";

const userConfig: UserConfig = {
  preferredLLM: SupportedRemoteModel["gpt-5-nano-free"],
  llmAPIKeys: {
    [ModelFamily.openAI]: "openai-secret-that-must-not-enter-the-prompt",
    [ModelFamily.google]: "google-secret-that-must-not-enter-the-prompt",
    [ModelFamily.local]: "local-secret-that-must-not-enter-the-prompt",
  },
};

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
  };
};

const fixtureTexts = [
  "P00：topic 写作开场。",
  "P01：topic 作者介绍。",
  "P02：topic 产品故事。",
  "P03：topic 海边市场与信任关系。",
  "P04：topic 用户案例。",
  "P05：topic 定价说明。",
  "P06：topic 写作方法。",
  "P07：topic 收束观点。",
  "P08：PRIVATE-P08 不应发给模型。",
  "P09：PRIVATE-P09 不应发给模型。",
  "P10：PRIVATE-P10 不应发给模型。",
  "P11：PRIVATE-P11 不应发给模型。",
];

const snapshot = (texts = fixtureTexts): EditorSnapshot => ({
  revision: 17,
  paragraphs: texts.map((text, index) => paragraph(index, text)),
  selection: {
    revision: 17,
    from: 301,
    to: 305,
    text: "SELECTION-SHOULD-NOT-LEAK",
    paragraphIndexes: [3],
    block: false,
  },
  currentParagraphIndex: 3,
  lastSpokenParagraphIndex: null,
});

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

const modelContext = (signal?: AbortSignal) => ({
  userConfig,
  userID: "user-sensitive-id-that-must-not-enter-the-prompt",
  signal,
});

describe("shortlistParagraphs", () => {
  it("normalizes Unicode punctuation, whitespace, Latin case, and emoji without mutating input", () => {
    const paragraphs = [
      paragraph(2, "ＦＯＯ　ＢＡＲ 😀市场"),
      paragraph(4, "foo baz 市场"),
      paragraph(9, "无关内容"),
    ];
    const before = structuredClone(paragraphs);

    const shortlisted = shortlistParagraphs("foo，bar　😀 市场", paragraphs);

    expect(
      shortlisted.map(({ paragraph: item, score }) => [item.index, score]),
    ).toEqual([
      [2, 1],
      [4, expect.any(Number)],
      [9, 0],
    ]);
    expect(paragraphs).toEqual(before);
  });

  it("uses codepoint bigrams and stable score, index, then input ordering", () => {
    const firstSameIndex = { ...paragraph(4, "甲乙"), id: "first-same-index" };
    const secondSameIndex = {
      ...paragraph(4, "甲乙"),
      id: "second-same-index",
    };
    const laterIndex = paragraph(7, "甲乙");
    const entries = [laterIndex, secondSameIndex, firstSameIndex];

    const shortlisted = shortlistParagraphs("甲丙", entries, 3);

    expect(shortlisted.map(({ paragraph: item }) => item.id)).toEqual([
      "second-same-index",
      "first-same-index",
      "paragraph-7",
    ]);
    expect(shortlistParagraphs("😀x", [paragraph(1, "😀b")])[0].score).toBe(0);
    expect(shortlistParagraphs("", entries)).toEqual([]);
    expect(shortlistParagraphs("甲", [], 8)).toEqual([]);
  });

  it("honors the caller limit without changing source paragraphs", () => {
    const entries = [
      paragraph(1, "topic one"),
      paragraph(2, "topic two"),
      paragraph(3, "topic three"),
    ];

    expect(shortlistParagraphs("topic", entries, 2)).toHaveLength(2);
    expect(shortlistParagraphs("topic", entries, 0)).toEqual([]);
  });
});

describe("SemanticLocator", () => {
  it("returns a unique normalized exact local match without calling the model", async () => {
    const generated = createGenerator("not used");
    const locator = new SemanticLocator(generated.service);
    const doc = snapshot([
      "P00：开场。",
      "P01：这里谈海边市场与信任。",
      "P02：结尾。",
    ]);

    await expect(
      locator.locate("海边，市场", doc, modelContext()),
    ).resolves.toEqual([
      {
        range: {
          revision: 17,
          from: doc.paragraphs[1].nodeFrom,
          to: doc.paragraphs[1].nodeTo,
          text: doc.paragraphs[1].text,
          paragraphIndexes: [1],
          block: true,
        },
        score: 1,
        reason: "精确文本匹配",
      },
    ]);
    expect(generated.generate).not.toHaveBeenCalled();
  });

  it("sends only an eight-paragraph JSON shortlist and no private document state to the model", async () => {
    const generated = createGenerator(
      JSON.stringify([
        { index: 7, score: 0.4, reason: "第七段" },
        { index: 1, score: 0.9, reason: "第一段" },
      ]),
    );
    const locator = new SemanticLocator(generated.service);

    const result = await locator.locate("topic", snapshot(), modelContext());

    expect(generated.generate).toHaveBeenCalledTimes(1);
    const request = firstGeneratedRequest(generated.generate);
    expect(request).toMatchObject({
      temperature: 0,
      userConfig,
      userID: "user-sensitive-id-that-must-not-enter-the-prompt",
      useCache: false,
    });
    expect(request.prompt).toContain('"query":"topic"');
    for (let index = 0; index < 8; index += 1) {
      expect(request.prompt).toContain(`P0${index}`);
    }
    for (const privateValue of [
      "P08",
      "P09",
      "P10",
      "P11",
      "PRIVATE-P08",
      "SELECTION-SHOULD-NOT-LEAK",
      "openai-secret-that-must-not-enter-the-prompt",
      "user-sensitive-id-that-must-not-enter-the-prompt",
      "301",
    ]) {
      expect(request.prompt).not.toContain(privateValue);
    }
    expect(
      result.map(({ range, score, reason }) => [
        range.paragraphIndexes,
        score,
        reason,
      ]),
    ).toEqual([
      [[1], 0.9, "第一段"],
      [[7], 0.4, "第七段"],
    ]);
  });

  it("deduplicates valid model candidates, sorts them, and caps the result at three", async () => {
    const generated = createGenerator(
      JSON.stringify([
        { index: 4, score: 0.2, reason: "low first" },
        { index: 1, score: 0.9, reason: "first winner" },
        { index: 4, score: 0.7, reason: "higher winner" },
        { index: 1, score: 0.9, reason: "must keep first tie" },
        { index: 2, score: 0.8, reason: "second" },
        { index: 7, score: 0.1, reason: "fourth" },
        { index: 99, score: 1, reason: "outside shortlist" },
        { index: 3, score: Number.POSITIVE_INFINITY, reason: "bad score" },
      ]),
    );
    const locator = new SemanticLocator(generated.service);

    const result = await locator.locate("topic", snapshot(), modelContext());

    expect(
      result.map(({ range, score, reason }) => [
        range.paragraphIndexes[0],
        score,
        reason,
      ]),
    ).toEqual([
      [1, 0.9, "first winner"],
      [2, 0.8, "second"],
      [4, 0.7, "higher winner"],
    ]);
    expect(result.every(({ range }) => range.block)).toBe(true);
  });

  it("accepts a model's empty array as a deliberate no-match result", async () => {
    const generated = createGenerator("[]");
    const locator = new SemanticLocator(generated.service);

    await expect(
      locator.locate("topic", snapshot(), modelContext()),
    ).resolves.toEqual([]);
  });

  it("falls back to local top-three matches on malformed JSON, ordinary provider failure, and wholly invalid results", async () => {
    for (const result of [
      "not json",
      JSON.stringify({ index: 1, score: 0.9, reason: "not an array" }),
      new Error("provider offline"),
      JSON.stringify([
        { index: 99, score: 0.9, reason: "outside" },
        { index: "1", score: 0.9, reason: "wrong index type" },
        { index: 1, score: 2, reason: "out of range" },
        { index: 2, score: 0.8, reason: "" },
      ]),
    ]) {
      const generated = createGenerator(result);
      const locator = new SemanticLocator(generated.service);

      const candidates = await locator.locate(
        "topic",
        snapshot(),
        modelContext(),
      );

      expect(candidates).toHaveLength(3);
      expect(candidates.map(({ range }) => range.paragraphIndexes[0])).toEqual([
        0, 1, 2,
      ]);
      expect(candidates.map(({ reason }) => reason)).toEqual([
        "本地相关度匹配",
        "本地相关度匹配",
        "本地相关度匹配",
      ]);
    }
  });

  it("propagates generator and pre-aborted cancellation without falling back", async () => {
    const aborted = new Error("the caller cancelled");
    aborted.name = "AbortError";
    const generated = createGenerator(aborted);
    const locator = new SemanticLocator(generated.service);

    await expect(
      locator.locate("topic", snapshot(), modelContext()),
    ).rejects.toBe(aborted);

    const controller = new AbortController();
    controller.abort();
    const exactGenerated = createGenerator("not used");
    const exactLocator = new SemanticLocator(exactGenerated.service);
    await expect(
      exactLocator.locate(
        "海边市场",
        snapshot(),
        modelContext(controller.signal),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(exactGenerated.generate).not.toHaveBeenCalled();
  });

  it("does not mutate a snapshot and returns independent candidate ranges", async () => {
    const doc = snapshot();
    const before = structuredClone(doc);
    const generated = createGenerator("[]");
    const locator = new SemanticLocator(generated.service);

    const exactDoc = snapshot(["P00：唯一关键词。", "P01：其它内容。"]);
    const beforeExactDoc = structuredClone(exactDoc);
    const candidates = await locator.locate(
      "唯一关键词",
      exactDoc,
      modelContext(),
    );
    candidates[0].range.paragraphIndexes.push(88);

    await locator.locate("topic", doc, modelContext());
    expect(doc).toEqual(before);
    expect(exactDoc).toEqual(beforeExactDoc);
  });
});
