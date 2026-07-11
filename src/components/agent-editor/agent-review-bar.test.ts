// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentReviewFacade } from "./agent-review-bar";
import "./agent-review-bar";
import type { AgentReviewBar } from "./agent-review-bar";

const suggestion = (id: string) => ({
  id,
  operation: {
    id,
    type: "replaceRange" as const,
    revision: 1,
    from: 1,
    to: 2,
    originalTextHash: "a".repeat(64),
    replacement: "new",
  },
});

describe("AgentReviewBar", () => {
  let facade: AgentReviewFacade;
  let reviewBar: AgentReviewBar;

  beforeEach(async () => {
    const suggestions = [suggestion("one"), suggestion("two")];
    let current = suggestions[0];
    facade = {
      listAgentSuggestions: vi.fn(() => suggestions),
      currentAgentSuggestion: vi.fn(() => current),
      previousAgentSuggestion: vi.fn(() => (current = suggestions[1])),
      nextAgentSuggestion: vi.fn(() => (current = suggestions[1])),
      acceptAgentSuggestion: vi.fn(),
      rejectAgentSuggestion: vi.fn(),
      acceptAllAgentSuggestions: vi.fn(),
      rejectAllAgentSuggestions: vi.fn(),
      close: vi.fn(),
    };
    reviewBar = document.createElement("top-writer-agent-review-bar") as AgentReviewBar;
    reviewBar.controller = facade;
    document.body.append(reviewBar);
    await reviewBar.updateComplete;
  });

  it("announces the current suggestion count and navigates with named buttons", async () => {
    expect(reviewBar.shadowRoot?.querySelector("[aria-live=polite]")?.textContent).toContain("1 of 2");

    reviewBar.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label='Next suggestion']")?.click();
    await reviewBar.updateComplete;

    expect(facade.nextAgentSuggestion).toHaveBeenCalledOnce();
    expect(reviewBar.shadowRoot?.querySelector("[aria-live=polite]")?.textContent).toContain("2 of 2");
  });

  it("delegates current and all-item review decisions", () => {
    reviewBar.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label='Accept suggestion']")?.click();
    reviewBar.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label='Reject suggestion']")?.click();
    reviewBar.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label='Accept all suggestions']")?.click();
    reviewBar.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label='Reject all suggestions']")?.click();
    reviewBar.shadowRoot?.querySelector<HTMLButtonElement>("[aria-label='Close review']")?.click();

    expect(facade.acceptAgentSuggestion).toHaveBeenCalledOnce();
    expect(facade.rejectAgentSuggestion).toHaveBeenCalledOnce();
    expect(facade.acceptAllAgentSuggestions).toHaveBeenCalledOnce();
    expect(facade.rejectAllAgentSuggestions).toHaveBeenCalledOnce();
    expect(facade.close).toHaveBeenCalledOnce();
  });

  it("disables review actions when no current suggestion is available", async () => {
    facade.listAgentSuggestions = vi.fn(() => []);
    facade.currentAgentSuggestion = vi.fn(() => null);
    reviewBar.refreshToken += 1;
    await reviewBar.updateComplete;

    for (const label of [
      "Previous suggestion",
      "Next suggestion",
      "Accept suggestion",
      "Reject suggestion",
      "Accept all suggestions",
      "Reject all suggestions",
    ]) {
      expect(reviewBar.shadowRoot?.querySelector<HTMLButtonElement>(`[aria-label='${label}']`)?.disabled).toBe(true);
    }
  });
});
