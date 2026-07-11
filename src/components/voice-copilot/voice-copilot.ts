import { LitElement, css, html, unsafeCSS, type PropertyValues } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import componentCSS from "./voice-copilot.css?inline";
import type { VoicePreferencesStore } from "../../voice/preferences";
import type { VoiceCopilotController } from "../../voice/voice-copilot-controller";
import type { VoiceCopilotState } from "../../voice/types";

@customElement("top-writer-voice-copilot")
export class VoiceCopilotPanel extends LitElement {
  @property({ attribute: false }) controller: VoiceCopilotController | null = null;
  @property({ attribute: false }) preferences: VoicePreferencesStore | null = null;
  @state() private voiceState: VoiceCopilotState | null = null;
  @state() private showPrivacyNotice = false;
  private readonly onState = (event: Event) => { this.voiceState = (event as CustomEvent<VoiceCopilotState>).detail; };
  connectedCallback() { super.connectedCallback(); this.bind(this.controller); }
  disconnectedCallback() { this.unbind(this.controller); super.disconnectedCallback(); }
  willUpdate(changed: PropertyValues<this>) { if (changed.has("controller") && this.isConnected) { this.unbind(changed.get("controller") as VoiceCopilotController | null); this.bind(this.controller); } }
  private bind(controller: VoiceCopilotController | null) { if (!controller) return; this.voiceState = controller.state; controller.addEventListener("state-change", this.onState); }
  private unbind(controller: VoiceCopilotController | null) { controller?.removeEventListener("state-change", this.onState); }
  private submit(event: SubmitEvent) { event.preventDefault(); const form = event.currentTarget as HTMLFormElement; const value = new FormData(form).get("command"); const text = typeof value === "string" ? value.trim() : ""; if (text) void this.controller?.submitTranscript(text); form.reset(); }
  private mic() { const phase = this.voiceState?.phase; if (phase === "listening") this.controller?.stopListening(); else if (phase && phase !== "idle" && phase !== "error" && phase !== "applied") this.controller?.cancel(); else if (this.preferences?.value.privacyNoticeAccepted) this.controller?.startListening(); else this.showPrivacyNotice = true; }
  private acceptPrivacy() { this.preferences?.update({ privacyNoticeAccepted: true }); this.showPrivacyNotice = false; this.controller?.startListening(); }
  private preview() { const preview = this.voiceState?.preview; if (!preview) return null; const undo = preview.mode === "undo"; return html`<section class="preview" aria-label="改写预览"><h2 tabindex="-1">${undo ? "撤回预览" : "改写预览"}</h2><p><del>${preview.originalText}</del></p><p><ins>${preview.replacementText}</ins></p>${preview.segments.map(s => s.kind === "delete" ? html`<del>${s.text}</del>` : s.kind === "insert" ? html`<ins>${s.text}</ins>` : html`<span>${s.text}</span>`)}<div><button aria-label="朗读原文" @click=${() => void this.controller?.speakOriginal()}>朗读原文</button><button aria-label="朗读新版" @click=${() => void this.controller?.speakReplacement()}>朗读新版</button>${undo ? html`<button aria-label="确认撤回" @click=${() => this.controller?.confirmUndo()}>确认撤回</button>` : html`<button aria-label="应用改写" @click=${() => this.controller?.confirmPreview()}>应用</button>`}<button aria-label="保留原文" @click=${() => this.controller?.rejectPreview()}>${undo ? "取消" : "保留原文"}</button></div></section>`; }
  render() { const state = this.voiceState; const active = state?.phase === "listening"; const candidates = state?.phase === "clarifying" ? state.candidates.slice(0, 3) : []; return html`<section aria-label="语音副驾"><h1>语音副驾</h1><p aria-live="polite">${state?.message ?? "准备就绪。"}</p><button aria-label=${active ? "结束语音指令" : "开始语音指令"} @click=${this.mic}>${active ? "结束语音" : "开始语音"}</button>${this.showPrivacyNotice ? html`<section role="dialog" aria-label="语音隐私说明"><p>Chrome 可能将本次音频发送给其语音识别服务商；Top Writer 不保存原始音频；文字指令始终可用。</p><button aria-label="同意语音隐私说明" @click=${this.acceptPrivacy}>同意并开始</button><button @click=${() => this.showPrivacyNotice = false}>取消</button></section>` : null}<form @submit=${this.submit}><label>文字指令<input name="command" autocomplete="off" placeholder="例如：朗读这一段" /></label><button type="submit">发送</button></form>${candidates.length ? html`<section aria-label="选择目标段落"><h2 tabindex="-1">请选择要操作的段落</h2>${candidates.map((candidate, index) => html`<button data-candidate @click=${() => void this.controller?.chooseCandidate(index)}>第 ${candidate.range.paragraphIndexes[0] + 1} 段：${candidate.range.text}</button>`)}</section>` : null}${state?.phase === "preview" ? this.preview() : null}${state?.phase === "applied" ? html`<button aria-label="撤回刚才改动" @click=${() => this.controller?.requestUndo()}>撤回刚才改动</button>` : null}</section>`; }
  static styles = css`${unsafeCSS(componentCSS)}`;
}
declare global { interface HTMLElementTagNameMap { "top-writer-voice-copilot": VoiceCopilotPanel; } }
