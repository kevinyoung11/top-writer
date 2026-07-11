import { describe, expect, it } from "vitest";
import type { EditorSnapshot } from "../voice/types";
import {
  hashOriginalText,
  parseAndValidateAgentEditOperations,
} from "./edit-protocol";

const snapshot: EditorSnapshot = {
  revision: 7,
  paragraphs: [
    {
      id: "paragraph-0",
      index: 0,
      nodeType: "paragraph",
      nodeFrom: 0,
      nodeTo: 7,
      from: 1,
      to: 6,
      text: "alpha",
      separatorBefore: "",
    },
    {
      id: "paragraph-1",
      index: 1,
      nodeType: "paragraph",
      nodeFrom: 7,
      nodeTo: 13,
      from: 8,
      to: 12,
      text: "beta",
      separatorBefore: "\n\n",
    },
  ],
  selection: null,
  currentParagraphIndex: 0,
  lastSpokenParagraphIndex: null,
};

const operation = async (
  type: "replaceRange" | "insertAfterRange" | "deleteRange",
  patch: Record<string, unknown> = {},
) => {
  const originalText = "alpha";
  const base = {
    id: `${type}-one`,
    type,
    revision: snapshot.revision,
    from: 1,
    to: 6,
    originalTextHash: await hashOriginalText(originalText),
    ...(type === "deleteRange" ? {} : { replacement: "changed" }),
  };
  return JSON.stringify([{ ...base, ...patch }]);
};

describe("agent edit protocol", () => {
  it("accepts a validated replaceRange operation", async () => {
    const result = await parseAndValidateAgentEditOperations(
      await operation("replaceRange", { replacement: "revised" }),
      snapshot,
    );

    expect(result).toEqual({
      ok: true,
      operations: [
        expect.objectContaining({
          id: "replaceRange-one",
          type: "replaceRange",
          from: 1,
          to: 6,
          replacement: "revised",
        }),
      ],
    });
  });

  it("accepts an insertAfterRange operation anchored by its current text", async () => {
    const result = await parseAndValidateAgentEditOperations(
      await operation("insertAfterRange", { replacement: "!" }),
      snapshot,
    );

    expect(result).toMatchObject({
      ok: true,
      operations: [{ type: "insertAfterRange", replacement: "!" }],
    });
  });

  it("accepts a deleteRange operation without a replacement", async () => {
    const result = await parseAndValidateAgentEditOperations(
      await operation("deleteRange"),
      snapshot,
    );

    expect(result).toMatchObject({
      ok: true,
      operations: [{ type: "deleteRange" }],
    });
  });

  it.each([
    ["prose", "Here are some edits: []", "invalid-json"],
    ["unknown field", undefined, "unknown-field"],
    ["duplicate id", undefined, "duplicate-id"],
    ["revision mismatch", undefined, "revision-mismatch"],
    ["non-finite position", undefined, "invalid-range"],
    ["out-of-document range", undefined, "invalid-range"],
    ["original text hash mismatch", undefined, "hash-mismatch"],
    ["empty replacement", undefined, "invalid-replacement"],
  ] as const)("rejects %s", async (kind, _value, error) => {
    let raw: string;

    switch (kind) {
      case "prose":
        raw = "Here are some edits: []";
        break;
      case "unknown field":
        raw = await operation("replaceRange", { extra: true });
        break;
      case "duplicate id": {
        const item = JSON.parse(await operation("deleteRange"))[0];
        raw = JSON.stringify([item, { ...item }]);
        break;
      }
      case "revision mismatch":
        raw = await operation("deleteRange", { revision: 8 });
        break;
      case "non-finite position":
        raw = await operation("deleteRange", { from: 1.5 });
        break;
      case "out-of-document range":
        raw = await operation("deleteRange", { to: 99 });
        break;
      case "original text hash mismatch":
        raw = await operation("deleteRange", {
          originalTextHash: await hashOriginalText("wrong"),
        });
        break;
      case "empty replacement":
        raw = await operation("insertAfterRange", { replacement: "" });
        break;
    }

    await expect(
      parseAndValidateAgentEditOperations(raw, snapshot),
    ).resolves.toMatchObject({ ok: false, error: { code: error } });
  });
});
