import { LitElement, css, html, nothing, unsafeCSS } from "lit";
import { customElement, property } from "lit/decorators.js";
import componentCSS from "./agent-toolbar.css?inline";

export type AgentToolbarCommand =
  | "undo"
  | "redo"
  | "zoomOut"
  | "zoomIn"
  | "setParagraph"
  | "setHeading1"
  | "setHeading2"
  | "setHeading3"
  | "blockquote"
  | "bold"
  | "italic"
  | "strike"
  | "underline"
  | "bulletList"
  | "orderedList"
  | "alignLeft"
  | "alignCenter"
  | "alignRight"
  | "alignJustify"
  | "insertTable";

export type AgentToolbarBlockType = "paragraph" | "heading1" | "heading2" | "heading3";

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
  getZoom?(): number;
  getBlockType?(): AgentToolbarBlockType;
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
  { command: "strike", label: "Strike through", text: "S", toggle: true },
  { command: "underline", label: "Underline", text: "U", toggle: true, optional: true },
  { command: "bulletList", label: "Bullet list", text: "•", toggle: true },
  { command: "orderedList", label: "Ordered list", text: "1.", toggle: true },
  { command: "alignLeft", label: "Align left", text: "≡", optional: true },
  { command: "alignCenter", label: "Align center", text: "≡", optional: true },
  { command: "alignRight", label: "Align right", text: "≡", optional: true },
  { command: "alignJustify", label: "Justify text", text: "☰", optional: true },
  { command: "insertTable", label: "Insert table", text: "▦", optional: true },
];

const blockTypes: readonly { value: AgentToolbarBlockType; label: string; command: AgentToolbarCommand }[] = [
  { value: "paragraph", label: "Paragraph", command: "setParagraph" },
  { value: "heading1", label: "Heading 1", command: "setHeading1" },
  { value: "heading2", label: "Heading 2", command: "setHeading2" },
  { value: "heading3", label: "Heading 3", command: "setHeading3" },
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

  private blockTypeChanged(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value as AgentToolbarBlockType;
    const type = blockTypes.find(block => block.value === value);
    if (type) this.invoke(type.command);
  }

  render() {
    return html`
      <nav aria-label="Editor tools">
        <div class="zoom-control" role="group" aria-label="Zoom controls">
          <button type="button" aria-label="Zoom out" ?disabled=${!this.enabled("zoomOut")} @click=${() => this.invoke("zoomOut")}>−</button>
          <output data-zoom-value>${this.controller?.getZoom?.() ?? 100}%</output>
          <button type="button" aria-label="Zoom in" ?disabled=${!this.enabled("zoomIn")} @click=${() => this.invoke("zoomIn")}>+</button>
        </div>
        <label class="block-type-control">
          <span class="sr-only">Block type</span>
          <select aria-label="Block type" .value=${this.controller?.getBlockType?.() ?? "paragraph"} @change=${this.blockTypeChanged}>
            ${blockTypes.map(block => html`<option value=${block.value}>${block.label}</option>`)}
          </select>
        </label>
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
