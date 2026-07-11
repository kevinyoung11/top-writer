import type { VoiceRange } from "../types";

export interface RecognitionHandlers {
  onStart(): void;
  onPartial(text: string): void;
  onFinal(text: string): void;
  onEnd(): void;
  onError(
    code:
      | "no-speech"
      | "permission-denied"
      | "audio-capture"
      | "network"
      | "language-not-supported"
      | "service-not-allowed"
      | "aborted"
      | "unknown",
  ): void;
}

export interface SpeechRecognizer {
  readonly supported: boolean;
  start(language: string, handlers: RecognitionHandlers): void;
  stop(): void;
  cancel(): void;
}

export interface SpeechChunk {
  text: string;
  range: VoiceRange;
}

export interface SynthesisOptions {
  language: string;
  rate: number;
  voiceURI: string | null;
  onChunkStart(chunk: SpeechChunk): void;
  onError(code: "synthesis-failed" | "cancelled"): void;
}

export interface SpeechSynthesizer {
  readonly supported: boolean;
  speak(chunks: SpeechChunk[], options: SynthesisOptions): Promise<void>;
  pause(): void;
  resume(): void;
  cancel(): void;
}
