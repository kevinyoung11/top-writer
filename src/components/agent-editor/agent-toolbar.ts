import { LitElement, css, html, nothing, unsafeCSS } from "lit";
import { customElement, property } from "lit/decorators.js";
import componentCSS from "./agent-toolbar.css?inline";

export type AgentToolbarCommand =
  | "undo"
  | "redo"
  | "blockquote"
  | "bold"
  | "italic"
  | "underline"
  | "bulletList"
  | "orderedList"
  | "alignLeft"
  | "insertTable";

/**
 * View-level adapter for editor commands and the agent session entry point.
 * Keeping this interface deliberately small prevents the toolbar from owning
 * either a Tiptap instance or any model/provider credentials.
 */
export interface AgentToolbarFacade {
  execute(command: AgentToolbarCommand): void;
  launchAgent(): void;
  supports?(command: AgentToolbarCommand): boolean;
  isEnabled?(command: AgentToolbarCommand): boolean;
  isActive?(command: AgentToolbarCommand): boolean;
  canLaunchAgent?(): boolean;
}

interface ToolbarButton {
  command: AgentToolbarCommand;
  label: string;
  text: string;
  toggle?: boolean;
  optional?: boolean;
}

const buttons: readonly ToolbarButton[] = [
  { command: "undo", label: "Undo", text: "↶" },
  { command: "redo", label: "Redo", text: "↷" },
  { command: "blockquote", label: "Block quote", text: "❝", toggle: true },
  { command: "bold", label: "Bold", text: "B", toggle: true },
  { command: "italic", label: "Italic", text: "I", toggle: true },
  { command: "underline", label: "Underline", text: "U", toggle: true, optional: true },
  { command: "bulletList", label: "Bullet list", text: "•", toggle: true },
  { command: "orderedList", label: "Ordered list", text: "1.", toggle: true },
  { command: "alignLeft", label: "Align left", text: "≡", optional: true },
  { command: "insertTable", label: "Insert table", text: "▦", optional: true },
];

@customElement("top-writer-agent-toolbar")
export class AgentToolbar extends LitElement {
  @property({ attribute: false }) controller: AgentToolbarFacade | null = null;
  /** Incremented by the host after editor transactions such as typing or selection changes. */
  @property({ type: Number }) refreshToken = 0;

  private supports(button: ToolbarButton) {
    if (!button.optional) return true;
    return this.controller?.supports?.(button.command) ?? false;
  }

  private enabled(command: AgentToolbarCommand) {
    return Boolean(this.controller) && (this.controller?.isEnabled?.(command) ?? true);
  }

  private invoke(command: AgentToolbarCommand) {
    this.controller?.execute(command);
  }

  render() {
    return html`
      <nav aria-label="Editor tools">
        <div class="command-group" role="group" aria-label="Formatting tools">
          ${buttons.filter((button) => this.supports(button)).map((button) => html`
            <button
              type="button"
              aria-label=${button.label}
              aria-pressed=${button.toggle
                ? this.controller?.isActive?.(button.command) ? "true" : "false"
                : nothing}
              ?disabled=${!this.enabled(button.command)}
              @click=${() => this.invoke(button.command)}
            >${button.text}</button>
          `)}
        </div>
        <button
          class="agent-launch"
          type="button"
          aria-label="Ask AI"
          ?disabled=${!this.controller || !(this.controller.canLaunchAgent?.() ?? true)}
          @click=${() => this.controller?.launchAgent()}
        ><span aria-hidden="true">✦</span> AI</button>
      </nav>
    `;
  }

  static styles = css`${unsafeCSS(componentCSS)}`;
}

declare global {
  interface HTMLElementTagNameMap {
    "top-writer-agent-toolbar": AgentToolbar;
  }
}
