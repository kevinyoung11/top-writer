/** @vitest-environment jsdom */

import "fake-indexeddb/auto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
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

let observerCallback: ResizeObserverCallback | undefined;
let resizeObserverInstances: ResizeObserverStub[] = [];

class ResizeObserverStub {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();

  constructor(callback: ResizeObserverCallback) {
    observerCallback = callback;
    resizeObserverInstances.push(this);
  }
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
    vi.stubGlobal("ResizeObserver", ResizeObserverStub);
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: () => false
    });
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
    observerCallback = undefined;
    resizeObserverInstances = [];
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

  it("moves focus to the voice panel heading when the drawer opens", async () => {
    root.shadowRoot
      ?.querySelector<HTMLButtonElement>("[data-voice-entry]")
      ?.click();
    await root.updateComplete;
    const panel = root.shadowRoot?.querySelector("top-writer-voice-copilot") as
      | (HTMLElement & { updateComplete: Promise<boolean> })
      | null;
    await panel?.updateComplete;
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(panel?.shadowRoot?.activeElement?.textContent).toBe("语音副驾");
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
      const panel = root.shadowRoot?.querySelector("top-writer-voice-copilot");
      const input = panel?.shadowRoot?.querySelector<HTMLInputElement>("input");
      input?.focus();
      input?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          composed: true
        })
      );
    } else {
      root.shadowRoot
        ?.querySelector(".voice-drawer-backdrop")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }

    await root.updateComplete;
    expect(root.shadowRoot?.querySelector("#voice-copilot-drawer")).toBeNull();
  });

  it("traps composed Tab and Shift+Tab within the voice drawer", async () => {
    root.shadowRoot
      ?.querySelector<HTMLButtonElement>("[data-voice-entry]")
      ?.click();
    await root.updateComplete;
    const close = root.shadowRoot?.querySelector<HTMLButtonElement>(
      "[aria-label='关闭语音副驾']"
    )!;
    const panel = root.shadowRoot?.querySelector("top-writer-voice-copilot");
    const send = panel?.shadowRoot?.querySelector<HTMLButtonElement>(
      "button[type=submit]"
    )!;

    send.focus();
    send.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true })
    );
    expect(root.shadowRoot?.activeElement).toBe(close);

    close.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Tab",
        shiftKey: true,
        bubbles: true,
        composed: true
      })
    );
    expect(panel?.shadowRoot?.activeElement).toBe(send);
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

  it("publishes the measured player height as a root CSS variable", async () => {
    const controller = new FakeController();
    root.voiceController = controller as unknown as VoiceCopilotController;
    root.requestUpdate();
    await root.updateComplete;

    const player = root.shadowRoot?.querySelector("top-writer-voice-player")!;
    const observer = resizeObserverInstances.at(-1)!;
    expect(observer.observe).toHaveBeenCalledWith(player);

    observerCallback?.(
      [{ contentRect: { height: 84 } } as ResizeObserverEntry],
      observer as unknown as ResizeObserver
    );

    const centerPanel = root.shadowRoot?.querySelector<HTMLElement>(".center-panel");
    expect(centerPanel?.style.getPropertyValue("--voice-player-height")).toBe("84px");
  });

  it("disconnects the player observer when the root is removed", async () => {
    const controller = new FakeController();
    root.voiceController = controller as unknown as VoiceCopilotController;
    root.requestUpdate();
    await root.updateComplete;
    const observer = resizeObserverInstances.at(-1)!;

    root.remove();

    expect(observer.disconnect).toHaveBeenCalledOnce();
  });

  it("ships responsive drawer breakpoints without retaining desktop rails on mobile", async () => {
    const [wordflowCSS, editorCSS, playerCSS] = await Promise.all([
      readFile(resolve(process.cwd(), "src/components/wordflow/wordflow.css"), "utf8"),
      readFile(resolve(process.cwd(), "src/components/text-editor/text-editor.css"), "utf8"),
      readFile(resolve(process.cwd(), "src/components/voice-player/voice-player.css"), "utf8")
    ]);

    expect(wordflowCSS).toContain("@media (min-width: 1100px)");
    expect(wordflowCSS).toContain("width: clamp(320px, 26vw, 400px)");
    expect(wordflowCSS).toContain("@media (min-width: 700px) and (max-width: 1099px)");
    expect(wordflowCSS).toContain("@media (max-width: 699px)");
    expect(wordflowCSS).toContain("grid-template-columns: 0 minmax(0, 1fr) 0");
    expect(wordflowCSS).toContain("inset: auto 0 var(--voice-player-height, 72px) 0");
    expect(wordflowCSS).toContain("100dvh");
    expect(wordflowCSS).toContain("env(safe-area-inset-bottom)");
    expect(editorCSS).toContain("padding: 60px 16px");
    expect(editorCSS).toContain("var(--voice-player-height, 72px)");
    expect(playerCSS).toContain("env(safe-area-inset-bottom)");
  });
});
