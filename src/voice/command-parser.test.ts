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

  it.each(["不要撤回", "不要停止", "读者信任很重要"])(
    "does not treat keyword text as a command: %s",
    (transcript) => {
      expect(parseVoicePlan(transcript)).toMatchObject({
        confidence: 0,
        actions: [],
      });
    },
  );

  it("treats a quoted control keyword inside an edit request as rewrite text", () => {
    expect(parseVoicePlan("把“继续”改成“接着”").actions).toEqual([
      {
        intent: "rewrite",
        scope: { kind: "effective" },
        constraints: ["把“继续”改成“接着”"],
      },
    ]);
  });

  it.each(["改革开放很重要", "产品正在改进"])(
    "does not treat an ordinary word containing 改 as a rewrite: %s",
    (transcript) => {
      expect(parseVoicePlan(transcript)).toMatchObject({
        confidence: 0,
        actions: [],
      });
    },
  );

  it.each(["改一下这段", "请改一下这段", "改这段", "改一下"])(
    "parses an explicit bare rewrite command: %s",
    (transcript) => {
      expect(parseVoicePlan(transcript).actions).toEqual([
        {
          intent: "rewrite",
          scope: { kind: "effective" },
          constraints: [transcript],
        },
      ]);
    },
  );

  it.each([
    "改得更直接",
    "改成更口语",
    "改为更简洁",
    "压缩到200字",
    "精简为三句话",
    "调整语气",
    "调整为更正式",
  ])("parses a constraint-led rewrite command: %s", (transcript) => {
    expect(parseVoicePlan(transcript).actions).toEqual([
      {
        intent: "rewrite",
        scope: { kind: "effective" },
        constraints: [transcript],
      },
    ]);
  });

  it.each(["改得", "改成", "改为", "改得，", "压缩到", "精简为", "调整为"])(
    "rejects a rewrite command with an empty complement: %s",
    (transcript) => {
      expect(parseVoicePlan(transcript)).toMatchObject({
        confidence: 0,
        actions: [],
      });
    },
  );

  it.each([
    ["改第5段", { kind: "paragraph", index: 4 }],
    ["把第5段改得更直接", { kind: "paragraph", index: 4 }],
    ["改上一段", { kind: "previous" }],
    ["改下一段", { kind: "next" }],
    ["改全文", { kind: "document" }],
    ["改选中内容", { kind: "selection" }],
  ])("preserves the explicit rewrite scope in %s", (transcript, scope) => {
    expect(parseVoicePlan(transcript).actions).toEqual([
      {
        intent: "rewrite",
        scope,
        constraints: [transcript],
      },
    ]);
  });

  it.each([
    "改第零段",
    "改第0段",
    "改第-1段",
    "改第1.5段",
    "改第9007199254740992段",
    "把第零段改得更直接",
    "把第5改得更直接",
  ])("rejects an invalid explicit rewrite target in %s", (transcript) => {
    expect(parseVoicePlan(transcript)).toMatchObject({
      confidence: 0,
      actions: [],
    });
  });

  it.each([
    "改第5段和第6段",
    "改第5段到第8段",
    "把第5段落改得更直接",
    "把第5段和第6段改得更直接",
    "把第5段改成第6段",
  ])("rejects an ambiguous numbered rewrite target in %s", (transcript) => {
    expect(parseVoicePlan(transcript)).toMatchObject({
      confidence: 0,
      actions: [],
    });
  });

  it.each([
    "改上一段和下一段",
    "改选中内容和下一段",
    "改全文和上一段",
    "改当前段和下一段",
    "改前一段和后一段",
    "改全部和前一段",
    "把上一段落改得更直接",
    "把上一段和下一段改得更直接",
    "把选中内容和下一段改得更直接",
    "把全文和上一段改得更直接",
    "把当前段和下一段改得更直接",
  ])(
    "rejects an incomplete or multi-scope rewrite target in %s",
    (transcript) => {
      expect(parseVoicePlan(transcript)).toMatchObject({
        confidence: 0,
        actions: [],
      });
    },
  );

  it.each([
    ["把上一段改得更直接", { kind: "previous" }],
    ["把前一段改得更直接", { kind: "previous" }],
    ["把下一段改得更直接", { kind: "next" }],
    ["把后一段改得更直接", { kind: "next" }],
    ["把选中内容改得更直接", { kind: "selection" }],
    ["把全文改得更直接", { kind: "document" }],
    ["把全部改得更直接", { kind: "document" }],
    ["改当前段", { kind: "current" }],
    ["改当前一段", { kind: "current" }],
  ])("preserves one complete explicit scope in %s", (transcript, scope) => {
    expect(parseVoicePlan(transcript).actions).toEqual([
      {
        intent: "rewrite",
        scope,
        constraints: [transcript],
      },
    ]);
  });

  it.each([
    ["把上一段改成“下一段”", { kind: "previous" }],
    ["把选中内容改成“全文”", { kind: "selection" }],
    ["把全文改成『上一段』", { kind: "document" }],
  ])(
    "ignores quoted target-like replacement text in %s",
    (transcript, scope) => {
      expect(parseVoicePlan(transcript).actions).toEqual([
        {
          intent: "rewrite",
          scope,
          constraints: [transcript],
        },
      ]);
    },
  );

  it.each(["改第5段，", "改第5段；"])(
    "allows trailing punctuation after one numbered target in %s",
    (transcript) => {
      expect(parseVoicePlan(transcript).actions[0]).toMatchObject({
        intent: "rewrite",
        scope: { kind: "paragraph", index: 4 },
      });
    },
  );

  it.each([
    "把“第5段”改成“第6段”",
    '把"第5段"改成"第6段"',
    "把『第5段』改成『第6段』",
  ])(
    "keeps quoted paragraph text as an effective rewrite in %s",
    (transcript) => {
      expect(parseVoicePlan(transcript).actions).toEqual([
        {
          intent: "rewrite",
          scope: { kind: "effective" },
          constraints: [transcript],
        },
      ]);
    },
  );

  it("allows a quoted replacement after one explicit paragraph target", () => {
    const transcript = "把第5段改成“第6段”";

    expect(parseVoicePlan(transcript).actions).toEqual([
      {
        intent: "rewrite",
        scope: { kind: "paragraph", index: 4 },
        constraints: [transcript],
      },
    ]);
  });

  it.each(["调整型基金风险很高", "压缩空气储能很重要", "精简版已经发布"])(
    "does not treat a rewrite-verb noun prefix as a command: %s",
    (transcript) => {
      expect(parseVoicePlan(transcript)).toMatchObject({
        confidence: 0,
        actions: [],
      });
    },
  );

  it("allows a rewrite request to quote a locate keyword", () => {
    expect(parseVoicePlan("把“找到”改成“发现”").actions).toEqual([
      {
        intent: "rewrite",
        scope: { kind: "effective" },
        constraints: ["把“找到”改成“发现”"],
      },
    ]);
  });

  it.each(["请不要改写这段", "请别润色这段"])(
    "rejects the polite negated command %s",
    (transcript) => {
      expect(parseVoicePlan(transcript)).toMatchObject({
        confidence: 0,
        actions: [],
      });
    },
  );

  it.each([
    "找到讲用户信任的那段；读一下",
    "找到讲用户信任的那段 读一下",
    "找到讲用户信任的那段 然后 读一下",
  ])("accepts a safe locate-read separator in %s", (transcript) => {
    const plan = parseVoicePlan(transcript);

    expect(plan.actions.map((action) => action.intent)).toEqual([
      "locate",
      "read",
    ]);
    expect(plan.actions[0].scope).toEqual({
      kind: "semantic",
      query: "用户信任",
    });
  });

  it.each(["。", "！", "!"])(
    "treats internal terminal punctuation %s as a locate-read separator",
    (separator) => {
      const transcript = `找到讲用户信任的那段${separator}读一下`;
      const plan = parseVoicePlan(transcript);

      expect(plan.transcript).toBe(transcript);
      expect(plan.actions.map((action) => action.intent)).toEqual([
        "locate",
        "read",
      ]);
    },
  );

  it("strips punctuation around a meaningful semantic query", () => {
    expect(parseVoicePlan("找到讲“用户信任”的那段").actions[0]).toMatchObject({
      intent: "locate",
      scope: { kind: "semantic", query: "用户信任" },
    });
  });

  it("rejects a contentless semantic query", () => {
    expect(parseVoicePlan("找到讲的那段")).toMatchObject({
      confidence: 0,
      actions: [],
    });
  });

  it("preserves a meaningful single-character semantic query", () => {
    expect(parseVoicePlan("找到讲税的那段").actions[0]).toMatchObject({
      intent: "locate",
      scope: { kind: "semantic", query: "税" },
    });
  });

  it.each(["找到讲，的那段", "找到讲用户信任的那段；随便读者"])(
    "rejects a malformed locate command without falling through: %s",
    (transcript) => {
      expect(parseVoicePlan(transcript)).toMatchObject({
        confidence: 0,
        actions: [],
      });
    },
  );

  it.each([
    "读第零段",
    "读第1.5段",
    "读第段",
    "读第 +1 段",
    "读第9007199254740992段",
  ])("rejects unsupported paragraph expression in %s", (transcript) => {
    expect(parseVoicePlan(transcript)).toMatchObject({
      confidence: 0,
      actions: [],
    });
  });

  it.each([
    ["停止朗读", "stop"],
    ["继续朗读", "resume"],
  ] as const)("keeps the natural direct control %s", (transcript, control) => {
    expect(parseVoicePlan(transcript).actions).toEqual([
      { intent: "control", scope: null, constraints: [], control },
    ]);
  });

  it.each([
    ["给我念前一段", { kind: "previous" }],
    ["朗读上一段", { kind: "previous" }],
  ])("keeps the natural direct read %s", (transcript, scope) => {
    expect(parseVoicePlan(transcript).actions).toEqual([
      { intent: "read", scope, constraints: [] },
    ]);
  });
});
