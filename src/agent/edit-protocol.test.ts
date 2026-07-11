import { afterEach, describe, expect, it, vi } from "vitest";
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

const hash = async (text: string) => {
  const result = await hashOriginalText(text);
  if (!result.ok)
    throw new Error(`Expected hash, received ${result.error.code}`);
  return result.hash;
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
    originalTextHash: await hash(originalText),
    ...(type === "deleteRange" ? {} : { replacement: "changed" }),
  };
  return JSON.stringify([{ ...base, ...patch }]);
};

afterEach(() => {
  vi.unstubAllGlobals();
});

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
    ["a full block", 0, 7, "alpha"],
    ["the full document", 0, 13, "alpha\n\nbeta"],
  ])("accepts %s range at node boundaries", async (_label, from, to, text) => {
    const result = await parseAndValidateAgentEditOperations(
      await operation("replaceRange", {
        from,
        to,
        originalTextHash: await hash(text),
      }),
      snapshot,
    );

    expect(result).toMatchObject({
      ok: true,
      operations: [{ type: "replaceRange", from, to }],
    });
  });

  it("rejects conflicting overlapping ranges at the later operation", async () => {
    const first = JSON.parse(await operation("replaceRange"))[0];
    const second = {
      ...first,
      id: "overlap-second",
      type: "deleteRange",
      from: 2,
      to: 5,
      originalTextHash: await hash("lph"),
    };
    const { replacement: _replacement, ...deleteOperation } = second;

    const result = await parseAndValidateAgentEditOperations(
      JSON.stringify([first, deleteOperation]),
      snapshot,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "invalid-overlap", operationId: "overlap-second" },
    });
  });

  it("rejects multiple insertions after the same anchor", async () => {
    const first = JSON.parse(await operation("insertAfterRange"))[0];
    const second = { ...first, id: "same-anchor-second", replacement: "?" };

    const result = await parseAndValidateAgentEditOperations(
      JSON.stringify([first, second]),
      snapshot,
    );

    expect(result).toEqual({
      ok: false,
      error: { code: "invalid-overlap", operationId: "same-anchor-second" },
    });
  });

  it("returns the known SHA-256 digest", async () => {
    await expect(hashOriginalText("abc")).resolves.toEqual({
      ok: true,
      hash: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    });
  });

  it("returns a protocol failure when Web Crypto is unavailable", async () => {
    vi.stubGlobal("crypto", undefined);

    await expect(hashOriginalText("alpha")).resolves.toEqual({
      ok: false,
      error: { code: "hash-unavailable" },
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
          originalTextHash: await hash("wrong"),
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
