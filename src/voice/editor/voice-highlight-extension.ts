import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { VoiceRange } from "../types";

export type VoiceHighlightChannel = "target" | "candidate" | "playback";

const VOICE_HIGHLIGHT_CHANNELS: VoiceHighlightChannel[] = [
  "target",
  "candidate",
  "playback",
];

export const VOICE_EDIT_META = "voice-editor-edit";

interface VoiceEditorState {
  revision: number;
  decorationsByChannel: Record<VoiceHighlightChannel, DecorationSet>;
}

interface VoiceHighlightMeta {
  type: "highlight";
  channel: VoiceHighlightChannel;
  range: Pick<VoiceRange, "from" | "to"> | null;
}

export const voiceEditorStatePluginKey = new PluginKey<VoiceEditorState>(
  "voice-editor-state",
);

const emptyDecorations = (): VoiceEditorState["decorationsByChannel"] => ({
  target: DecorationSet.empty,
  candidate: DecorationSet.empty,
  playback: DecorationSet.empty,
});

const decorationsForRange = (
  doc: ProseMirrorNode,
  channel: VoiceHighlightChannel,
  range: Pick<VoiceRange, "from" | "to">,
) => {
  const decorations: Decoration[] = [];
  const attributes = {
    class: `voice-highlight voice-highlight-${channel}`,
    "data-voice-highlight-channel": channel,
  };

  doc.descendants((node, position) => {
    if (!node.isTextblock) return;

    const nodeFrom = position;
    const nodeTo = position + node.nodeSize;
    const contentFrom = nodeFrom + 1;
    const contentTo = nodeTo - 1;
    const coversContent = range.from <= contentFrom && range.to >= contentTo;

    if (coversContent && (node.content.size === 0 || range.from < range.to)) {
      decorations.push(
        Decoration.node(nodeFrom, nodeTo, attributes, { channel }),
      );
      return false;
    }

    const from = Math.max(range.from, contentFrom);
    const to = Math.min(range.to, contentTo);
    if (from < to) {
      decorations.push(
        Decoration.inline(from, to, attributes, {
          channel,
          inclusiveStart: false,
          inclusiveEnd: false,
        }),
      );
    }
  });

  return DecorationSet.create(doc, decorations);
};

const isVoiceHighlightMeta = (value: unknown): value is VoiceHighlightMeta => {
  if (typeof value !== "object" || value === null) return false;
  const meta = value as Partial<VoiceHighlightMeta>;
  return (
    meta.type === "highlight" &&
    typeof meta.channel === "string" &&
    VOICE_HIGHLIGHT_CHANNELS.includes(meta.channel as VoiceHighlightChannel)
  );
};

export const VoiceHighlightExtension = Extension.create({
  name: "voice-highlight",

  addProseMirrorPlugins() {
    return [
      new Plugin<VoiceEditorState>({
        key: voiceEditorStatePluginKey,
        state: {
          init: () => ({
            revision: 0,
            decorationsByChannel: emptyDecorations(),
          }),
          apply(transaction, pluginState) {
            const mappedDecorations = Object.fromEntries(
              VOICE_HIGHLIGHT_CHANNELS.map((channel) => [
                channel,
                pluginState.decorationsByChannel[channel].map(
                  transaction.mapping,
                  transaction.doc,
                ),
              ]),
            ) as VoiceEditorState["decorationsByChannel"];

            if (transaction.docChanged) {
              return {
                revision: pluginState.revision + 1,
                decorationsByChannel: emptyDecorations(),
              };
            }

            const meta = transaction.getMeta(voiceEditorStatePluginKey);
            if (!isVoiceHighlightMeta(meta)) {
              return {
                revision: pluginState.revision,
                decorationsByChannel: mappedDecorations,
              };
            }

            return {
              revision: pluginState.revision,
              decorationsByChannel: {
                ...mappedDecorations,
                [meta.channel]: meta.range
                  ? decorationsForRange(
                      transaction.doc,
                      meta.channel,
                      meta.range,
                    )
                  : DecorationSet.empty,
              },
            };
          },
        },
        props: {
          decorations(state) {
            const pluginState = voiceEditorStatePluginKey.getState(state);
            if (!pluginState) return null;

            const decorations = VOICE_HIGHLIGHT_CHANNELS.flatMap((channel) =>
              pluginState.decorationsByChannel[channel].find(),
            );
            return DecorationSet.create(state.doc, decorations);
          },
        },
        appendTransaction(transactions, _oldState, newState) {
          if (
            !transactions.some((transaction) =>
              transaction.getMeta(VOICE_EDIT_META),
            )
          ) {
            return null;
          }

          const boundary = closeHistory(newState.tr);
          boundary.setMeta("addToHistory", false);
          return boundary;
        },
      }),
    ];
  },
});

export const setVoiceHighlight = (
  editor: Editor,
  channel: VoiceHighlightChannel,
  range: Pick<VoiceRange, "from" | "to"> | null,
) => {
  const transaction = editor.state.tr.setMeta(voiceEditorStatePluginKey, {
    type: "highlight",
    channel,
    range,
  } satisfies VoiceHighlightMeta);
  transaction.setMeta("addToHistory", false);
  editor.view.dispatch(transaction);
};
