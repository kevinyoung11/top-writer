// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import { undo } from "@tiptap/pm/history";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentEditOperation } from "./types";
import { hashOriginalText } from "./edit-protocol";
import {
  acceptAgentSuggestion,
  acceptAllAgentSuggestions,
  addAgentSuggestions,
  AgentSuggestionExtension,
  currentAgentSuggestion,
  listAgentSuggestions,
  nextAgentSuggestion,
  previousAgentSuggestion,
  rejectAgentSuggestion,
  rejectAllAgentSuggestions,
} from "./agent-suggestion-extension";
import { EditorBridge } from "../voice/editor/editor-bridge";
import { VoiceHighlightExtension } from "../voice/editor/voice-highlight-extension";

const editors: Editor[] = [];

const createEditor = (content = "<p>Alpha</p><p>Beta</p><p>Gamma</p>") => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, VoiceHighlightExtension, AgentSuggestionExtension],
    content,
  });
  document.body.append(editor.view.dom);
  editors.push(editor);
  return editor;
};

const operation = async (
  editor: Editor,
  id: string,
  type: AgentEditOperation["type"],
  from: number,
  to: number,
  replacement?: string,
): Promise<AgentEditOperation> => {
  const hash = await hashOriginalText(
    editor.state.doc.textBetween(from, to, "\n\n", "\n"),
  );
  if (!hash.ok) throw new Error(`Could not hash test operation: ${hash.error.code}`);
  const base = {
    id,
    revision: new EditorBridge(editor).getRevision(),
    from,
    to,
    originalTextHash: hash.hash,
  };
  if (type === "deleteRange") return { ...base, type };
  return { ...base, type, replacement: replacement ?? "changed" } as AgentEditOperation;
};

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

describe("AgentSuggestionExtension", () => {
  it("adds, lists, and navigates ephemeral suggestions without changing document JSON", async () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const before = editor.getJSON();
    const alpha = bridge.getSnapshot().paragraphs[0];
    const beta = bridge.getSnapshot().paragraphs[1];

    expect(await addAgentSuggestions(editor, [
      await operation(editor, "alpha", "replaceRange", alpha.from, alpha.to, "One"),
      await operation(editor, "beta", "deleteRange", beta.from, beta.to),
    ])).toEqual({ ok: true, value: ["alpha", "beta"] });
    expect(listAgentSuggestions(editor).map((suggestion) => suggestion.id)).toEqual([
      "alpha",
      "beta",
    ]);
    expect(currentAgentSuggestion(editor)?.id).toBe("alpha");
    expect(
      editor.view.dom.querySelectorAll(
        '.agent-suggestion-current[data-agent-suggestion-id="alpha"]',
      ).length,
    ).toBeGreaterThan(0);
    expect(
      editor.view.dom.querySelectorAll(
        '.agent-suggestion-current[data-agent-suggestion-id="beta"]',
      ),
    ).toHaveLength(0);
    expect(nextAgentSuggestion(editor)?.id).toBe("beta");
    expect(
      editor.view.dom.querySelectorAll(
        '.agent-suggestion-current[data-agent-suggestion-id="alpha"]',
      ),
    ).toHaveLength(0);
    expect(
      editor.view.dom.querySelectorAll(
        '.agent-suggestion-current[data-agent-suggestion-id="beta"]',
      ).length,
    ).toBeGreaterThan(0);
    expect(previousAgentSuggestion(editor)?.id).toBe("alpha");
    expect(editor.getJSON()).toEqual(before);
    expect(editor.view.dom.querySelectorAll("[data-agent-suggestion-id]").length).toBeGreaterThan(0);
  });

  it("rejects one suggestion and all suggestions without changing the document", async () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const before = editor.getJSON();
    const [alpha, beta] = bridge.getSnapshot().paragraphs;
    expect(await addAgentSuggestions(editor, [
      await operation(editor, "alpha", "replaceRange", alpha.from, alpha.to, "One"),
      await operation(editor, "beta", "deleteRange", beta.from, beta.to),
    ])).toMatchObject({ ok: true });

    expect(rejectAgentSuggestion(editor, "alpha")).toEqual({ ok: true, value: "alpha" });
    expect(listAgentSuggestions(editor).map((suggestion) => suggestion.id)).toEqual(["beta"]);
    expect(rejectAllAgentSuggestions(editor)).toEqual({ ok: true, value: ["beta"] });
    expect(listAgentSuggestions(editor)).toEqual([]);
    expect(editor.getJSON()).toEqual(before);
  });

  it("accepts one suggestion in one undoable document transaction and keeps other suggestions", async () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const before = editor.getJSON();
    const [alpha, beta] = bridge.getSnapshot().paragraphs;
    const transactions: number[] = [];
    editor.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) transactions.push(transaction.steps.length);
    });
    expect(await addAgentSuggestions(editor, [
      await operation(editor, "alpha", "replaceRange", alpha.from, alpha.to, "One"),
      await operation(editor, "beta", "deleteRange", beta.from, beta.to),
    ])).toMatchObject({ ok: true });

    expect(acceptAgentSuggestion(editor, "alpha")).toEqual({ ok: true, value: "alpha" });
    expect(editor.getText()).toContain("One");
    expect(transactions).toEqual([1]);
    expect(listAgentSuggestions(editor).map((suggestion) => suggestion.id)).toEqual(["beta"]);
    expect(acceptAgentSuggestion(editor, "beta")).toEqual({ ok: true, value: "beta" });
    expect(editor.getText()).not.toContain("Beta");
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.getText()).toContain("Beta");
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.getJSON()).toEqual(before);
  });

  it("refuses stale suggestions but allows their rejection", async () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const alpha = bridge.getSnapshot().paragraphs[0];
    expect(await addAgentSuggestions(editor, [
      await operation(editor, "alpha", "replaceRange", alpha.from, alpha.to, "One"),
    ])).toMatchObject({ ok: true });
    editor.view.dispatch(editor.state.tr.insertText("Manual ", alpha.from));
    const afterManualEdit = editor.getJSON();

    expect(acceptAgentSuggestion(editor, "alpha")).toEqual({
      ok: false,
      reason: "stale-revision",
    });
    expect(editor.getJSON()).toEqual(afterManualEdit);
    expect(rejectAgentSuggestion(editor, "alpha")).toEqual({ ok: true, value: "alpha" });
  });

  it("accepts all valid suggestions together and clears their decorations", async () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const [alpha, _beta, gamma] = bridge.getSnapshot().paragraphs;
    expect(await addAgentSuggestions(editor, [
      await operation(editor, "alpha", "replaceRange", alpha.from, alpha.to, "One"),
      await operation(editor, "gamma", "insertAfterRange", gamma.from, gamma.to, "!"),
    ])).toMatchObject({ ok: true });

    expect(acceptAllAgentSuggestions(editor)).toEqual({
      ok: true,
      value: ["alpha", "gamma"],
    });
    expect(editor.getText()).toContain("One");
    expect(editor.getText()).toContain("Gamma!");
    expect(listAgentSuggestions(editor)).toEqual([]);
  });

  it("preserves an insertion anchor at the source boundary of an accepted replacement", async () => {
    const editor = createEditor("<p>abcd</p>");
    expect(await addAgentSuggestions(editor, [
      await operation(editor, "insert", "insertAfterRange", 1, 2, "!"),
      await operation(editor, "replace", "replaceRange", 2, 4, "X"),
    ])).toMatchObject({ ok: true });

    expect(acceptAgentSuggestion(editor, "replace")).toEqual({
      ok: true,
      value: "replace",
    });
    expect(listAgentSuggestions(editor)[0]?.operation).toMatchObject({ from: 1, to: 2 });
    expect(acceptAgentSuggestion(editor, "insert")).toEqual({
      ok: true,
      value: "insert",
    });
    expect(editor.getText()).toBe("a!Xd");
  });

  it("renders insertions without marking their anchor text as deleted", async () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const alpha = bridge.getSnapshot().paragraphs[0];
    expect(await addAgentSuggestions(editor, [
      await operation(editor, "insert", "insertAfterRange", alpha.from, alpha.to, "!"),
    ])).toMatchObject({ ok: true });

    expect(
      editor.view.dom.querySelector(
        '.agent-suggestion-original[data-agent-suggestion-id="insert"]',
      ),
    ).toBeNull();
  });

  it("rejects operations whose source hash does not match the current document", async () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const alpha = bridge.getSnapshot().paragraphs[0];
    const forged = await operation(editor, "forged", "replaceRange", alpha.from, alpha.to, "One");

    expect(await addAgentSuggestions(editor, [{ ...forged, originalTextHash: "a".repeat(64) }])).toEqual({
      ok: false,
      reason: "invalid-operation",
    });
    expect(listAgentSuggestions(editor)).toEqual([]);
  });

  it("rejects a concurrent add that duplicates an already-added suggestion", async () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const alpha = bridge.getSnapshot().paragraphs[0];
    const duplicate = await operation(editor, "duplicate", "replaceRange", alpha.from, alpha.to, "One");

    const [first, second] = await Promise.all([
      addAgentSuggestions(editor, [duplicate]),
      addAgentSuggestions(editor, [duplicate]),
    ]);

    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toEqual([
      { ok: false, reason: "duplicate-id" },
    ]);
    expect(listAgentSuggestions(editor).map((suggestion) => suggestion.id)).toEqual(["duplicate"]);
  });

  it("does not dispatch suggestions when admission is withdrawn after async validation", async () => {
    const editor = createEditor();
    const bridge = new EditorBridge(editor);
    const alpha = bridge.getSnapshot().paragraphs[0];
    const candidate = await operation(editor, "cancelled", "replaceRange", alpha.from, alpha.to, "One");

    await expect(addAgentSuggestions(editor, [candidate], () => false)).resolves.toEqual({
      ok: false,
      reason: "agent-suggestions-unavailable",
    });
    expect(listAgentSuggestions(editor)).toEqual([]);
  });
});
