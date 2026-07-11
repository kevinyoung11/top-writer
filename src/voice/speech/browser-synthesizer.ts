import type { VoiceRange } from "../types";
import type { SpeechChunk, SpeechSynthesizer, SynthesisOptions } from "./types";

const SENTENCE_ENDINGS = new Set(["。", "！", "？", "!", "?", "；", ";"]);
const VOICE_WAIT_TIMEOUT_MS = 1000;

type UtteranceConstructor = new (text?: string) => SpeechSynthesisUtterance;

interface SpeechSynthesisLike {
  getVoices(): SpeechSynthesisVoice[];
  speak(utterance: SpeechSynthesisUtterance): void;
  pause(): void;
  resume(): void;
  cancel(): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void;
  removeEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
  ): void;
}

interface BrowserSpeechSynthesisRuntime {
  speechSynthesis?: SpeechSynthesisLike | null;
  SpeechSynthesisUtterance?: UtteranceConstructor | null;
  setTimeout?: ((callback: () => void, delay: number) => unknown) | null;
  clearTimeout?: ((handle: unknown) => void) | null;
}

interface PlaybackSession {
  generation: number;
  chunks: SpeechChunk[];
  options: SynthesisOptions;
  utterances: SpeechSynthesisUtterance[];
  currentIndex: number;
  settled: boolean;
  resolve(): void;
  reject(error: Error): void;
  releaseVoiceWait: (() => void) | null;
}

const cloneChunk = (chunk: SpeechChunk): SpeechChunk => ({
  text: chunk.text,
  range: {
    ...chunk.range,
    paragraphIndexes: [...chunk.range.paragraphIndexes],
  },
});

const createChunk = (
  source: VoiceRange,
  start: number,
  end: number,
): SpeechChunk => {
  const text = source.text.slice(start, end);
  return {
    text,
    range: {
      ...source,
      from: source.from + start,
      to: source.from + end,
      text,
      paragraphIndexes: [...source.paragraphIndexes],
    },
  };
};

export const splitRangeIntoSpeechChunks = (
  range: VoiceRange,
): SpeechChunk[] => {
  const chunks: SpeechChunk[] = [];
  let start = 0;

  for (let index = 0; index < range.text.length; index += 1) {
    if (!SENTENCE_ENDINGS.has(range.text[index])) continue;

    const chunk = createChunk(range, start, index + 1);
    if (chunk.text.trim()) chunks.push(chunk);
    start = index + 1;
  }

  if (start < range.text.length) {
    const chunk = createChunk(range, start, range.text.length);
    if (chunk.text.trim()) chunks.push(chunk);
  }

  return chunks;
};

export class SpeechCancelledError extends Error {
  constructor() {
    super("Speech playback was cancelled");
    this.name = "AbortError";
  }
}

const createUnsupportedError = () => {
  const error = new Error("Browser speech synthesis is unavailable");
  error.name = "NotSupportedError";
  return error;
};

const invoke = (callback: () => void): void => {
  try {
    callback();
  } catch {
    // Consumer callbacks cannot break the native playback lifecycle.
  }
};

const readDefaultRuntime = (): BrowserSpeechSynthesisRuntime => {
  try {
    const runtime = globalThis as typeof globalThis & {
      speechSynthesis?: SpeechSynthesisLike;
      SpeechSynthesisUtterance?: UtteranceConstructor;
    };
    return {
      speechSynthesis: runtime.speechSynthesis ?? null,
      SpeechSynthesisUtterance: runtime.SpeechSynthesisUtterance ?? null,
      setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
      clearTimeout: (handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
  } catch {
    return {};
  }
};

export class BrowserSpeechSynthesizer implements SpeechSynthesizer {
  readonly supported: boolean;

  private readonly synthesis: SpeechSynthesisLike | null;
  private readonly Utterance: UtteranceConstructor | null;
  private readonly setTimer: (callback: () => void, delay: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private generation = 0;
  private active: PlaybackSession | null = null;

  constructor(runtime: BrowserSpeechSynthesisRuntime = readDefaultRuntime()) {
    this.synthesis = runtime.speechSynthesis ?? null;
    this.Utterance =
      typeof runtime.SpeechSynthesisUtterance === "function"
        ? runtime.SpeechSynthesisUtterance
        : null;
    this.setTimer =
      runtime.setTimeout ??
      ((callback, delay) => globalThis.setTimeout(callback, delay));
    this.clearTimer =
      runtime.clearTimeout ??
      ((handle) =>
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.supported = this.synthesis !== null && this.Utterance !== null;
  }

  speak(chunks: SpeechChunk[], options: SynthesisOptions): Promise<void> {
    this.cancel();

    const playableChunks = chunks
      .filter((chunk) => chunk.text.trim().length > 0)
      .map(cloneChunk);
    if (playableChunks.length === 0) return Promise.resolve();

    if (!this.supported) {
      const error = createUnsupportedError();
      invoke(() => options.onError("synthesis-failed"));
      return Promise.reject(error);
    }

    const generation = ++this.generation;
    return new Promise<void>((resolve, reject) => {
      const session: PlaybackSession = {
        generation,
        chunks: playableChunks,
        options,
        utterances: [],
        currentIndex: -1,
        settled: false,
        resolve,
        reject,
        releaseVoiceWait: null,
      };
      this.active = session;
      void this.prepare(session);
    });
  }

  pause(): void {
    if (!this.active || !this.synthesis) return;
    try {
      this.synthesis.pause();
    } catch {
      // Native pause failures do not corrupt the active queue.
    }
  }

  resume(): void {
    if (!this.active || !this.synthesis) return;
    try {
      this.synthesis.resume();
    } catch {
      // Native resume failures do not corrupt the active queue.
    }
  }

  cancel(): void {
    const session = this.active;
    if (!session || session.settled) return;

    this.invalidate(session);
    try {
      this.synthesis?.cancel();
    } catch {
      // The queue is already invalidated even if native cancellation throws.
    }

    invoke(() => session.options.onError("cancelled"));
    session.reject(new SpeechCancelledError());
  }

  private current(session: PlaybackSession): boolean {
    return (
      !session.settled &&
      this.active === session &&
      this.generation === session.generation
    );
  }

  private async prepare(session: PlaybackSession): Promise<void> {
    const voices = await this.waitForVoices(session);
    if (!this.current(session) || !this.Utterance) return;

    try {
      const selectedVoice = this.selectVoice(voices, session.options.voiceURI);
      session.utterances = session.chunks.map((chunk, index) => {
        const utterance = new this.Utterance!(chunk.text);
        utterance.lang = session.options.language;
        utterance.rate = session.options.rate;
        utterance.voice = selectedVoice;
        utterance.onend = () => this.handleEnd(session, index);
        utterance.onerror = () => this.handleError(session, index);
        return utterance;
      });
    } catch {
      if (this.current(session)) this.fail(session);
      return;
    }

    this.play(session, 0);
  }

  private waitForVoices(
    session: PlaybackSession,
  ): Promise<SpeechSynthesisVoice[]> {
    const initial = this.getVoices();
    if (initial.length > 0 || !this.synthesis) return Promise.resolve(initial);

    return new Promise((resolve) => {
      let settled = false;
      let listenerAdded = false;
      let timerSet = false;
      let timerHandle: unknown;

      const cleanup = () => {
        if (listenerAdded) {
          try {
            this.synthesis?.removeEventListener("voiceschanged", listener);
          } catch {
            // Listener cleanup is best-effort after the session is inert.
          }
        }
        if (timerSet) {
          try {
            this.clearTimer(timerHandle);
          } catch {
            // Timer cleanup is best-effort after the session is inert.
          }
        }
        if (session.releaseVoiceWait === release) {
          session.releaseVoiceWait = null;
        }
      };
      const settle = (voices: SpeechSynthesisVoice[]) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(voices);
      };
      const complete = () => {
        settle(this.current(session) ? this.getVoices() : []);
      };
      const listener: EventListener = () => complete();
      const release = () => settle([]);
      session.releaseVoiceWait = release;

      try {
        this.synthesis?.addEventListener("voiceschanged", listener);
        listenerAdded = true;
      } catch {
        listenerAdded = false;
      }
      try {
        timerHandle = this.setTimer(complete, VOICE_WAIT_TIMEOUT_MS);
        timerSet = true;
      } catch {
        timerSet = false;
      }

      if (!listenerAdded && !timerSet) complete();
    });
  }

  private getVoices(): SpeechSynthesisVoice[] {
    try {
      const voices = this.synthesis?.getVoices();
      return Array.isArray(voices) ? voices : [];
    } catch {
      return [];
    }
  }

  private selectVoice(
    voices: SpeechSynthesisVoice[],
    requestedURI: string | null,
  ): SpeechSynthesisVoice | null {
    if (requestedURI) {
      const requested = voices.find((voice) => voice.voiceURI === requestedURI);
      if (requested) return requested;
    }

    return (
      voices.find((voice) => voice.lang.toLowerCase() === "zh-cn") ??
      voices.find((voice) => voice.lang.toLowerCase().startsWith("zh-")) ??
      voices.find((voice) => voice.default) ??
      voices[0] ??
      null
    );
  }

  private play(session: PlaybackSession, index: number): void {
    if (!this.current(session)) return;

    const utterance = session.utterances[index];
    const chunk = session.chunks[index];
    if (!utterance || !chunk) {
      this.succeed(session);
      return;
    }

    session.currentIndex = index;
    invoke(() => session.options.onChunkStart(cloneChunk(chunk)));
    if (!this.current(session) || session.currentIndex !== index) return;

    try {
      this.synthesis?.speak(utterance);
    } catch {
      if (this.current(session) && session.currentIndex === index) {
        this.fail(session);
      }
    }
  }

  private handleEnd(session: PlaybackSession, index: number): void {
    if (!this.current(session) || session.currentIndex !== index) return;

    this.detachUtterance(session.utterances[index]);
    if (index === session.utterances.length - 1) {
      this.succeed(session);
      return;
    }
    this.play(session, index + 1);
  }

  private handleError(session: PlaybackSession, index: number): void {
    if (!this.current(session) || session.currentIndex !== index) return;
    this.fail(session);
  }

  private succeed(session: PlaybackSession): void {
    if (!this.current(session)) return;
    this.invalidate(session);
    session.resolve();
  }

  private fail(session: PlaybackSession): void {
    if (!this.current(session)) return;
    this.invalidate(session);
    invoke(() => session.options.onError("synthesis-failed"));
    session.reject(new Error("Speech synthesis failed"));
  }

  private invalidate(session: PlaybackSession): void {
    if (session.settled) return;

    session.settled = true;
    if (this.active === session) this.active = null;
    this.generation += 1;
    session.releaseVoiceWait?.();
    session.releaseVoiceWait = null;
    for (const utterance of session.utterances) this.detachUtterance(utterance);
  }

  private detachUtterance(
    utterance: SpeechSynthesisUtterance | undefined,
  ): void {
    if (!utterance) return;
    utterance.onstart = null;
    utterance.onend = null;
    utterance.onerror = null;
    utterance.onboundary = null;
  }
}
