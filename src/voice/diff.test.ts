import { afterEach, describe, expect, it, vi } from "vitest";

import { buildDiffSegments } from "./diff";

type Segment = { segment: string };

const reconstructOriginal = (
  segments: ReturnType<typeof buildDiffSegments>,
): string =>
  segments
    .filter((segment) => segment.kind !== "insert")
    .map((segment) => segment.text)
    .join("");

const reconstructReplacement = (
  segments: ReturnType<typeof buildDiffSegments>,
): string =>
  segments
    .filter((segment) => segment.kind !== "delete")
    .map((segment) => segment.text)
    .join("");

const expectValidDiff = (original: string, replacement: string): void => {
  const segments = buildDiffSegments(original, replacement);

  expect(reconstructOriginal(segments)).toBe(original);
  expect(reconstructReplacement(segments)).toBe(replacement);
  expect(
    segments.every(
      (segment) =>
        (segment.kind === "equal" ||
          segment.kind === "insert" ||
          segment.kind === "delete") &&
        segment.text.length > 0,
    ),
  ).toBe(true);
  expect(
    segments.every(
      (segment, index) =>
        index === 0 || segment.kind !== segments[index - 1]?.kind,
    ),
  ).toBe(true);
};

const stubSegmenter = (Segmenter: unknown): void => {
  vi.stubGlobal("Intl", { Segmenter });
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildDiffSegments", () => {
  it("returns no segments when both strings are empty", () => {
    expect(buildDiffSegments("", "")).toEqual([]);
  });

  it("returns one equal segment for identical text", () => {
    expect(buildDiffSegments("完全相同。", "完全相同。")).toEqual([
      { kind: "equal", text: "完全相同。" },
    ]);
  });

  it("returns one insert segment when the original is empty", () => {
    expect(buildDiffSegments("", "新增文本")).toEqual([
      { kind: "insert", text: "新增文本" },
    ]);
  });

  it("returns one delete segment when the replacement is empty", () => {
    expect(buildDiffSegments("删除文本", "")).toEqual([
      { kind: "delete", text: "删除文本" },
    ]);
  });

  it("does not report unrelated replacement tokens as equal", () => {
    expect(buildDiffSegments("旧内容", "新表达")).toEqual([
      { kind: "delete", text: "旧内容" },
      { kind: "insert", text: "新表达" },
    ]);
  });

  it("preserves exact Chinese punctuation and whitespace", () => {
    const original = "第一句， 保留空格。\n第二句：旧说法！";
    const replacement = "第一句， 保留空格。\n第二句：新说法？";

    expectValidDiff(original, replacement);
  });

  it("preserves emoji as exact raw text", () => {
    const original = "你好🙂，世界👩🏽‍💻！";
    const replacement = "你好🚀，世界👩🏽‍💻？";

    expectValidDiff(original, replacement);
  });

  it("handles repeated tokens without losing or duplicating text", () => {
    const original = "重复，重复，结束。";
    const replacement = "重复，新增，重复，结束。";
    const segments = buildDiffSegments(original, replacement);

    expectValidDiff(original, replacement);
    expect(segments).toContainEqual({ kind: "insert", text: "新增，" });
  });

  it("returns only plain data for HTML-like source text", () => {
    const original = '<b data-x="1">原文</b><script>alert(1)</script>';
    const replacement = '<i data-x="2">新文</i><img src=x onerror=alert(2)>';
    const segments = buildDiffSegments(original, replacement);

    expectValidDiff(original, replacement);
    expect(
      segments.every(
        (segment) =>
          Object.getPrototypeOf(segment) === Object.prototype &&
          Object.keys(segment).sort().join(",") === "kind,text",
      ),
    ).toBe(true);
    expect(segments.some((segment) => segment.text.includes("<mark>"))).toBe(
      false,
    );
  });

  it("merges neighboring segments of the same operation", () => {
    const segments = buildDiffSegments(
      "一二三四五六七八九十",
      "一二甲乙五六丙丁九十",
    );

    expectValidDiff("一二三四五六七八九十", "一二甲乙五六丙丁九十");
    expect(
      segments.some(
        (segment, index) =>
          index > 0 && segment.kind === segments[index - 1]?.kind,
      ),
    ).toBe(false);
  });

  it("uses a shared token dictionary for the original and replacement", () => {
    class WholeInputSegmenter {
      segment(input: string): Segment[] {
        return [{ segment: input }];
      }
    }

    stubSegmenter(WholeInputSegmenter);

    expect(buildDiffSegments("甲", "乙")).toEqual([
      { kind: "delete", text: "甲" },
      { kind: "insert", text: "乙" },
    ]);
  });

  it("falls back to character diff when Intl.Segmenter is unavailable", () => {
    stubSegmenter(undefined);

    const original = "中文标点，保留！";
    const replacement = "中文句号。保留？";
    const segments = buildDiffSegments(original, replacement);

    expectValidDiff(original, replacement);
    expect(segments.some((segment) => segment.kind === "equal")).toBe(true);
  });

  it("falls back when the Segmenter constructor throws", () => {
    class ThrowingSegmenter {
      constructor() {
        throw new Error("segmenter unavailable");
      }
    }

    stubSegmenter(ThrowingSegmenter);

    expectValidDiff("构造失败也保留原文。", "构造失败仍保留新版。");
  });

  it("falls back when segment iteration throws", () => {
    class ThrowingIteratorSegmenter {
      segment(): Iterable<Segment> {
        return {
          [Symbol.iterator](): Iterator<Segment> {
            throw new Error("iteration failed");
          },
        };
      }
    }

    stubSegmenter(ThrowingIteratorSegmenter);

    expectValidDiff("迭代失败，旧文。", "迭代失败，新文。");
  });

  it("falls back when segmented tokens cannot reconstruct the exact input", () => {
    class LossySegmenter {
      segment(input: string): Segment[] {
        return [{ segment: input.replace(/，/g, "") }];
      }
    }

    stubSegmenter(LossySegmenter);

    expectValidDiff("甲，乙", "甲，丙");
  });

  it("falls back safely for an unsupported segment result shape", () => {
    class InvalidSegmenter {
      segment(): unknown {
        return [{ segment: 42 }];
      }
    }

    stubSegmenter(InvalidSegmenter);

    expectValidDiff("结构异常🙂", "结构仍安全🚀");
  });

  it("falls back safely for a huge token stream", () => {
    class CharacterSegmenter {
      segment(input: string): Iterable<Segment> {
        return (function* (): Generator<Segment> {
          for (const character of input) {
            yield { segment: character };
          }
        })();
      }
    }

    stubSegmenter(CharacterSegmenter);

    const original = `${"甲".repeat(70_000)}旧`;
    const replacement = `${"甲".repeat(70_000)}新`;

    expectValidDiff(original, replacement);
  });

  it("does not mutate either input", () => {
    const inputs = {
      original: "原始内容，保持不变。",
      replacement: "替换内容，也保持不变。",
    } as const;
    const before = structuredClone(inputs);

    buildDiffSegments(inputs.original, inputs.replacement);

    expect(inputs).toEqual(before);
  });
});
