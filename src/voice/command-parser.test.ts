import { describe, expect, it } from "vitest";
import { parseVoicePlan } from "./command-parser";

describe("parseVoicePlan", () => {
  it("parses direct read navigation", () => {
    expect(parseVoicePlan("读上一段").actions).toEqual([
      { intent: "read", scope: { kind: "previous" }, constraints: [] },
    ]);
  });

  it("parses paragraph numbers as one-based user input", () => {
    expect(parseVoicePlan("读第 5 段").actions[0].scope).toEqual({
      kind: "paragraph",
      index: 4,
    });
  });

  it("parses a locate-read-rewrite compound command in order", () => {
    const plan = parseVoicePlan(
      "找到讲用户信任的那段，读一下，再改得更直接，保留最后一句",
    );

    expect(plan.actions.map((action) => action.intent)).toEqual([
      "locate",
      "read",
      "rewrite",
    ]);
    expect(plan.actions[0].scope).toEqual({
      kind: "semantic",
      query: "用户信任",
    });
    expect(plan.actions[2].constraints.join(" ")).toContain("保留最后一句");
  });

  it("never emits more than three actions", () => {
    expect(
      parseVoicePlan("找到讲产品的段落，读一下，再改写，再润色").actions,
    ).toHaveLength(3);
  });

  it("marks unknown speech as unsupported instead of guessing", () => {
    expect(parseVoicePlan("今天天气不错")).toMatchObject({
      confidence: 0,
      actions: [],
    });
  });

  it.each([
    ["读下一段", { kind: "next" }],
    ["读当前段", { kind: "current" }],
    ["从头到尾念一遍", { kind: "document" }],
    ["读选中内容", { kind: "selection" }],
  ])("parses read scope for %s", (transcript, scope) => {
    expect(parseVoicePlan(transcript).actions).toEqual([
      { intent: "read", scope, constraints: [] },
    ]);
  });

  it.each([
    ["暂停", "pause"],
    ["继续", "resume"],
    ["停止", "stop"],
    ["快一点", "faster"],
    ["慢一点", "slower"],
  ] as const)(
    "parses %s as a direct playback control",
    (transcript, control) => {
      expect(parseVoicePlan(transcript).actions).toEqual([
        { intent: "control", scope: null, constraints: [], control },
      ]);
    },
  );

  it.each(["撤回", "恢复刚才", "回到修改前"])(
    "parses %s as undo",
    (transcript) => {
      expect(parseVoicePlan(transcript).actions).toEqual([
        { intent: "undo", scope: null, constraints: [] },
      ]);
    },
  );

  it("targets the selection for an explicit selection rewrite", () => {
    expect(parseVoicePlan("把选中的内容改得更直接").actions).toEqual([
      {
        intent: "rewrite",
        scope: { kind: "selection" },
        constraints: ["把选中的内容改得更直接"],
      },
    ]);
  });

  it("uses the effective scope for a standalone rewrite", () => {
    expect(parseVoicePlan("把这段润色一下").actions).toEqual([
      {
        intent: "rewrite",
        scope: { kind: "effective" },
        constraints: ["把这段润色一下"],
      },
    ]);
  });

  it.each(["读第 0 段", "读第 -1 段"])(
    "rejects invalid paragraph number in %s",
    (transcript) => {
      expect(parseVoicePlan(transcript)).toMatchObject({
        confidence: 0,
        actions: [],
      });
    },
  );

  it.each(["", "   ", "。！？"])(
    "returns no actions for blank input %j",
    (transcript) => {
      expect(parseVoicePlan(transcript)).toMatchObject({
        confidence: 0,
        actions: [],
      });
    },
  );

  it("normalizes whitespace and terminal punctuation", () => {
    expect(parseVoicePlan("  读   上一段。！？  ")).toMatchObject({
      transcript: "读 上一段",
      confidence: 1,
    });
  });
});
