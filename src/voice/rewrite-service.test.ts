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
import { RewriteService, RewriteServiceError } from "./rewrite-service";
import type { EditorSnapshot, ParagraphRef, VoiceRange } from "./types";

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
  paragraphs: texts.map((text, index) => paragraph(index, text)),
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
    const range: VoiceRange = {
      revision: doc.revision,
      from: doc.paragraphs[3].from,
      to: doc.paragraphs[4].to,
      text: "跨块目标",
      paragraphIndexes: [3, 4],
      block: false,
    };
    const generated = createGenerator("跨块改写");
    const service = new RewriteService(generated.service);

    await expect(service.rewrite(requestInput({ doc, range }))).resolves.toBe(
      "跨块改写",
    );

    const prompt = firstGeneratedRequest(generated.generate).prompt;
    expect(prompt).toContain(`前文：${JSON.stringify(doc.paragraphs[2].text)}`);
    expect(prompt).toContain(`后文：${JSON.stringify(doc.paragraphs[5].text)}`);
    expect(prompt).not.toContain(doc.paragraphs[1].text);
    expect(prompt).not.toContain(doc.paragraphs[6].text);
  });

  it.each([
    ["", "empty-output"],
    ["  选中片段\n", "unchanged-output"],
    ["```markdown\n改写后的文本\n```", "non-plain-output"],
  ] as const)("rejects %s as a typed %s error", async (output, code) => {
    const generated = createGenerator(output);
    const service = new RewriteService(generated.service);

    await expect(service.rewrite(requestInput())).rejects.toMatchObject({
      name: "RewriteServiceError",
      code,
    } satisfies Partial<RewriteServiceError>);
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
