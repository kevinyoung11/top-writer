import { beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSpeechRecognizer } from "./browser-recognizer";
import type { RecognitionHandlers } from "./types";

const result = (transcript: string, isFinal: boolean) => {
  const alternative = { transcript, confidence: 1 };
  return {
    0: alternative,
    isFinal,
    length: 1,
    item: () => alternative,
  } as unknown as SpeechRecognitionResult;
};

const resultEvent = (
  resultIndex: number,
  entries: SpeechRecognitionResult[],
) => {
  const results = Object.assign(entries, {
    item: (index: number) => entries[index],
  }) as unknown as SpeechRecognitionResultList;
  return { resultIndex, results } as SpeechRecognitionEvent;
};

class FakeRecognition {
  static instances: FakeRecognition[] = [];
  static throwOnNextStart = false;

  lang = "";
  continuous = true;
  interimResults = false;
  maxAlternatives = 0;
  onstart: SpeechRecognition["onstart"] = null;
  onresult: SpeechRecognition["onresult"] = null;
  onerror: SpeechRecognition["onerror"] = null;
  onend: SpeechRecognition["onend"] = null;

  readonly start = vi.fn(() => {
    if (FakeRecognition.throwOnNextStart) {
      FakeRecognition.throwOnNextStart = false;
      throw new Error("start failed");
    }
  });
  readonly stop = vi.fn();
  readonly abort = vi.fn(() => {
    this.onerror?.call(
      this as unknown as SpeechRecognition,
      { error: "aborted" } as SpeechRecognitionErrorEvent,
    );
  });

  constructor() {
    FakeRecognition.instances.push(this);
  }

  emitStart() {
    this.onstart?.call(
      this as unknown as SpeechRecognition,
      new Event("start"),
    );
  }

  emitResult(event: SpeechRecognitionEvent) {
    this.onresult?.call(this as unknown as SpeechRecognition, event);
  }

  emitError(error: string) {
    this.onerror?.call(
      this as unknown as SpeechRecognition,
      { error } as SpeechRecognitionErrorEvent,
    );
  }

  emitEnd() {
    this.onend?.call(this as unknown as SpeechRecognition, new Event("end"));
  }
}

class PrefixedRecognition extends FakeRecognition {}

const constructorOf = (value: typeof FakeRecognition) =>
  value as unknown as new () => SpeechRecognition;

const handlers = (): RecognitionHandlers => ({
  onStart: vi.fn(),
  onPartial: vi.fn(),
  onFinal: vi.fn(),
  onEnd: vi.fn(),
  onError: vi.fn(),
});

beforeEach(() => {
  FakeRecognition.instances = [];
  FakeRecognition.throwOnNextStart = false;
});

describe("BrowserSpeechRecognizer", () => {
  it("prefers the unprefixed constructor then falls back to webkit", () => {
    const preferred = new BrowserSpeechRecognizer({
      SpeechRecognition: constructorOf(FakeRecognition),
      webkitSpeechRecognition: constructorOf(PrefixedRecognition),
    });
    preferred.start("zh-CN", handlers());
    expect(FakeRecognition.instances[0]).not.toBeInstanceOf(
      PrefixedRecognition,
    );

    FakeRecognition.instances = [];
    const fallback = new BrowserSpeechRecognizer({
      webkitSpeechRecognition: constructorOf(PrefixedRecognition),
    });
    fallback.start("zh-CN", handlers());
    expect(FakeRecognition.instances[0]).toBeInstanceOf(PrefixedRecognition);
  });

  it("reports unsupported without requesting microphone permission", () => {
    const getUserMedia = vi.fn();
    const runtime = {
      SpeechRecognition: undefined,
      webkitSpeechRecognition: undefined,
      getUserMedia,
    };
    const recognizer = new BrowserSpeechRecognizer(runtime);
    const callbacks = handlers();

    expect(recognizer.supported).toBe(false);
    expect(() => recognizer.start("zh-CN", callbacks)).not.toThrow();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  it("configures each new recognition engine with the planned options", () => {
    const recognizer = new BrowserSpeechRecognizer({
      SpeechRecognition: constructorOf(FakeRecognition),
    });

    recognizer.start("zh-CN", handlers());
    const first = FakeRecognition.instances[0];
    recognizer.start("en-US", handlers());
    const second = FakeRecognition.instances[1];

    expect(first).toMatchObject({
      lang: "zh-CN",
      continuous: false,
      interimResults: true,
      maxAlternatives: 1,
    });
    expect(second).toMatchObject({
      lang: "en-US",
      continuous: false,
      interimResults: true,
      maxAlternatives: 1,
    });
    expect(first.abort).toHaveBeenCalledOnce();
    expect(first).not.toHaveProperty("phrases");
  });

  it("falls back to Mandarin when the requested language is empty", () => {
    const recognizer = new BrowserSpeechRecognizer({
      SpeechRecognition: constructorOf(FakeRecognition),
    });

    recognizer.start("   ", handlers());

    expect(FakeRecognition.instances[0].lang).toBe("zh-CN");
  });

  it("emits cumulative partial and only newly finalized transcripts", () => {
    const callbacks = handlers();
    const recognizer = new BrowserSpeechRecognizer({
      SpeechRecognition: constructorOf(FakeRecognition),
    });
    recognizer.start("zh-CN", callbacks);
    const engine = FakeRecognition.instances[0];

    engine.emitResult(resultEvent(0, [result("你", false)]));
    engine.emitResult(
      resultEvent(0, [result("你好", true), result("世", false)]),
    );
    engine.emitResult(
      resultEvent(1, [result("你好", true), result("世界", true)]),
    );
    engine.emitResult(
      resultEvent(0, [result("你好", true), result("世界", true)]),
    );

    expect(callbacks.onPartial).toHaveBeenNthCalledWith(1, "你");
    expect(callbacks.onPartial).toHaveBeenNthCalledWith(2, "世");
    expect(callbacks.onPartial).toHaveBeenNthCalledWith(3, "");
    expect(callbacks.onPartial).toHaveBeenCalledTimes(3);
    expect(callbacks.onFinal).toHaveBeenNthCalledWith(1, "你好");
    expect(callbacks.onFinal).toHaveBeenNthCalledWith(2, "世界");
    expect(callbacks.onFinal).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["no-speech", "no-speech"],
    ["not-allowed", "permission-denied"],
    ["audio-capture", "audio-capture"],
    ["network", "network"],
    ["language-not-supported", "language-not-supported"],
    ["service-not-allowed", "service-not-allowed"],
    ["aborted", "aborted"],
    ["bad-grammar", "unknown"],
  ] as const)("maps browser error %s to %s", (browserError, expected) => {
    const callbacks = handlers();
    const recognizer = new BrowserSpeechRecognizer({
      SpeechRecognition: constructorOf(FakeRecognition),
    });
    recognizer.start("zh-CN", callbacks);

    FakeRecognition.instances[0].emitError(browserError);

    expect(callbacks.onError).toHaveBeenCalledWith(expected);
    expect(callbacks.onError).toHaveBeenCalledOnce();
  });

  it("cancel detaches callbacks before abort and is idempotent", () => {
    const callbacks = handlers();
    const recognizer = new BrowserSpeechRecognizer({
      SpeechRecognition: constructorOf(FakeRecognition),
    });
    recognizer.start("zh-CN", callbacks);
    const engine = FakeRecognition.instances[0];
    const staleResult = engine.onresult;

    recognizer.cancel();
    recognizer.cancel();
    staleResult?.call(
      engine as unknown as SpeechRecognition,
      resultEvent(0, [result("stale", true)]),
    );

    expect(engine.abort).toHaveBeenCalledOnce();
    expect(callbacks.onError).not.toHaveBeenCalled();
    expect(callbacks.onFinal).not.toHaveBeenCalled();
  });

  it("restarting aborts the old engine once and makes stale callbacks inert", () => {
    const firstHandlers = handlers();
    const secondHandlers = handlers();
    const recognizer = new BrowserSpeechRecognizer({
      SpeechRecognition: constructorOf(FakeRecognition),
    });
    recognizer.start("zh-CN", firstHandlers);
    const first = FakeRecognition.instances[0];
    const staleStart = first.onstart;

    recognizer.start("zh-CN", secondHandlers);
    const second = FakeRecognition.instances[1];
    staleStart?.call(first as unknown as SpeechRecognition, new Event("start"));
    second.emitStart();

    expect(first.abort).toHaveBeenCalledOnce();
    expect(firstHandlers.onStart).not.toHaveBeenCalled();
    expect(secondHandlers.onStart).toHaveBeenCalledOnce();
  });

  it("stop requests a final result once and keeps the session active", () => {
    const callbacks = handlers();
    const recognizer = new BrowserSpeechRecognizer({
      SpeechRecognition: constructorOf(FakeRecognition),
    });
    recognizer.start("zh-CN", callbacks);
    const engine = FakeRecognition.instances[0];

    recognizer.stop();
    recognizer.stop();
    engine.emitResult(resultEvent(0, [result("最终结果", true)]));

    expect(engine.stop).toHaveBeenCalledOnce();
    expect(callbacks.onFinal).toHaveBeenCalledWith("最终结果");
  });

  it("cleans up on end, error, and a synchronous start failure", () => {
    const recognizer = new BrowserSpeechRecognizer({
      SpeechRecognition: constructorOf(FakeRecognition),
    });

    const ended = handlers();
    recognizer.start("zh-CN", ended);
    const endedEngine = FakeRecognition.instances[0];
    endedEngine.emitEnd();
    endedEngine.emitEnd();
    recognizer.cancel();
    expect(ended.onEnd).toHaveBeenCalledOnce();
    expect(endedEngine.abort).not.toHaveBeenCalled();

    const errored = handlers();
    recognizer.start("zh-CN", errored);
    const erroredEngine = FakeRecognition.instances[1];
    const staleEnd = erroredEngine.onend;
    erroredEngine.emitError("network");
    staleEnd?.call(
      erroredEngine as unknown as SpeechRecognition,
      new Event("end"),
    );
    recognizer.stop();
    expect(errored.onError).toHaveBeenCalledWith("network");
    expect(errored.onEnd).not.toHaveBeenCalled();
    expect(erroredEngine.stop).not.toHaveBeenCalled();

    const failed = handlers();
    FakeRecognition.throwOnNextStart = true;
    expect(() => recognizer.start("zh-CN", failed)).not.toThrow();
    recognizer.cancel();
    expect(failed.onError).toHaveBeenCalledWith("unknown");
    expect(FakeRecognition.instances[2].abort).not.toHaveBeenCalled();
  });
});
