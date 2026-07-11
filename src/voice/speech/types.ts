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

export interface SpeechVoiceOption {
  readonly voiceURI: string;
  readonly name: string;
  readonly lang: string;
  readonly default: boolean;
}

export interface SpeechVoiceCatalog {
  readonly voices: readonly SpeechVoiceOption[];
  subscribeVoicesChanged(
    listener: (voices: readonly SpeechVoiceOption[]) => void,
  ): () => void;
}

const canonicalLocale = (value: string) =>
  value.trim().replace(/_/g, "-").toLowerCase();

/** Return voices for a language and, when supplied, its exact region. */
export const filterVoicesForLanguage = (
  voices: readonly SpeechVoiceOption[],
  language: string,
): SpeechVoiceOption[] => {
  const target = canonicalLocale(language).split("-").filter(Boolean);
  const base = target[0];
  const region = target.slice(1).find((part) => /^[a-z]{2}$/u.test(part));
  if (!base) return [];

  return voices.filter((voice) => {
    const parts = canonicalLocale(voice.lang).split("-").filter(Boolean);
    if (parts[0] !== base) return false;
    return region ? parts.includes(region) : true;
  });
};
