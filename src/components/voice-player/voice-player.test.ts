// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCopilotState } from "../../voice/types";
import type { VoiceCopilotController } from "../../voice/voice-copilot-controller";
import "./voice-player";
import type { VoicePlayer } from "./voice-player";

const state = (overrides: Partial<VoiceCopilotState> = {}): VoiceCopilotState => ({
  phase: "idle",
  documentReady: true,
  transcript: "",
  partialTranscript: "",
  plan: null,
  candidates: [],
  preview: null,
  message: "准备就绪。",
  errorCode: null,
  playback: { active: true, paused: false, paragraphIndex: 2, rate: 1 },
  ...overrides,
});

class FakeVoiceController extends EventTarget {
  state = state();
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  readonly stop = vi.fn();
  readonly read = vi.fn();
  readonly setRate = vi.fn();

  emit(next: VoiceCopilotState) {
    this.state = next;
    this.dispatchEvent(new CustomEvent("state-change", { detail: next }));
  }
}

const find = (player: VoicePlayer, label: string) =>
  player.shadowRoot?.querySelector<HTMLElement>(`[aria-label="${label}"]`);

describe("VoicePlayer", () => {
  let controller: FakeVoiceController;
  let player: VoicePlayer;

  beforeEach(async () => {
    controller = new FakeVoiceController();
    player = document.createElement("top-writer-voice-player") as VoicePlayer;
    player.controller = controller as unknown as VoiceCopilotController;
    document.body.append(player);
    await player.updateComplete;
  });

  it("renders the current paragraph and rate from controller state", () => {
    expect(player.shadowRoot?.textContent).toContain("第 3 段");
    expect(find(player, "朗读速度")).toHaveProperty("value", "1");
  });

  it("calls pause while playing and resume while paused", async () => {
    find(player, "暂停朗读")?.click();
    expect(controller.pause).toHaveBeenCalledOnce();

    controller.emit(state({ playback: { active: true, paused: true, paragraphIndex: 2, rate: 1 } }));
    await player.updateComplete;
    find(player, "继续朗读")?.click();
    expect(controller.resume).toHaveBeenCalledOnce();
  });

  it("calls stop, previous, and next with accessible button names", () => {
    find(player, "停止朗读")?.click();
    find(player, "朗读上一段")?.click();
    find(player, "朗读下一段")?.click();

    expect(controller.stop).toHaveBeenCalledWith();
    expect(controller.read).toHaveBeenNthCalledWith(1, { kind: "previous" });
    expect(controller.read).toHaveBeenNthCalledWith(2, { kind: "next" });
  });

  it("clamps the rate control and announces changes", async () => {
    const rate = find(player, "朗读速度") as HTMLSelectElement;
    rate.value = "2";
    rate.dispatchEvent(new Event("change"));
    await player.updateComplete;

    expect(controller.setRate).toHaveBeenCalledWith(2);
    expect(player.shadowRoot?.querySelector('[aria-live="polite"]')?.textContent).toContain("2 倍速");
  });

  it("is hidden when the document is not ready", async () => {
    controller.emit(state({ documentReady: false }));
    await player.updateComplete;

    expect(player.hidden).toBe(true);
  });
});
