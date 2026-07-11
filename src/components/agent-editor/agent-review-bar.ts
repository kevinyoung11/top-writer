import { LitElement, css, html, unsafeCSS } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import type { AgentSuggestion } from "../../agent/agent-suggestion-extension";
import componentCSS from "./agent-review-bar.css?inline";

/** The review bar consumes the bridge through this small command facade. */
export interface AgentReviewFacade {
  listAgentSuggestions(): AgentSuggestion[];
  currentAgentSuggestion(): AgentSuggestion | null;
  previousAgentSuggestion(): AgentSuggestion | null;
  nextAgentSuggestion(): AgentSuggestion | null;
  acceptAgentSuggestion(): unknown;
  rejectAgentSuggestion(): unknown;
  acceptAllAgentSuggestions(): unknown;
  rejectAllAgentSuggestions(): unknown;
  close?(): void;
}

@customElement("top-writer-agent-review-bar")
export class AgentReviewBar extends LitElement {
  @property({ attribute: false }) controller: AgentReviewFacade | null = null;
  @property({ type: Number }) refreshToken = 0;
  @state() private currentId: string | null = null;

  protected willUpdate(changed: Map<PropertyKey, unknown>) {
    if (changed.has("controller") || changed.has("refreshToken")) this.syncCurrent();
  }

  private suggestions() {
    return this.controller?.listAgentSuggestions() ?? [];
  }

  private syncCurrent() {
    this.currentId = this.controller?.currentAgentSuggestion()?.id ?? null;
  }

  private currentIndex(suggestions: AgentSuggestion[]) {
    return Math.max(0, suggestions.findIndex((item) => item.id === this.currentId));
  }

  private act(action: () => unknown) {
    action();
    this.syncCurrent();
    this.requestUpdate();
  }

  /**
   * Review shortcuts deliberately live on the review region rather than the
   * editor or document. That keeps ordinary typing, browser shortcuts, and
   * the native keyboard behavior of the action buttons untouched.
   */
  private reviewKeydown(event: KeyboardEvent) {
    if (
      event.target !== event.currentTarget ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !this.controller ||
      !this.currentId
    ) return;

    const action = {
      ArrowLeft: () => this.controller?.previousAgentSuggestion(),
      ArrowRight: () => this.controller?.nextAgentSuggestion(),
      a: () => this.controller?.acceptAgentSuggestion(),
      r: () => this.controller?.rejectAgentSuggestion(),
    }[event.key];
    if (!action) return;

    event.preventDefault();
    this.act(action);
  }

  render() {
    const suggestions = this.suggestions();
    const hasCurrent = this.currentId !== null && suggestions.length > 0;
    const index = this.currentIndex(suggestions);
    const count = hasCurrent ? `${index + 1} of ${suggestions.length}` : "0 of 0";
    const disabled = !this.controller || !hasCurrent;

    return html`
      <section
        aria-label="AI suggestion review"
        aria-keyshortcuts="ArrowLeft ArrowRight A R"
        tabindex="0"
        @keydown=${this.reviewKeydown}
      >
        <div class="count" aria-live="polite">Suggestion ${count}</div>
        <div class="navigation" role="group" aria-label="Suggestion navigation">
          <button type="button" aria-label="Previous suggestion" ?disabled=${disabled}
            @click=${() => this.act(() => this.controller?.previousAgentSuggestion())}>‹</button>
          <button type="button" aria-label="Next suggestion" ?disabled=${disabled}
            @click=${() => this.act(() => this.controller?.nextAgentSuggestion())}>›</button>
        </div>
        <div class="decisions" role="group" aria-label="Suggestion decisions">
          <button type="button" aria-label="Accept suggestion" ?disabled=${disabled}
            @click=${() => this.act(() => this.controller?.acceptAgentSuggestion())}>Accept</button>
          <button type="button" aria-label="Reject suggestion" ?disabled=${disabled}
            @click=${() => this.act(() => this.controller?.rejectAgentSuggestion())}>Reject</button>
          <button type="button" aria-label="Accept all suggestions" ?disabled=${disabled}
            @click=${() => this.act(() => this.controller?.acceptAllAgentSuggestions())}>Accept all</button>
          <button type="button" aria-label="Reject all suggestions" ?disabled=${disabled}
            @click=${() => this.act(() => this.controller?.rejectAllAgentSuggestions())}>Reject all</button>
        </div>
        <button class="close" type="button" aria-label="Close review" ?disabled=${!this.controller?.close}
          @click=${() => this.controller?.close?.()}>×</button>
      </section>
    `;
  }

  static styles = css`${unsafeCSS(componentCSS)}`;
}

declare global {
  interface HTMLElementTagNameMap {
    "top-writer-agent-review-bar": AgentReviewBar;
  }
}
