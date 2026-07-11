import type { RecognitionHandlers, SpeechRecognizer } from "./types";

type RecognitionConstructor = new () => SpeechRecognition;

interface RecognitionRuntime {
  SpeechRecognition?: RecognitionConstructor;
  webkitSpeechRecognition?: RecognitionConstructor;
}

interface RecognitionSession {
  generation: number;
  engine: SpeechRecognition;
  handlers: RecognitionHandlers;
  finalizedIndexes: Set<number>;
  interimByIndex: Map<number, string>;
  lastPartial: string;
  stopRequested: boolean;
}

const browserErrorMap: Record<
  string,
  Parameters<RecognitionHandlers["onError"]>[0]
> = {
  "no-speech": "no-speech",
  "not-allowed": "permission-denied",
  "audio-capture": "audio-capture",
  network: "network",
  "language-not-supported": "language-not-supported",
  "service-not-allowed": "service-not-allowed",
  aborted: "aborted",
};

const resolveConstructor = (
  runtime: RecognitionRuntime,
): RecognitionConstructor | null => {
  try {
    if (typeof runtime.SpeechRecognition === "function") {
      return runtime.SpeechRecognition;
    }
  } catch {
    // Fall through to the prefixed implementation.
  }

  try {
    return typeof runtime.webkitSpeechRecognition === "function"
      ? runtime.webkitSpeechRecognition
      : null;
  } catch {
    return null;
  }
};

const invoke = (callback: () => void) => {
  try {
    callback();
  } catch {
    // Browser event handlers must never leak consumer exceptions.
  }
};

export class BrowserSpeechRecognizer implements SpeechRecognizer {
  readonly supported: boolean;

  private readonly Recognition: RecognitionConstructor | null;
  private generation = 0;
  private active: RecognitionSession | null = null;

  constructor(
    runtime: RecognitionRuntime = globalThis as unknown as RecognitionRuntime,
  ) {
    this.Recognition = resolveConstructor(runtime);
    this.supported = this.Recognition !== null;
  }

  start(language: string, handlers: RecognitionHandlers): void {
    if (!this.Recognition) return;

    this.cancel();
    const generation = ++this.generation;
    let engine: SpeechRecognition;
    try {
      engine = new this.Recognition();
    } catch {
      invoke(() => handlers.onError("unknown"));
      return;
    }

    const session: RecognitionSession = {
      generation,
      engine,
      handlers,
      finalizedIndexes: new Set(),
      interimByIndex: new Map(),
      lastPartial: "",
      stopRequested: false,
    };
    this.active = session;

    try {
      engine.lang = language.trim() || "zh-CN";
      engine.continuous = false;
      engine.interimResults = true;
      engine.maxAlternatives = 1;
      this.attach(session);
      engine.start();
    } catch {
      if (!this.current(session)) return;
      this.finish(session);
      invoke(() => handlers.onError("unknown"));
    }
  }

  stop(): void {
    const session = this.active;
    if (!session || session.stopRequested) return;

    session.stopRequested = true;
    try {
      session.engine.stop();
    } catch {
      if (!this.current(session)) return;
      const handlers = session.handlers;
      this.finish(session);
      invoke(() => handlers.onError("unknown"));
    }
  }

  cancel(): void {
    const session = this.active;
    if (!session) return;

    this.finish(session);
    try {
      session.engine.abort();
    } catch {
      // Cancellation remains complete even when the browser throws.
    }
  }

  private current(session: RecognitionSession) {
    return this.active === session && this.generation === session.generation;
  }

  private attach(session: RecognitionSession) {
    const { engine } = session;
    engine.onstart = () => {
      if (!this.current(session)) return;
      invoke(session.handlers.onStart);
    };
    engine.onresult = (event) => {
      if (!this.current(session)) return;
      this.handleResult(session, event);
    };
    engine.onerror = (event) => {
      if (!this.current(session)) return;
      const handlers = session.handlers;
      const code = browserErrorMap[String(event.error)] ?? "unknown";
      this.finish(session);
      invoke(() => handlers.onError(code));
    };
    engine.onend = () => {
      if (!this.current(session)) return;
      const handlers = session.handlers;
      this.finish(session);
      invoke(handlers.onEnd);
    };
  }

  private handleResult(
    session: RecognitionSession,
    event: SpeechRecognitionEvent,
  ) {
    for (const index of session.interimByIndex.keys()) {
      if (index >= event.results.length) session.interimByIndex.delete(index);
    }

    const finalized: string[] = [];
    const start = Math.max(0, event.resultIndex);
    for (let index = start; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = result?.[0]?.transcript ?? "";

      if (result.isFinal) {
        session.interimByIndex.delete(index);
        if (!session.finalizedIndexes.has(index)) {
          session.finalizedIndexes.add(index);
          if (transcript) finalized.push(transcript);
        }
      } else if (!session.finalizedIndexes.has(index)) {
        session.interimByIndex.set(index, transcript);
      }
    }

    if (finalized.length > 0) {
      invoke(() => session.handlers.onFinal(finalized.join("")));
      if (!this.current(session)) return;
    }

    const partial = [...session.interimByIndex.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join("");
    if (partial !== session.lastPartial) {
      session.lastPartial = partial;
      invoke(() => session.handlers.onPartial(partial));
    }
  }

  private finish(session: RecognitionSession) {
    if (!this.current(session)) return;

    this.active = null;
    this.generation += 1;
    this.detach(session.engine);
  }

  private detach(engine: SpeechRecognition) {
    engine.onstart = null;
    engine.onresult = null;
    engine.onerror = null;
    engine.onend = null;
  }
}
