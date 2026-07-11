import { LitElement, css, html, unsafeCSS, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import componentCSS from "./voice-player.css?inline";
import {
  createInitialVoiceState,
  type VoiceCopilotController,
} from "../../voice/voice-copilot-controller";
import type { VoiceCopilotState } from "../../voice/types";

const clampRate = (rate: number) => Math.max(0.5, Math.min(2, rate));

@customElement("top-writer-voice-player")
export class VoicePlayer extends LitElement {
  @property({ attribute: false }) controller: VoiceCopilotController | null = null;

  @state() private voiceState = createInitialVoiceState();

  private readonly onStateChange = (event: Event) => {
    const detail = (event as CustomEvent<VoiceCopilotState>).detail;
    if (!detail) return;
    this.voiceState = detail;
    this.hidden = !detail.documentReady;
  };

  connectedCallback(): void {
    super.connectedCallback();
    this.bindController();
  }

  disconnectedCallback(): void {
    this.unbindController(this.controller);
    super.disconnectedCallback();
  }

  willUpdate(changed: PropertyValues<this>): void {
    if (!changed.has("controller") || !this.isConnected) return;
    this.unbindController(changed.get("controller") as VoiceCopilotController | null);
    this.bindController();
  }

  private bindController(): void {
    if (!this.controller) return;
    this.voiceState = this.controller.state;
    this.hidden = !this.voiceState.documentReady;
    this.controller.addEventListener("state-change", this.onStateChange);
  }

  private unbindController(controller: VoiceCopilotController | null): void {
    controller?.removeEventListener("state-change", this.onStateChange);
  }

  private togglePlayback(): void {
    if (!this.controller) return;
    if (this.voiceState.playback.active) {
      if (this.voiceState.playback.paused) this.controller.resume();
      else this.controller.pause();
      return;
    }
    void this.controller.read({ kind: "current" });
  }

  private changeRate(event: Event): void {
    if (!this.controller) return;
    const requested = Number((event.currentTarget as HTMLSelectElement).value);
    const rate = clampRate(Number.isFinite(requested) ? requested : 1);
    this.controller.setRate(rate);
    this.voiceState = {
      ...this.voiceState,
      playback: { ...this.voiceState.playback, rate },
    };
  }

  private playbackLabel(): string {
    const { active, paused } = this.voiceState.playback;
    if (!active) return "朗读当前段落";
    return paused ? "继续朗读" : "暂停朗读";
  }

  private statusText(): string {
    const { active, paused, paragraphIndex, rate } = this.voiceState.playback;
    const paragraph = paragraphIndex === null ? "当前段落" : `第 ${paragraphIndex + 1} 段`;
    if (active) return `${paused ? "已暂停" : "正在朗读"}${paragraph}，${rate} 倍速。`;
    return `${paragraph}，${rate} 倍速。`;
  }

  render() {
    const playback = this.voiceState.playback;
    return html`
      <section aria-label="朗读控制" ?hidden=${!this.voiceState.documentReady}>
        <div class="scope" aria-live="polite">${this.statusText()}</div>
        <div class="controls">
          <button type="button" aria-label="朗读上一段" @click=${() => void this.controller?.read({ kind: "previous" })}>上一段</button>
          <button
            type="button"
            aria-label=${this.playbackLabel()}
            aria-pressed=${String(playback.active && playback.paused)}
            @click=${this.togglePlayback}
          >${playback.active && !playback.paused ? "暂停" : "朗读"}</button>
          <button type="button" aria-label="朗读下一段" @click=${() => void this.controller?.read({ kind: "next" })}>下一段</button>
          <button type="button" aria-label="停止朗读" ?disabled=${!playback.active} @click=${() => this.controller?.stop()}>停止</button>
          <label>速度
            <select aria-label="朗读速度" .value=${String(playback.rate)} @change=${this.changeRate}>
              <option value="0.5">0.5×</option>
              <option value="0.75">0.75×</option>
              <option value="1">1×</option>
              <option value="1.25">1.25×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2×</option>
            </select>
          </label>
        </div>
      </section>
    `;
  }

  static styles = css`${unsafeCSS(componentCSS)}`;
}

declare global {
  interface HTMLElementTagNameMap {
    "top-writer-voice-player": VoicePlayer;
  }
}
