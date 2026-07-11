/** @vitest-environment jsdom */

import "fake-indexeddb/auto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCopilotController } from "../../voice/voice-copilot-controller";
import type { VoiceCopilotState } from "../../voice/types";

class WorkerStub extends EventTarget {
  onerror: ((this: Worker, ev: ErrorEvent) => unknown) | null = null;
  onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null = null;
  onmessageerror: ((this: Worker, ev: MessageEvent) => unknown) | null = null;

  postMessage() {}
  terminate() {}
}

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    }
  };
}

const state = (phase: VoiceCopilotState["phase"]): VoiceCopilotState => ({
  phase,
  documentReady: true,
  transcript: "",
  partialTranscript: "",
  plan: null,
  candidates: [],
  preview: null,
  message: "准备就绪。",
  errorCode: null,
  playback: { active: false, paused: false, paragraphIndex: null, rate: 1 }
});

class FakeController extends EventTarget {
  state = state("idle");
  cancel = vi.fn();
  destroy = vi.fn();
}

type WordflowElement = HTMLElement & {
  updateComplete: Promise<boolean>;
  voiceController: VoiceCopilotController | null;
  requestUpdate(): void;
};
type WordflowElementConstructor = CustomElementConstructor & {
  new (): WordflowElement;
};

describe("wordflow voice entry", () => {
  let WordflowWordflow: WordflowElementConstructor;
  let root: WordflowElement;

  beforeAll(async () => {
    vi.stubGlobal("localStorage", createMemoryStorage());
    vi.stubGlobal("Worker", WorkerStub);
    (
      globalThis as typeof globalThis & { litIssuedWarnings: Set<string> }
    ).litIssuedWarnings = new Set(["dev-mode"]);
    const modulePath = "./wordflow";
    const module = (await import(/* @vite-ignore */ modulePath)) as {
      WordflowWordflow: WordflowElementConstructor;
    };
    WordflowWordflow = module.WordflowWordflow;
  });

  beforeEach(async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        headers: { get: () => null },
        json: async () => []
      })
    );
    document.body.replaceChildren();
    root = document.createElement("wordflow-wordflow") as WordflowElement;
    document.body.append(root);
    await root.updateComplete;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the named rail entry closed by default", () => {
    const trigger = root.shadowRoot?.querySelector<HTMLButtonElement>(
      "[data-voice-entry]"
    );

    expect(trigger?.getAttribute("aria-label")).toBe("语音副驾");
    expect(trigger?.getAttribute("aria-expanded")).toBe("false");
    expect(trigger?.getAttribute("aria-controls")).toBe("voice-copilot-drawer");
    expect(root.shadowRoot?.querySelector("#voice-copilot-drawer")).toBeNull();
  });

  it("opens and closes the named drawer while restoring trigger focus", async () => {
    const trigger = root.shadowRoot?.querySelector<HTMLButtonElement>(
      "[data-voice-entry]"
    )!;

    trigger.click();
    await root.updateComplete;
    expect(root.shadowRoot?.querySelector("#voice-copilot-drawer")).not.toBeNull();

    root.shadowRoot
      ?.querySelector<HTMLButtonElement>("[aria-label='关闭语音副驾']")
      ?.click();
    await root.updateComplete;
    expect(root.shadowRoot?.querySelector("#voice-copilot-drawer")).toBeNull();
    expect(root.shadowRoot?.activeElement).toBe(trigger);
  });

  it.each([
    ["Escape", "keydown"],
    ["backdrop", "click"]
  ] as const)("closes the drawer from %s", async (_method, eventName) => {
    root.shadowRoot
      ?.querySelector<HTMLButtonElement>("[data-voice-entry]")
      ?.click();
    await root.updateComplete;
    expect(root.shadowRoot?.querySelector("#voice-copilot-drawer")).not.toBeNull();

    if (eventName === "keydown") {
      root.shadowRoot
        ?.querySelector("#voice-copilot-drawer")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    } else {
      root.shadowRoot
        ?.querySelector(".voice-drawer-backdrop")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    await root.updateComplete;
    expect(root.shadowRoot?.querySelector("#voice-copilot-drawer")).toBeNull();
  });

  it("reuses the existing controller and only cancels an active listening session", async () => {
    const controller = new FakeController();
    root.voiceController = controller as unknown as VoiceCopilotController;
    root.requestUpdate();
    await root.updateComplete;

    root.shadowRoot
      ?.querySelector<HTMLButtonElement>("[data-voice-entry]")
      ?.click();
    await root.updateComplete;
    const panel = root.shadowRoot?.querySelector("top-writer-voice-copilot") as
      | (HTMLElement & { controller: VoiceCopilotController | null })
      | null;
    expect(panel?.controller).toBe(controller);

    root.shadowRoot
      ?.querySelector<HTMLButtonElement>("[aria-label='关闭语音副驾']")
      ?.click();
    await root.updateComplete;
    expect(controller.cancel).not.toHaveBeenCalled();

    controller.state = state("listening");
    root.shadowRoot
      ?.querySelector<HTMLButtonElement>("[data-voice-entry]")
      ?.click();
    await root.updateComplete;
    root.shadowRoot
      ?.querySelector<HTMLButtonElement>("[aria-label='关闭语音副驾']")
      ?.click();
    expect(controller.cancel).toHaveBeenCalledOnce();
  });
});
