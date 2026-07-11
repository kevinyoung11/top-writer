// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolbarFacade } from "./agent-toolbar";
import "./agent-toolbar";
import type { AgentToolbar } from "./agent-toolbar";

describe("AgentToolbar", () => {
  let facade: AgentToolbarFacade;
  let toolbar: AgentToolbar;

  beforeEach(async () => {
    facade = {
      execute: vi.fn(),
      launchAgent: vi.fn(),
      supports: (command) => command !== "insertTable",
      isEnabled: (command) => command !== "redo",
      isActive: (command) => command === "bold",
      canLaunchAgent: () => true,
    };
    toolbar = document.createElement("top-writer-agent-toolbar") as AgentToolbar;
    toolbar.controller = facade;
    document.body.append(toolbar);
    await toolbar.updateComplete;
  });

  it("uses native named buttons to execute editor commands", () => {
    const bold = toolbar.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label=Bold]")!;
    const redo = toolbar.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label=Redo]")!;

    expect(bold.tagName).toBe("BUTTON");
    expect(bold.getAttribute("aria-pressed")).toBe("true");
    expect(toolbar.shadowRoot?.querySelector("[aria-label=Undo]")?.hasAttribute("aria-pressed")).toBe(false);
    expect(redo.disabled).toBe(true);
    bold.click();

    expect(facade.execute).toHaveBeenCalledWith("bold");
  });

  it("renders optional commands only when the editor facade supports them", async () => {
    expect(toolbar.shadowRoot?.querySelector("[aria-label='Insert table']")).toBeNull();

    facade.supports = () => true;
    toolbar.requestUpdate();
    await toolbar.updateComplete;

    const table = toolbar.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label='Insert table']")!;
    table.click();
    expect(facade.execute).toHaveBeenCalledWith("insertTable");
  });

  it("delegates the accessible AI launch button without calling a model API", () => {
    toolbar.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label='Ask AI']")?.click();

    expect(facade.launchAgent).toHaveBeenCalledOnce();
  });

  it("refreshes enabled state when its injected editor facade changes", async () => {
    facade.isEnabled = () => false;
    toolbar.refreshToken += 1;
    await toolbar.updateComplete;
    expect(toolbar.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label=Bold]")?.disabled).toBe(true);

    facade.isEnabled = () => true;
    toolbar.refreshToken += 1;
    await toolbar.updateComplete;
    expect(toolbar.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label=Bold]")?.disabled).toBe(false);
  });
});
