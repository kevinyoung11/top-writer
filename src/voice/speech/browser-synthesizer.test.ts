// @vitest-environment jsdom

import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceRange } from "../types";
import type { SpeechChunk, SynthesisOptions } from "./types";
import {
  BrowserSpeechSynthesizer,
  SpeechCancelledError,
  splitRangeIntoSpeechChunks,
} from "./browser-synthesizer";
import {
  filterVoicesForLanguage,
  type SpeechVoiceOption,
} from "./types";

const voice = (
  voiceURI: string,
  lang: string,
  isDefault = false,
): SpeechSynthesisVoice => ({
  default: isDefault,
  lang,
  localService: true,
  name: voiceURI,
  voiceURI,
});

const makeRange = (text: string, from = 10): VoiceRange => ({
  revision: 7,
  from,
  to: from + text.length,
  text,
  paragraphIndexes: [2, 3],
  block: true,
});

const makeChunk = (text: string, from = 0): SpeechChunk => ({
  text,
  range: {
    revision: 1,
    from,
    to: from + text.length,
    text,
    paragraphIndexes: [0],
    block: false,
  },
});

class FakeUtterance {
  static instances: FakeUtterance[] = [];

  readonly text: string;
  lang = "";
  rate = 1;
  voice: SpeechSynthesisVoice | null = null;
  onend: SpeechSynthesisUtterance["onend"] = null;
  onerror: SpeechSynthesisUtterance["onerror"] = null;
  onboundary: SpeechSynthesisUtterance["onboundary"] = null;
  onstart: SpeechSynthesisUtterance["onstart"] = null;

  constructor(text: string) {
    this.text = text;
    FakeUtterance.instances.push(this);
  }

  emitEnd(): void {
    this.onend?.call(
      this as unknown as SpeechSynthesisUtterance,
      new Event("end") as SpeechSynthesisEvent,
    );
  }

  emitError(): void {
    this.onerror?.call(
      this as unknown as SpeechSynthesisUtterance,
      new Event("error") as SpeechSynthesisErrorEvent,
    );
  }

  emitBoundary(): void {
    this.onboundary?.call(
      this as unknown as SpeechSynthesisUtterance,
      new Event("boundary") as SpeechSynthesisEvent,
    );
  }
}

class FakeSpeechSynthesis {
  voices: SpeechSynthesisVoice[];
  readonly spoken: FakeUtterance[] = [];
  readonly order: string[] = [];
  readonly voiceListeners = new Set<EventListenerOrEventListenerObject>();
  lastAddedVoiceListener: EventListenerOrEventListenerObject | null = null;
  onCancel: (() => void) | null = null;

  readonly getVoices = vi.fn(() => [...this.voices]);
  readonly speak = vi.fn((utterance: SpeechSynthesisUtterance) => {
    const fake = utterance as unknown as FakeUtterance;
    this.spoken.push(fake);
    this.order.push(`speak:${fake.text}`);
  });
  readonly pause = vi.fn();
  readonly resume = vi.fn();
  readonly cancel = vi.fn(() => this.onCancel?.());
  readonly addEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type !== "voiceschanged") return;
      this.voiceListeners.add(listener);
      this.lastAddedVoiceListener = listener;
    },
  );
  readonly removeEventListener = vi.fn(
    (type: string, listener: EventListenerOrEventListenerObject) => {
      if (type === "voiceschanged") this.voiceListeners.delete(listener);
    },
  );

  constructor(voices: SpeechSynthesisVoice[] = []) {
    this.voices = voices;
  }

  emitVoicesChanged(): void {
    for (const listener of [...this.voiceListeners]) {
      this.invokeVoiceListener(listener);
    }
  }

  invokeVoiceListener(listener: EventListenerOrEventListenerObject): void {
    const event = new Event("voiceschanged");
    if (typeof listener === "function") listener(event);
    else listener.handleEvent(event);
  }
}

class ManualTimers {
  private nextId = 1;
  readonly tasks = new Map<number, () => void>();
  lastScheduled: (() => void) | null = null;

  readonly setTimeout = vi.fn((callback: () => void, _delay: number) => {
    const id = this.nextId++;
    this.tasks.set(id, callback);
    this.lastScheduled = callback;
    return id;
  });
  readonly clearTimeout = vi.fn((id: unknown) => {
    this.tasks.delete(Number(id));
  });

  runNext(): void {
    const entry = this.tasks.entries().next().value as
      [number, () => void] | undefined;
    if (!entry) throw new Error("No pending timer");
    this.tasks.delete(entry[0]);
    entry[1]();
  }
}

const flushMicrotasks = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const createHarness = (voices: SpeechSynthesisVoice[] = []) => {
  FakeUtterance.instances = [];
  const speechSynthesis = new FakeSpeechSynthesis(voices);
  const timers = new ManualTimers();
  const synthesizer = new BrowserSpeechSynthesizer({
    speechSynthesis,
    SpeechSynthesisUtterance:
      FakeUtterance as unknown as typeof SpeechSynthesisUtterance,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  return { speechSynthesis, synthesizer, timers };
};

const makeOptions = (
  onChunkStart: SynthesisOptions["onChunkStart"] = vi.fn(),
  onError: SynthesisOptions["onError"] = vi.fn(),
): SynthesisOptions => ({
  language: "zh-CN",
  rate: 1.25,
  voiceURI: null,
  onChunkStart,
  onError,
});

beforeEach(() => {
  FakeUtterance.instances = [];
});

describe("splitRangeIntoSpeechChunks", () => {
  it("splits after Chinese sentence punctuation and preserves metadata", () => {
    const range = makeRange("你好。第二句！末尾", 10);

    expect(splitRangeIntoSpeechChunks(range)).toEqual([
      {
        text: "你好。",
        range: {
          ...range,
          from: 10,
          to: 13,
          text: "你好。",
          paragraphIndexes: [2, 3],
        },
      },
      {
        text: "第二句！",
        range: {
          ...range,
          from: 13,
          to: 17,
          text: "第二句！",
          paragraphIndexes: [2, 3],
        },
      },
      {
        text: "末尾",
        range: {
          ...range,
          from: 17,
          to: 19,
          text: "末尾",
          paragraphIndexes: [2, 3],
        },
      },
    ]);
  });

  it("uses UTF-16 offsets for emoji and mixed punctuation", () => {
    const range = makeRange("😀好？OK!再见；尾;", 5);

    expect(
      splitRangeIntoSpeechChunks(range).map(({ text, range: chunkRange }) => ({
        text,
        from: chunkRange.from,
        to: chunkRange.to,
        revision: chunkRange.revision,
        paragraphIndexes: chunkRange.paragraphIndexes,
        block: chunkRange.block,
      })),
    ).toEqual([
      {
        text: "😀好？",
        from: 5,
        to: 9,
        revision: 7,
        paragraphIndexes: [2, 3],
        block: true,
      },
      {
        text: "OK!",
        from: 9,
        to: 12,
        revision: 7,
        paragraphIndexes: [2, 3],
        block: true,
      },
      {
        text: "再见；",
        from: 12,
        to: 15,
        revision: 7,
        paragraphIndexes: [2, 3],
        block: true,
      },
      {
        text: "尾;",
        from: 15,
        to: 17,
        revision: 7,
        paragraphIndexes: [2, 3],
        block: true,
      },
    ]);
  });

  it("drops empty and whitespace-only chunks without trimming spoken text", () => {
    expect(splitRangeIntoSpeechChunks(makeRange(""))).toEqual([]);
    expect(splitRangeIntoSpeechChunks(makeRange(" \n\t"))).toEqual([]);

    const chunks = splitRangeIntoSpeechChunks(makeRange("  开始。  ", 20));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      text: "  开始。",
      range: { from: 20, to: 25, text: "  开始。" },
    });
  });

  it("keeps consecutive endings and closing quotes or brackets together", () => {
    const chunks = splitRangeIntoSpeechChunks(
      makeRange('你好？！下一句。”然后呢?!)最后!"'),
    );

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "你好？！",
      "下一句。”",
      "然后呢?!)",
      '最后!"',
    ]);
  });

  it.each(["？！", "。”"])(
    "moves the complete trailing punctuation group %s past a 240-unit boundary",
    (ending) => {
      const prefix = "a".repeat(239);
      const range = makeRange(`${prefix}${ending}`, 40);
      const chunks = splitRangeIntoSpeechChunks(range);

      expect(chunks.map((chunk) => chunk.text)).toEqual([prefix, ending]);
      expect(chunks.every((chunk) => chunk.text.length <= 240)).toBe(true);
      expect(chunks.map((chunk) => chunk.text).join("")).toBe(range.text);
      expect(chunks.map((chunk) => [chunk.range.from, chunk.range.to])).toEqual(
        [
          [40, 279],
          [279, 281],
        ],
      );
    },
  );

  it("bounds oversized text, prefers whitespace, and never splits a surrogate pair", () => {
    const text = `${"a".repeat(239)}😀${"b".repeat(4759)}`;
    expect(text.length).toBe(5000);
    const range = makeRange(text, 30);
    const chunks = splitRangeIntoSpeechChunks(range);

    expect(chunks.map((chunk) => chunk.text).join("")).toBe(text);
    let nextFrom = range.from;
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(240);
      expect(chunk.range.from).toBe(nextFrom);
      expect(chunk.range.to - chunk.range.from).toBe(chunk.text.length);
      expect(chunk.text.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
      const lastCodeUnit = chunk.text.charCodeAt(chunk.text.length - 1);
      expect(lastCodeUnit < 0xd800 || lastCodeUnit > 0xdbff).toBe(true);
      nextFrom = chunk.range.to;
    }
    expect(nextFrom).toBe(range.to);

    const whitespaceRange = makeRange(
      `${"x".repeat(230)} ${"y".repeat(30)}`,
      100,
    );
    const whitespaceChunks = splitRangeIntoSpeechChunks(whitespaceRange);
    expect(whitespaceChunks[0].text).toBe(`${"x".repeat(230)} `);
    expect(whitespaceChunks.map((chunk) => chunk.text).join("")).toBe(
      whitespaceRange.text,
    );

    const longWhitespaceRange = makeRange(
      `${" ".repeat(300)}内容${" ".repeat(300)}结尾`,
      200,
    );
    const longWhitespaceChunks =
      splitRangeIntoSpeechChunks(longWhitespaceRange);
    expect(longWhitespaceChunks.map((chunk) => chunk.text).join("")).toBe(
      longWhitespaceRange.text,
    );
    expect(
      longWhitespaceChunks.every((chunk) => chunk.text.length <= 240),
    ).toBe(true);
  });

  it("maps every real Tiptap paragraph-content chunk back to identical text", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit],
      content:
        "<p>普通第一句。普通第二句！</p><p>换行前<br>换行后？</p><ul><li><p>嵌套第一句；嵌套第二句。</p></li></ul>",
    });

    try {
      const ranges: VoiceRange[] = [];
      editor.state.doc.descendants((node, position) => {
        if (node.type.name !== "paragraph") return;
        const from = position + 1;
        const to = from + node.content.size;
        ranges.push({
          revision: 3,
          from,
          to,
          text: editor.state.doc.textBetween(from, to, "\n\n", "\n"),
          paragraphIndexes: [ranges.length],
          block: true,
        });
      });

      expect(ranges).toHaveLength(3);
      for (const range of ranges) {
        const chunks = splitRangeIntoSpeechChunks(range);
        expect(chunks.map((chunk) => chunk.text).join("")).toBe(range.text);
        for (const chunk of chunks) {
          expect(
            editor.state.doc.textBetween(
              chunk.range.from,
              chunk.range.to,
              "\n\n",
              "\n",
            ),
          ).toBe(chunk.text);
        }
      }
    } finally {
      editor.destroy();
    }
  });

  it("rejects node/document coordinates that are not content-aligned", () => {
    const editor = new Editor({
      element: document.createElement("div"),
      extensions: [StarterKit],
      content: "<p>第一段。</p><p>第二段。</p>",
    });

    try {
      const paragraph = editor.state.doc.firstChild;
      if (!paragraph) throw new Error("Expected paragraph");
      const invalidRanges: VoiceRange[] = [
        {
          revision: 0,
          from: 0,
          to: paragraph.nodeSize,
          text: paragraph.textContent,
          paragraphIndexes: [0],
          block: true,
        },
        {
          revision: 0,
          from: 0,
          to: editor.state.doc.content.size,
          text: editor.state.doc.textBetween(
            0,
            editor.state.doc.content.size,
            "\n\n",
            "\n",
          ),
          paragraphIndexes: [0, 1],
          block: true,
        },
      ];

      for (const range of invalidRanges) {
        expect(() => splitRangeIntoSpeechChunks(range)).toThrowError(
          new RangeError(
            "VoiceRange must use paragraph content coordinates; decompose block/document ranges into paragraph content ranges",
          ),
        );
      }
    } finally {
      editor.destroy();
    }
  });
});

describe("BrowserSpeechSynthesizer", () => {
  it("publishes immutable data-only voice snapshots and shares one native catalog listener", () => {
    const first = voice("mandarin", "zh-CN", true);
    const second = voice("english", "en-US");
    const { speechSynthesis, synthesizer } = createHarness([first, second]);
    const updates: SpeechVoiceOption[][] = [];
    const secondUpdates: SpeechVoiceOption[][] = [];

    const unsubscribeFirst = synthesizer.subscribeVoicesChanged((voices) => {
      updates.push([...voices]);
    });
    const unsubscribeSecond = synthesizer.subscribeVoicesChanged((voices) => {
      secondUpdates.push([...voices]);
      throw new Error("consumer failure must be isolated");
    });

    expect(synthesizer.voices).toEqual([
      { voiceURI: "mandarin", name: "mandarin", lang: "zh-CN", default: true },
      { voiceURI: "english", name: "english", lang: "en-US", default: false },
    ]);
    expect(Object.isFrozen(synthesizer.voices)).toBe(true);
    expect(Object.isFrozen(synthesizer.voices[0])).toBe(true);
    expect(speechSynthesis.addEventListener).toHaveBeenCalledTimes(1);
    expect(updates).toHaveLength(1);
    expect(secondUpdates).toHaveLength(1);

    speechSynthesis.voices = [voice("simplified", "zh_Hans_CN")];
    speechSynthesis.emitVoicesChanged();
    expect(updates.at(-1)).toEqual([
      { voiceURI: "simplified", name: "simplified", lang: "zh_Hans_CN", default: false },
    ]);
    expect(secondUpdates).toHaveLength(2);

    unsubscribeFirst();
    expect(speechSynthesis.removeEventListener).not.toHaveBeenCalled();
    unsubscribeSecond();
    unsubscribeSecond();
    expect(speechSynthesis.removeEventListener).toHaveBeenCalledTimes(1);
  });

  it("returns no catalog voices when synthesis is unsupported and filters zh-CN regions", () => {
    const unsupported = new BrowserSpeechSynthesizer({
      speechSynthesis: new FakeSpeechSynthesis([voice("mandarin", "zh-CN")]),
      SpeechSynthesisUtterance: null,
    });
    expect(unsupported.voices).toEqual([]);
    expect(() => unsupported.subscribeVoicesChanged(vi.fn())).not.toThrow();

    const options: SpeechVoiceOption[] = [
      { voiceURI: "cn", name: "CN", lang: "zh-CN", default: false },
      { voiceURI: "hans", name: "Hans", lang: "zh_Hans_CN", default: false },
      { voiceURI: "tw", name: "TW", lang: "zh-TW", default: false },
      { voiceURI: "bare", name: "Bare", lang: "zh", default: false },
    ];
    expect(filterVoicesForLanguage(options, "ZH_cn").map((voice) => voice.voiceURI)).toEqual([
      "cn",
      "hans",
    ]);
  });

  it("speaks in order, reports each chunk immediately before speak, and resolves last", async () => {
    const selectedVoice = voice("mandarin", "zh-CN", true);
    const { speechSynthesis, synthesizer } = createHarness([selectedVoice]);
    const chunks = [makeChunk("第一句。"), makeChunk("第二句。", 4)];
    const options = makeOptions((chunk) => {
      speechSynthesis.order.push(`chunk:${chunk.text}`);
    });
    let resolved = false;

    const playback = synthesizer.speak(chunks, options).then(() => {
      resolved = true;
    });
    await flushMicrotasks();

    expect(speechSynthesis.order).toEqual(["chunk:第一句。", "speak:第一句。"]);
    expect(FakeUtterance.instances[0]).toMatchObject({
      text: "第一句。",
      lang: "zh-CN",
      rate: 1.25,
      voice: selectedVoice,
    });
    expect(resolved).toBe(false);

    FakeUtterance.instances[0].emitEnd();
    expect(speechSynthesis.order).toEqual([
      "chunk:第一句。",
      "speak:第一句。",
      "chunk:第二句。",
      "speak:第二句。",
    ]);
    expect(resolved).toBe(false);

    FakeUtterance.instances[1].emitEnd();
    await playback;
    expect(resolved).toBe(true);
  });

  it("delegates pause and resume and cancels an active queue idempotently", async () => {
    const { speechSynthesis, synthesizer } = createHarness([
      voice("mandarin", "zh-CN"),
    ]);
    const options = makeOptions();
    const playback = synthesizer.speak([makeChunk("内容")], options);
    const rejection = playback.catch((error: unknown) => error);
    await flushMicrotasks();
    const utterance = FakeUtterance.instances[0];
    const staleEnd = utterance.onend;
    const staleError = utterance.onerror;
    const staleBoundary = utterance.onboundary;
    speechSynthesis.onCancel = () => {
      expect(utterance.onend).toBeNull();
      expect(utterance.onerror).toBeNull();
      expect(utterance.onboundary).toBeNull();
      staleEnd?.call(
        utterance as unknown as SpeechSynthesisUtterance,
        new Event("end") as SpeechSynthesisEvent,
      );
      staleError?.call(
        utterance as unknown as SpeechSynthesisUtterance,
        new Event("error") as SpeechSynthesisErrorEvent,
      );
      staleBoundary?.call(
        utterance as unknown as SpeechSynthesisUtterance,
        new Event("boundary") as SpeechSynthesisEvent,
      );
    };

    synthesizer.pause();
    synthesizer.resume();
    synthesizer.cancel();
    synthesizer.cancel();

    const error = await rejection;
    expect(speechSynthesis.pause).toHaveBeenCalledOnce();
    expect(speechSynthesis.resume).toHaveBeenCalledOnce();
    expect(speechSynthesis.cancel).toHaveBeenCalledOnce();
    expect(error).toBeInstanceOf(SpeechCancelledError);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(options.onError).toHaveBeenCalledOnce();
    expect(options.onError).toHaveBeenCalledWith("cancelled");
  });

  it("rejects a native utterance error exactly once and stops the queue", async () => {
    const { speechSynthesis, synthesizer } = createHarness([
      voice("mandarin", "zh-CN"),
    ]);
    const options = makeOptions();
    const playback = synthesizer.speak(
      [makeChunk("一"), makeChunk("二", 1)],
      options,
    );
    const rejection = playback.catch((error: unknown) => error);
    await flushMicrotasks();
    const utterance = FakeUtterance.instances[0];
    const staleError = utterance.onerror;
    const staleEnd = utterance.onend;

    utterance.emitError();
    staleError?.call(
      utterance as unknown as SpeechSynthesisUtterance,
      new Event("error") as SpeechSynthesisErrorEvent,
    );
    staleEnd?.call(
      utterance as unknown as SpeechSynthesisUtterance,
      new Event("end") as SpeechSynthesisEvent,
    );

    const error = await rejection;
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SpeechCancelledError);
    expect(options.onError).toHaveBeenCalledOnce();
    expect(options.onError).toHaveBeenCalledWith("synthesis-failed");
    expect(speechSynthesis.speak).toHaveBeenCalledOnce();
  });

  it("a new speak cancels the prior queue and makes every utterance callback stale", async () => {
    const { speechSynthesis, synthesizer } = createHarness([
      voice("mandarin", "zh-CN"),
    ]);
    const firstOptions = makeOptions();
    const first = synthesizer.speak(
      [makeChunk("旧一"), makeChunk("旧二", 2)],
      firstOptions,
    );
    const firstRejection = first.catch((error: unknown) => error);
    await flushMicrotasks();
    const oldUtterance = FakeUtterance.instances[0];
    const staleEnd = oldUtterance.onend;
    const staleError = oldUtterance.onerror;
    const staleBoundary = oldUtterance.onboundary;

    const secondOptions = makeOptions();
    const second = synthesizer.speak([makeChunk("新内容")], secondOptions);
    await flushMicrotasks();
    const callsBeforeStaleEvents = speechSynthesis.speak.mock.calls.length;

    staleEnd?.call(
      oldUtterance as unknown as SpeechSynthesisUtterance,
      new Event("end") as SpeechSynthesisEvent,
    );
    staleError?.call(
      oldUtterance as unknown as SpeechSynthesisUtterance,
      new Event("error") as SpeechSynthesisErrorEvent,
    );
    staleBoundary?.call(
      oldUtterance as unknown as SpeechSynthesisUtterance,
      new Event("boundary") as SpeechSynthesisEvent,
    );

    expect(await firstRejection).toBeInstanceOf(SpeechCancelledError);
    expect(firstOptions.onError).toHaveBeenCalledWith("cancelled");
    expect(speechSynthesis.cancel).toHaveBeenCalledOnce();
    expect(speechSynthesis.speak).toHaveBeenCalledTimes(callsBeforeStaleEvents);
    expect(secondOptions.onError).not.toHaveBeenCalled();

    FakeUtterance.instances.at(-1)?.emitEnd();
    await second;
  });

  it("does not orphan a reentrant replacement started by the cancelled session", async () => {
    const { speechSynthesis, synthesizer } = createHarness([
      voice("mandarin", "zh-CN"),
    ]);
    const settlements = { old: 0, nested: 0, outer: 0 };
    let nestedPlayback: Promise<void> | null = null;
    const nestedOptions = makeOptions();
    const oldOptions = makeOptions();
    oldOptions.onError = vi.fn((code) => {
      if (code !== "cancelled") return;
      nestedPlayback = synthesizer.speak(
        [makeChunk("嵌套调用")],
        nestedOptions,
      );
      void nestedPlayback.then(
        () => {
          settlements.nested += 1;
        },
        () => {
          settlements.nested += 1;
        },
      );
    });
    const oldPlayback = synthesizer.speak([makeChunk("旧队列")], oldOptions);
    const oldOutcome = oldPlayback.then(
      () => {
        settlements.old += 1;
        return null;
      },
      (error: unknown) => {
        settlements.old += 1;
        return error;
      },
    );
    await flushMicrotasks();

    const outerOptions = makeOptions();
    const outerPlayback = synthesizer.speak(
      [makeChunk("外层替换")],
      outerOptions,
    );
    const outerOutcome = outerPlayback.then(
      () => {
        settlements.outer += 1;
        return null;
      },
      (error: unknown) => {
        settlements.outer += 1;
        return error;
      },
    );
    await flushMicrotasks();

    expect(speechSynthesis.spoken.map((utterance) => utterance.text)).toEqual([
      "旧队列",
      "嵌套调用",
    ]);
    expect(await oldOutcome).toBeInstanceOf(SpeechCancelledError);
    expect(await outerOutcome).toBeInstanceOf(SpeechCancelledError);
    expect(settlements).toEqual({ old: 1, nested: 0, outer: 1 });
    expect(oldOptions.onError).toHaveBeenCalledOnce();
    expect(outerOptions.onError).toHaveBeenCalledOnce();

    if (!nestedPlayback) throw new Error("Expected nested playback");
    speechSynthesis.spoken.at(-1)?.emitEnd();
    await nestedPlayback;
    expect(settlements).toEqual({ old: 1, nested: 1, outer: 1 });
  });

  it("snapshots chunks, settings, and callback references before cancellation callbacks", async () => {
    const originalVoice = voice("original", "en-US");
    const mutatedVoice = voice("mutated", "zh-CN");
    const { synthesizer } = createHarness([mutatedVoice, originalVoice]);
    const originalStart = vi.fn<SynthesisOptions["onChunkStart"]>();
    const mutatedStart = vi.fn<SynthesisOptions["onChunkStart"]>();
    const originalError = vi.fn<SynthesisOptions["onError"]>();
    const mutatedError = vi.fn<SynthesisOptions["onError"]>();
    const outerOptions: SynthesisOptions = {
      language: "en-US",
      rate: 1.75,
      voiceURI: "original",
      onChunkStart: originalStart,
      onError: originalError,
    };
    const outerChunk = makeChunk("原始内容");
    const oldOptions = makeOptions();
    oldOptions.onError = vi.fn((code) => {
      if (code !== "cancelled") return;
      outerChunk.text = "篡改内容";
      outerChunk.range.text = "篡改内容";
      outerChunk.range.to =
        outerChunk.range.from + outerChunk.range.text.length;
      outerOptions.language = "zh-CN";
      outerOptions.rate = 0.5;
      outerOptions.voiceURI = "mutated";
      outerOptions.onChunkStart = mutatedStart;
      outerOptions.onError = mutatedError;
    });
    const oldPlayback = synthesizer.speak([makeChunk("旧内容")], oldOptions);
    const oldRejection = oldPlayback.catch((error: unknown) => error);
    await flushMicrotasks();

    const outerPlayback = synthesizer.speak([outerChunk], outerOptions);
    await flushMicrotasks();
    const utterance = FakeUtterance.instances.at(-1);

    expect(await oldRejection).toBeInstanceOf(SpeechCancelledError);
    expect(utterance).toMatchObject({
      text: "原始内容",
      lang: "en-US",
      rate: 1.75,
      voice: originalVoice,
    });
    expect(originalStart).toHaveBeenCalledWith(
      expect.objectContaining({ text: "原始内容" }),
    );
    expect(mutatedStart).not.toHaveBeenCalled();

    utterance?.emitEnd();
    await outerPlayback;
    expect(originalError).not.toHaveBeenCalled();
    expect(mutatedError).not.toHaveBeenCalled();
  });

  it("resolves an empty queue without touching native playback", async () => {
    const { speechSynthesis, synthesizer } = createHarness();
    const options = makeOptions();

    await expect(synthesizer.speak([], options)).resolves.toBeUndefined();

    expect(speechSynthesis.getVoices).not.toHaveBeenCalled();
    expect(speechSynthesis.speak).not.toHaveBeenCalled();
    expect(options.onError).not.toHaveBeenCalled();
  });

  it("waits once for voiceschanged and cleans its listener and timeout", async () => {
    const { speechSynthesis, synthesizer, timers } = createHarness();
    const playback = synthesizer.speak([makeChunk("等待声音")], makeOptions());

    expect(speechSynthesis.speak).not.toHaveBeenCalled();
    expect(speechSynthesis.voiceListeners.size).toBe(1);
    expect(timers.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1000);
    speechSynthesis.voices = [voice("late", "zh-CN")];
    speechSynthesis.emitVoicesChanged();
    await flushMicrotasks();

    expect(speechSynthesis.speak).toHaveBeenCalledOnce();
    expect(speechSynthesis.voiceListeners.size).toBe(0);
    expect(timers.tasks.size).toBe(0);
    expect(timers.clearTimeout).toHaveBeenCalledOnce();

    FakeUtterance.instances[0].emitEnd();
    await playback;
  });

  it("uses a bounded timeout and safely speaks with no installed voice", async () => {
    const { speechSynthesis, synthesizer, timers } = createHarness();
    const playback = synthesizer.speak([makeChunk("没有声音")], makeOptions());

    timers.runNext();
    await flushMicrotasks();

    expect(speechSynthesis.voiceListeners.size).toBe(0);
    expect(FakeUtterance.instances[0].voice).toBeNull();
    expect(speechSynthesis.speak).toHaveBeenCalledOnce();

    FakeUtterance.instances[0].emitEnd();
    await playback;
  });

  it("makes stale voiceschanged and timeout callbacks inert after replacement", async () => {
    const { speechSynthesis, synthesizer, timers } = createHarness();
    const firstOptions = makeOptions();
    const first = synthesizer.speak([makeChunk("旧等待")], firstOptions);
    const firstRejection = first.catch((error: unknown) => error);
    const staleVoiceListener = speechSynthesis.lastAddedVoiceListener;
    const staleTimeout = timers.lastScheduled;

    const second = synthesizer.speak([makeChunk("新等待")], makeOptions());
    await flushMicrotasks();
    speechSynthesis.voices = [voice("available", "zh-CN")];

    if (staleVoiceListener) {
      speechSynthesis.invokeVoiceListener(staleVoiceListener);
    }
    staleTimeout?.();
    await flushMicrotasks();
    expect(speechSynthesis.speak).not.toHaveBeenCalled();

    speechSynthesis.emitVoicesChanged();
    await flushMicrotasks();

    expect(await firstRejection).toBeInstanceOf(SpeechCancelledError);
    expect(speechSynthesis.speak).toHaveBeenCalledOnce();
    expect(FakeUtterance.instances[0].text).toBe("新等待");

    FakeUtterance.instances[0].emitEnd();
    await second;
  });

  it.each([
    {
      label: "requested URI",
      voices: [voice("zh", "zh-CN"), voice("requested", "en-US")],
      requested: "requested",
      expected: "requested",
    },
    {
      label: "exact zh-CN",
      voices: [
        voice("default", "en-US", true),
        voice("zh-hk", "zh-HK"),
        voice("zh-cn", "zh-CN"),
      ],
      requested: null,
      expected: "zh-cn",
    },
    {
      label: "another zh voice",
      voices: [voice("default", "en-US", true), voice("zh-hk", "zh-HK")],
      requested: null,
      expected: "zh-hk",
    },
    {
      label: "browser default",
      voices: [voice("first", "en-GB"), voice("default", "en-US", true)],
      requested: null,
      expected: "default",
    },
    {
      label: "safe first voice",
      voices: [voice("first", "en-GB"), voice("second", "en-US")],
      requested: null,
      expected: "first",
    },
  ])("selects $label", async ({ voices, requested, expected }) => {
    const { synthesizer } = createHarness(voices);
    const options = { ...makeOptions(), voiceURI: requested };
    const playback = synthesizer.speak([makeChunk("选择声音")], options);
    await flushMicrotasks();

    expect(FakeUtterance.instances[0].voice?.voiceURI).toBe(expected);

    FakeUtterance.instances[0].emitEnd();
    await playback;
  });

  it.each([
    {
      language: "en-US",
      voices: [
        voice("chinese", "zh-CN"),
        voice("english-base", "en-GB"),
        voice("english-exact", "en-US"),
      ],
      expected: "english-exact",
    },
    {
      language: "en-AU",
      voices: [voice("chinese", "zh-CN"), voice("english-base", "en-GB")],
      expected: "english-base",
    },
  ])(
    "selects $language by exact locale then base language",
    async ({ language, voices, expected }) => {
      const { synthesizer } = createHarness(voices);
      const options = { ...makeOptions(), language };
      const playback = synthesizer.speak([makeChunk("language")], options);
      await flushMicrotasks();

      expect(FakeUtterance.instances[0].voice?.voiceURI).toBe(expected);

      FakeUtterance.instances[0].emitEnd();
      await playback;
    },
  );

  it("reports unsupported playback deterministically without browser audio", async () => {
    const synthesizer = new BrowserSpeechSynthesizer({});
    const options = makeOptions();

    expect(synthesizer.supported).toBe(false);
    await expect(
      synthesizer.speak([makeChunk("无法播放")], options),
    ).rejects.toMatchObject({ name: "NotSupportedError" });
    expect(options.onError).toHaveBeenCalledOnce();
    expect(options.onError).toHaveBeenCalledWith("synthesis-failed");
    expect(() => {
      synthesizer.pause();
      synthesizer.resume();
      synthesizer.cancel();
    }).not.toThrow();
  });
});
