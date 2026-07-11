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

  it("offers the Agent Editor zoom, block type, and full open-source formatting controls", async () => {
    facade.supports = () => true;
    toolbar.requestUpdate();
    await toolbar.updateComplete;
    const root = toolbar.shadowRoot!;

    expect(root.querySelector<HTMLButtonElement>("[aria-label='Zoom out']")?.textContent).toBe("−");
    expect(root.querySelector("[data-zoom-value]")?.textContent).toContain("100%");
    expect(root.querySelector<HTMLButtonElement>("[aria-label='Zoom in']")?.textContent).toBe("+");

    const blockType = root.querySelector<HTMLSelectElement>("[aria-label='Block type']")!;
    expect(Array.from(blockType.options, option => option.value)).toEqual([
      "paragraph",
      "heading1",
      "heading2",
      "heading3"
    ]);
    blockType.value = "heading1";
    blockType.dispatchEvent(new Event("change"));

    for (const label of [
      "Bold",
      "Italic",
      "Strike through",
      "Underline",
      "Align left",
      "Align center",
      "Align right",
      "Bullet list",
      "Ordered list",
      "Insert table"
    ]) {
      expect(root.querySelector(`[aria-label='${label}']`)).not.toBeNull();
    }

    root.querySelector<HTMLButtonElement>("[aria-label='Zoom in']")?.click();
    root.querySelector<HTMLButtonElement>("[aria-label='Strike through']")?.click();

    expect(facade.execute).toHaveBeenCalledWith("setHeading1");
    expect(facade.execute).toHaveBeenCalledWith("zoomIn");
    expect(facade.execute).toHaveBeenCalledWith("strike");
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
