import { Extension, type Editor } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { hashOriginalText } from "./edit-protocol";
import type { AgentEditOperation } from "./types";
import { voiceEditorStatePluginKey } from "../voice/editor/voice-highlight-extension";

export type AgentSuggestionFailure =
  | "agent-suggestions-unavailable"
  | "invalid-operation"
  | "duplicate-id"
  | "stale-revision"
  | "suggestion-not-found";

export type AgentSuggestionResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: AgentSuggestionFailure };

export interface AgentSuggestion {
  id: string;
  operation: AgentEditOperation;
}

interface AgentSuggestionState {
  suggestions: AgentSuggestion[];
  currentId: string | null;
  decorations: DecorationSet;
}

type AgentSuggestionMeta =
  | { type: "add"; suggestions: AgentSuggestion[] }
  | { type: "select"; id: string | null }
  | { type: "remove"; ids: string[]; remainingRevision?: number };

export const agentSuggestionPluginKey = new PluginKey<AgentSuggestionState>(
  "agent-suggestions",
);

const success = <T>(value: T): AgentSuggestionResult<T> => ({ ok: true, value });

const failure = <T>(reason: AgentSuggestionFailure): AgentSuggestionResult<T> => ({
  ok: false,
  reason,
});

const cloneOperation = (operation: AgentEditOperation): AgentEditOperation => ({
  ...operation,
});

const cloneSuggestion = (suggestion: AgentSuggestion): AgentSuggestion => ({
  id: suggestion.id,
  operation: cloneOperation(suggestion.operation),
});

const operationReplacement = (operation: AgentEditOperation) =>
  operation.type === "deleteRange" ? "" : operation.replacement;

const decorationsForOperation = (
  operation: AgentEditOperation,
): Decoration[] => {
  const attributes = {
    class: `agent-suggestion agent-suggestion-${operation.type}`,
    "data-agent-suggestion-id": operation.id,
  };
  const replacement = operationReplacement(operation);
  if (operation.type === "insertAfterRange") {
    return [
      Decoration.widget(
        operation.to,
        () => {
          const element = document.createElement("span");
          element.className = `${attributes.class} agent-suggestion-replacement`;
          element.dataset.agentSuggestionId = operation.id;
          element.textContent = replacement;
          return element;
        },
        { id: operation.id, side: 1 },
      ),
    ];
  }

  const deletion = Decoration.inline(operation.from, operation.to, {
    ...attributes,
    class: `${attributes.class} agent-suggestion-original`,
  }, { id: operation.id });

  if (replacement === "") return [deletion];

  return [
    deletion,
    Decoration.widget(
      operation.to,
      () => {
        const element = document.createElement("span");
        element.className = `${attributes.class} agent-suggestion-replacement`;
        element.dataset.agentSuggestionId = operation.id;
        element.textContent = replacement;
        return element;
      },
      { id: operation.id, side: 1 },
    ),
  ];
};

const decorationsForSuggestions = (doc: ProseMirrorNode, suggestions: readonly AgentSuggestion[]) =>
  DecorationSet.create(
    doc,
    suggestions.flatMap((suggestion) => decorationsForOperation(suggestion.operation)),
  );

const isSuggestionMeta = (value: unknown): value is AgentSuggestionMeta => {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Partial<AgentSuggestionMeta>;
  return meta.type === "add" || meta.type === "select" || meta.type === "remove";
};

const stateFor = (editor: Editor) => agentSuggestionPluginKey.getState(editor.state);

const currentRevision = (editor: Editor) =>
  voiceEditorStatePluginKey.getState(editor.state)?.revision;

const documentRangeIsValid = (doc: ProseMirrorNode, operation: AgentEditOperation) =>
  Number.isSafeInteger(operation.from) &&
  Number.isSafeInteger(operation.to) &&
  operation.from >= 0 &&
  operation.from < operation.to &&
  operation.to <= doc.content.size;

const operationIsWellFormed = (operation: AgentEditOperation) => {
  if (
    typeof operation.id !== "string" ||
    operation.id.length === 0 ||
    !Number.isSafeInteger(operation.revision) ||
    operation.revision < 0 ||
    !/^[a-f0-9]{64}$/.test(operation.originalTextHash)
  ) {
    return false;
  }

  if (
    operation.type !== "replaceRange" &&
    operation.type !== "insertAfterRange" &&
    operation.type !== "deleteRange"
  ) {
    return false;
  }

  return (
    operation.type === "deleteRange" ||
    (typeof operation.replacement === "string" && operation.replacement.length > 0)
  );
};

const overlapping = (first: AgentEditOperation, second: AgentEditOperation) =>
  first.from < second.to && second.from < first.to;

const conflicting = (first: AgentEditOperation, second: AgentEditOperation) =>
  overlapping(first, second) ||
  (first.type === "insertAfterRange" &&
    second.type === "insertAfterRange" &&
    first.to === second.to);

const mapOperation = (
  operation: AgentEditOperation,
  mapping: Parameters<DecorationSet["map"]>[0],
  revision: number,
): AgentEditOperation => ({
  ...operation,
  from: mapping.map(operation.from, -1),
  to: mapping.map(operation.to, 1),
  revision,
});

const removeSuggestions = (
  editor: Editor,
  ids: readonly string[],
  addToHistory: boolean,
  remainingRevision?: number,
) => {
  const transaction = editor.state.tr.setMeta(agentSuggestionPluginKey, {
    type: "remove",
    ids: [...ids],
    ...(remainingRevision === undefined ? {} : { remainingRevision }),
  } satisfies AgentSuggestionMeta);
  transaction.setMeta("addToHistory", addToHistory);
  editor.view.dispatch(transaction);
};

const inlineContent = (editor: Editor, text: string) => {
  const hardBreakType = editor.state.schema.nodes.hardBreak;
  if (!hardBreakType && text.includes("\n")) {
    throw new Error("The editor schema must provide a hardBreak node.");
  }

  const nodes: ProseMirrorNode[] = [];
  const lines = text.split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.length > 0) nodes.push(editor.state.schema.text(line));
    if (index < lines.length - 1) nodes.push(hardBreakType.create());
  }
  return Fragment.fromArray(nodes);
};

const plainTextSlice = (editor: Editor, text: string) => {
  if (text === "") return Slice.empty;

  const paragraphType = editor.state.schema.nodes.paragraph;
  if (!paragraphType) {
    throw new Error("The editor schema must provide a paragraph node.");
  }

  return Slice.maxOpen(
    Fragment.fromArray(
      text
        .split("\n\n")
        .map((paragraph) => paragraphType.create(null, inlineContent(editor, paragraph))),
    ),
  );
};

const isCrossTextblockRange = (doc: ProseMirrorNode, from: number, to: number) => {
  const $from = doc.resolve(from);
  const $to = doc.resolve(to);
  return !$from.sameParent($to) || !$from.parent.isTextblock;
};

const applyOperation = (editor: Editor, operation: AgentEditOperation, transaction = editor.state.tr) => {
  const replacement = operationReplacement(operation);
  const from = operation.type === "insertAfterRange" ? operation.to : operation.from;
  const to = operation.to;

  if (replacement === "") {
    transaction.deleteRange(from, to);
    return transaction;
  }

  if (!isCrossTextblockRange(transaction.doc, from, to) && !replacement.includes("\n")) {
    transaction.insertText(replacement, from, to);
    return transaction;
  }

  transaction.replaceRange(from, to, plainTextSlice(editor, replacement));
  return transaction;
};

export const AgentSuggestionExtension = Extension.create({
  name: "agent-suggestions",

  addProseMirrorPlugins() {
    return [
      new Plugin<AgentSuggestionState>({
        key: agentSuggestionPluginKey,
        state: {
          init: () => ({
            suggestions: [],
            currentId: null,
            decorations: DecorationSet.empty,
          }),
          apply(transaction, pluginState) {
            const meta = transaction.getMeta(agentSuggestionPluginKey);
            const mappedDecorations = pluginState.decorations.map(
              transaction.mapping,
              transaction.doc,
            );
            if (!isSuggestionMeta(meta)) {
              return { ...pluginState, decorations: mappedDecorations };
            }

            if (meta.type === "add") {
              const suggestions = [
                ...pluginState.suggestions,
                ...meta.suggestions.map(cloneSuggestion),
              ];
              return {
                suggestions,
                currentId: pluginState.currentId ?? suggestions[0]?.id ?? null,
                decorations: decorationsForSuggestions(transaction.doc, suggestions),
              };
            }

            if (meta.type === "select") {
              return {
                ...pluginState,
                currentId: meta.id,
                decorations: mappedDecorations,
              };
            }

            const ids = new Set(meta.ids);
            const remainingSuggestions = pluginState.suggestions.filter(
              (suggestion) => !ids.has(suggestion.id),
            );
            const remainingRevision = meta.remainingRevision;
            const suggestions =
              transaction.docChanged && remainingRevision !== undefined
                ? remainingSuggestions.map((suggestion) => ({
                    ...suggestion,
                    operation: mapOperation(
                      suggestion.operation,
                      transaction.mapping,
                      remainingRevision,
                    ),
                  }))
                : remainingSuggestions;
            const previousIndex = pluginState.suggestions.findIndex(
              (suggestion) => suggestion.id === pluginState.currentId,
            );
            const currentId = suggestions.some(
              (suggestion) => suggestion.id === pluginState.currentId,
            )
              ? pluginState.currentId
              : suggestions[Math.min(Math.max(previousIndex, 0), suggestions.length - 1)]?.id ?? null;
            return {
              suggestions,
              currentId,
              decorations: transaction.docChanged
                ? mappedDecorations.remove(
                    mappedDecorations.find(
                      undefined,
                      undefined,
                      (spec) => ids.has((spec as { id?: string }).id ?? ""),
                    ),
                  )
                : decorationsForSuggestions(transaction.doc, suggestions),
            };
          },
        },
        props: {
          decorations(state) {
            return agentSuggestionPluginKey.getState(state)?.decorations ?? null;
          },
        },
      }),
    ];
  },
});

export const addAgentSuggestions = async (
  editor: Editor,
  operations: readonly AgentEditOperation[],
): Promise<AgentSuggestionResult<string[]>> => {
  const state = stateFor(editor);
  const revision = currentRevision(editor);
  if (!state || revision === undefined) return failure("agent-suggestions-unavailable");

  for (const operation of operations) {
    if (!operationIsWellFormed(operation) || !documentRangeIsValid(editor.state.doc, operation)) {
      return failure("invalid-operation");
    }
    if (operation.revision !== revision) return failure("stale-revision");
    const hash = await hashOriginalText(
      editor.state.doc.textBetween(operation.from, operation.to, "\n\n", "\n"),
    );
    if (!hash.ok || hash.hash !== operation.originalTextHash) {
      return failure("invalid-operation");
    }
  }

  const latestState = stateFor(editor);
  if (!latestState || currentRevision(editor) !== revision) {
    return failure("stale-revision");
  }
  const existing = new Set(latestState.suggestions.map((suggestion) => suggestion.id));
  const allOperations = latestState.suggestions.map(
    (suggestion) => suggestion.operation,
  );
  for (const operation of operations) {
    if (existing.has(operation.id)) return failure("duplicate-id");
    if (allOperations.some((other) => conflicting(other, operation))) {
      return failure("invalid-operation");
    }
    existing.add(operation.id);
    allOperations.push(operation);
  }

  const suggestions = operations.map((operation) => ({
    id: operation.id,
    operation: cloneOperation(operation),
  }));
  const transaction = editor.state.tr.setMeta(agentSuggestionPluginKey, {
    type: "add",
    suggestions,
  } satisfies AgentSuggestionMeta);
  transaction.setMeta("addToHistory", false);
  editor.view.dispatch(transaction);
  return success(suggestions.map((suggestion) => suggestion.id));
};

export const listAgentSuggestions = (editor: Editor): AgentSuggestion[] =>
  stateFor(editor)?.suggestions.map(cloneSuggestion) ?? [];

export const currentAgentSuggestion = (editor: Editor): AgentSuggestion | null => {
  const state = stateFor(editor);
  const suggestion = state?.suggestions.find((item) => item.id === state.currentId);
  return suggestion ? cloneSuggestion(suggestion) : null;
};

const selectRelativeSuggestion = (editor: Editor, direction: 1 | -1) => {
  const state = stateFor(editor);
  if (!state || state.suggestions.length === 0) return null;
  const currentIndex = state.suggestions.findIndex(
    (suggestion) => suggestion.id === state.currentId,
  );
  const index =
    currentIndex < 0
      ? 0
      : (currentIndex + direction + state.suggestions.length) % state.suggestions.length;
  const suggestion = state.suggestions[index];
  const transaction = editor.state.tr.setMeta(agentSuggestionPluginKey, {
    type: "select",
    id: suggestion.id,
  } satisfies AgentSuggestionMeta);
  transaction.setMeta("addToHistory", false);
  editor.view.dispatch(transaction);
  return cloneSuggestion(suggestion);
};

export const nextAgentSuggestion = (editor: Editor) =>
  selectRelativeSuggestion(editor, 1);

export const previousAgentSuggestion = (editor: Editor) =>
  selectRelativeSuggestion(editor, -1);

export const rejectAgentSuggestion = (
  editor: Editor,
  id = currentAgentSuggestion(editor)?.id,
): AgentSuggestionResult<string> => {
  const state = stateFor(editor);
  if (!state) return failure("agent-suggestions-unavailable");
  if (!id || !state.suggestions.some((suggestion) => suggestion.id === id)) {
    return failure("suggestion-not-found");
  }
  removeSuggestions(editor, [id], false);
  return success(id);
};

export const rejectAllAgentSuggestions = (
  editor: Editor,
): AgentSuggestionResult<string[]> => {
  const state = stateFor(editor);
  if (!state) return failure("agent-suggestions-unavailable");
  const ids = state.suggestions.map((suggestion) => suggestion.id);
  if (ids.length > 0) removeSuggestions(editor, ids, false);
  return success(ids);
};

const suggestionsForAcceptance = (editor: Editor, ids: readonly string[]) => {
  const state = stateFor(editor);
  const revision = currentRevision(editor);
  if (!state || revision === undefined) return failure<AgentSuggestion[]>("agent-suggestions-unavailable");
  const suggestions = state.suggestions.filter((suggestion) => ids.includes(suggestion.id));
  if (suggestions.length !== ids.length) return failure<AgentSuggestion[]>("suggestion-not-found");
  if (
    suggestions.some(
      (suggestion) =>
        suggestion.operation.revision !== revision ||
        !documentRangeIsValid(editor.state.doc, suggestion.operation),
    )
  ) {
    return failure<AgentSuggestion[]>("stale-revision");
  }
  return success(suggestions);
};

const acceptSuggestions = (editor: Editor, ids: readonly string[]): AgentSuggestionResult<string[]> => {
  const pending = suggestionsForAcceptance(editor, ids);
  if (!pending.ok) return pending;
  if (pending.value.length === 0) return success([]);

  const transaction = closeHistory(editor.state.tr);
  for (const suggestion of [...pending.value].sort(
    (first, second) => second.operation.from - first.operation.from,
  )) {
    applyOperation(editor, suggestion.operation, transaction);
  }
  transaction.setMeta(agentSuggestionPluginKey, {
    type: "remove",
    ids: [...ids],
    remainingRevision: (currentRevision(editor) ?? -1) + 1,
  } satisfies AgentSuggestionMeta);
  editor.view.dispatch(transaction);
  return success([...ids]);
};

export const acceptAgentSuggestion = (
  editor: Editor,
  id = currentAgentSuggestion(editor)?.id,
): AgentSuggestionResult<string> => {
  if (!id) return failure("suggestion-not-found");
  const accepted = acceptSuggestions(editor, [id]);
  return accepted.ok ? success(id) : accepted;
};

export const acceptAllAgentSuggestions = (
  editor: Editor,
): AgentSuggestionResult<string[]> => {
  const ids = listAgentSuggestions(editor).map((suggestion) => suggestion.id);
  return acceptSuggestions(editor, ids);
};
