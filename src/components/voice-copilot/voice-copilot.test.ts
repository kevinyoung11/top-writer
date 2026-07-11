// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCopilotController } from "../../voice/voice-copilot-controller";
import type { VoiceCopilotState } from "../../voice/types";
import { VoicePreferencesStore } from "../../voice/preferences";
import "./voice-copilot";
import type { VoiceCopilotPanel } from "./voice-copilot";

const state = (overrides: Partial<VoiceCopilotState> = {}): VoiceCopilotState => ({
  phase: "idle", documentReady: true, transcript: "", partialTranscript: "", plan: null,
  candidates: [], preview: null, message: "准备就绪。", errorCode: null,
  playback: { active: false, paused: false, paragraphIndex: null, rate: 1 }, ...overrides,
});
class FakeController extends EventTarget {
  state = state(); startListening = vi.fn(); stopListening = vi.fn(); cancel = vi.fn();
  submitTranscript = vi.fn(); chooseCandidate = vi.fn(); confirmPreview = vi.fn(); rejectPreview = vi.fn();
  requestUndo = vi.fn(); confirmUndo = vi.fn(); speakOriginal = vi.fn(); speakReplacement = vi.fn();
  emit(next: VoiceCopilotState) { this.state = next; this.dispatchEvent(new CustomEvent("state-change", { detail: next })); }
}
describe("VoiceCopilotPanel", () => {
  let controller: FakeController; let panel: VoiceCopilotPanel;
  beforeEach(async () => { controller = new FakeController(); panel = document.createElement("top-writer-voice-copilot") as VoiceCopilotPanel; panel.controller = controller as unknown as VoiceCopilotController; panel.preferences = new VoicePreferencesStore(null); document.body.append(panel); await panel.updateComplete; });
  it("keeps a text command fallback and submits trimmed input", async () => {
    const input = panel.shadowRoot?.querySelector<HTMLInputElement>("input[name=command]")!;
    input.value = "  朗读这一段  "; panel.shadowRoot?.querySelector<HTMLFormElement>("form")?.requestSubmit();
    expect(controller.submitTranscript).toHaveBeenCalledWith("朗读这一段");
  });
  it("requires explicit speech privacy acceptance before listening", async () => {
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label=开始语音指令]")?.click();
    await panel.updateComplete;
    expect(controller.startListening).not.toHaveBeenCalled();
    expect(panel.shadowRoot?.textContent).toContain("Chrome 可能将本次音频发送给其语音识别服务商");
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label=同意语音隐私说明]")?.click();
    expect(controller.startListening).toHaveBeenCalledOnce();
    expect(panel.preferences?.value.privacyNoticeAccepted).toBe(true);
  });
  it("requires confirmation before applying a rewrite preview", async () => {
    controller.emit(state({ phase: "preview", preview: { id: "p", revision: 1, range: { revision: 1, from: 1, to: 2, text: "旧", paragraphIndexes: [0], block: false }, originalText: "旧", replacementText: "新", segments: [{ kind: "delete", text: "旧" }, { kind: "insert", text: "新" }], mode: "rewrite" } })); await panel.updateComplete;
    expect(panel.shadowRoot?.textContent).toContain("应用");
    panel.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label=应用改写]")?.click();
    expect(controller.confirmPreview).toHaveBeenCalledOnce();
  });
  it("renders at most three clarification choices and delegates the original index", async () => {
    const candidate = (index: number) => ({ range: { revision: 1, from: index, to: index + 1, text: `段${index}`, paragraphIndexes: [index], block: false }, score: 1, reason: "匹配" });
    controller.emit(state({ phase: "clarifying", candidates: [candidate(0), candidate(1), candidate(2), candidate(3)] })); await panel.updateComplete;
    const choices = panel.shadowRoot?.querySelectorAll("[data-candidate]") ?? [];
    expect(choices).toHaveLength(3); (choices[1] as HTMLButtonElement).click();
    expect(controller.chooseCandidate).toHaveBeenCalledWith(1);
  });
});
