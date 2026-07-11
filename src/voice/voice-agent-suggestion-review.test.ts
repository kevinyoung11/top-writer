// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSuggestionExtension } from "../agent/agent-suggestion-extension";
import {
  ModelFamily,
  SupportedRemoteModel,
  type UserConfig,
} from "../components/wordflow/user-config";
import { EditorBridge } from "./editor/editor-bridge";
import { VoiceHighlightExtension } from "./editor/voice-highlight-extension";
import { VoicePreferencesStore } from "./preferences";
import type { RewriteService } from "./rewrite-service";
import type { SemanticLocator } from "./semantic-locator";
import type { SpeechRecognizer, SpeechSynthesizer } from "./speech/types";
import { VoiceCopilotController } from "./voice-copilot-controller";

const editors: Editor[] = [];

const userConfig: UserConfig = {
  preferredLLM: SupportedRemoteModel["gpt-5-nano-free"],
  llmAPIKeys: {
    [ModelFamily.openAI]: "test-openai-key",
    [ModelFamily.google]: "test-google-key",
    [ModelFamily.local]: "test-local-key",
  },
};

const recognizer: SpeechRecognizer = {
  supported: true,
  start: () => {},
  stop: () => {},
  cancel: () => {},
};

const synthesizer: SpeechSynthesizer = {
  supported: true,
  speak: async () => {},
  pause: () => {},
  resume: () => {},
  cancel: () => {},
};

const createController = () => {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: [StarterKit, VoiceHighlightExtension, AgentSuggestionExtension],
    content: "<p>原文</p>",
  });
  document.body.append(editor.view.dom);
  editors.push(editor);
  const bridge = new EditorBridge(editor);
  const controller = new VoiceCopilotController({
    recognizer,
    synthesizer,
    editor: bridge,
    locator: { locate: async () => [] } as unknown as SemanticLocator,
    rewriter: {
      rewrite: async () => "改写稿",
    } as unknown as RewriteService,
    preferences: new VoicePreferencesStore(null),
    getModelContext: () => ({ userConfig, userID: "voice-test" }),
  });
  return { editor, bridge, controller };
};

afterEach(() => {
  while (editors.length) editors.pop()?.destroy();
});

describe("voice rewrite shared suggestion review", () => {
  it("reviews voice rewrites through the shared facade before accepting, rejecting, and undoing", async () => {
    const { editor, bridge, controller } = createController();

    await controller.submitTranscript("改写当前段");
    const preview = controller.state.preview;
    if (!preview) throw new Error("Expected voice rewrite preview");

    expect(bridge.currentAgentSuggestion()?.id).toBe(preview.id);
    expect(editor.getText()).toBe("原文");

    controller.confirmPreview();
    expect(bridge.listAgentSuggestions()).toEqual([]);
    expect(editor.getText()).toBe("改写稿");

    controller.requestUndo();
    controller.confirmUndo();
    expect(editor.getText()).toBe("原文");

    await controller.submitTranscript("改写当前段");
    const rejected = controller.state.preview;
    if (!rejected) throw new Error("Expected second voice rewrite preview");
    expect(bridge.currentAgentSuggestion()?.id).toBe(rejected.id);

    controller.rejectPreview();
    expect(bridge.listAgentSuggestions()).toEqual([]);
    expect(editor.getText()).toBe("原文");
  });
});
