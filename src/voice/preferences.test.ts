import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_VOICE_PREFERENCES,
  VoicePreferencesStore,
  normalizeTranscript,
  type VoicePreferences,
} from "./preferences";

const STORAGE_KEY = "top-writer:voice-preferences";

class MemoryStorage {
  readonly values = new Map<string, string>();
  readonly getItem = vi.fn((key: string) => this.values.get(key) ?? null);
  readonly setItem = vi.fn((key: string, value: string) => {
    this.values.set(key, value);
  });
  readonly removeItem = vi.fn((key: string) => {
    this.values.delete(key);
  });
}

describe("VoicePreferencesStore", () => {
  it("loads Mandarin defaults lazily when storage is empty", () => {
    const storage = new MemoryStorage();
    const store = new VoicePreferencesStore(storage);

    expect(storage.getItem).not.toHaveBeenCalled();
    expect(store.value).toEqual(DEFAULT_VOICE_PREFERENCES);
    expect(storage.getItem).toHaveBeenCalledOnce();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("deep-freezes the exported defaults used by future stores", () => {
    expect(Object.isFrozen(DEFAULT_VOICE_PREFERENCES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_VOICE_PREFERENCES.vocabulary)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(DEFAULT_VOICE_PREFERENCES, "rate")
        ?.writable,
    ).toBe(false);

    expect(new VoicePreferencesStore(new MemoryStorage()).value).toEqual({
      language: "zh-CN",
      rate: 1,
      voiceURI: null,
      vocabulary: [],
      privacyNoticeAccepted: false,
    });
  });

  it("loads valid persisted fields and defaults invalid fields", () => {
    const storage = new MemoryStorage();
    storage.values.set(
      STORAGE_KEY,
      JSON.stringify({
        language: "en-US",
        rate: 1.75,
        voiceURI: "voice://mandarin",
        vocabulary: [
          { spoken: "  Top   Writer ", written: " 顶级写作 " },
          { spoken: "", written: "忽略" },
          { spoken: 42, written: "忽略" },
        ],
        privacyNoticeAccepted: true,
      }),
    );

    expect(new VoicePreferencesStore(storage).value).toEqual({
      language: "zh-CN",
      rate: 1.75,
      voiceURI: "voice://mandarin",
      vocabulary: [{ spoken: "Top Writer", written: "顶级写作" }],
      privacyNoticeAccepted: true,
    });
  });

  it.each(["{bad json", "null", "[]"])(
    "isolates corrupt persisted data %s",
    (persisted) => {
      const storage = new MemoryStorage();
      storage.values.set(STORAGE_KEY, persisted);

      expect(() => new VoicePreferencesStore(storage).value).not.toThrow();
      expect(new VoicePreferencesStore(storage).value).toEqual(
        DEFAULT_VOICE_PREFERENCES,
      );
    },
  );

  it("isolates storage access failures", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("quota");
      }),
      removeItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };
    const store = new VoicePreferencesStore(storage);

    expect(store.value).toEqual(DEFAULT_VOICE_PREFERENCES);
    expect(() => store.update({ rate: 1.5 })).not.toThrow();
    expect(store.value.rate).toBe(1.5);
    expect(() => store.clear()).not.toThrow();
  });

  it("treats a failed read as unknown and removes after recovery", () => {
    const storage = new MemoryStorage();
    storage.values.set(STORAGE_KEY, JSON.stringify(DEFAULT_VOICE_PREFERENCES));
    storage.getItem.mockImplementationOnce(() => {
      throw new Error("temporarily blocked");
    });
    const store = new VoicePreferencesStore(storage);

    expect(store.value).toEqual(DEFAULT_VOICE_PREFERENCES);
    store.clear();

    expect(storage.removeItem).toHaveBeenCalledOnce();
    expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(storage.values.has(STORAGE_KEY)).toBe(false);
  });

  it("treats an explicitly null storage as disabled", () => {
    const globalStorage = new MemoryStorage();
    vi.stubGlobal("localStorage", globalStorage);

    try {
      const store = new VoicePreferencesStore(null);
      store.update({ rate: 1.25 });

      expect(store.value.rate).toBe(1.25);
      expect(globalStorage.getItem).not.toHaveBeenCalled();
      expect(globalStorage.setItem).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("clamps finite speech rate to 0.5..2 and ignores non-finite values", () => {
    const storage = new MemoryStorage();
    const store = new VoicePreferencesStore(storage);

    store.update({ rate: -10 });
    expect(store.value.rate).toBe(0.5);
    store.update({ rate: 10 });
    expect(store.value.rate).toBe(2);
    const writes = storage.setItem.mock.calls.length;
    store.update({ rate: Number.NaN });
    store.update({ rate: Number.POSITIVE_INFINITY });

    expect(store.value.rate).toBe(2);
    expect(storage.setItem).toHaveBeenCalledTimes(writes);
  });

  it("normalizes an empty voice URI to null on load and update", () => {
    const storage = new MemoryStorage();
    storage.values.set(
      STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_VOICE_PREFERENCES, voiceURI: "   " }),
    );
    const store = new VoicePreferencesStore(storage);

    expect(store.value.voiceURI).toBeNull();
    store.update({ voiceURI: "voice://mandarin" });
    store.update({ voiceURI: "   " });

    expect(store.value.voiceURI).toBeNull();
  });

  it("returns and emits deep clones", () => {
    const store = new VoicePreferencesStore(new MemoryStorage());
    const details: VoicePreferences[] = [];
    store.addEventListener("change", (event) => {
      details.push((event as CustomEvent<VoicePreferences>).detail);
    });

    store.addVocabulary({ spoken: "Open AI", written: "OpenAI" });
    const firstRead = store.value;
    firstRead.vocabulary[0].written = "mutated";
    details[0].vocabulary[0].written = "also mutated";

    expect(store.value.vocabulary).toEqual([
      { spoken: "Open AI", written: "OpenAI" },
    ]);
  });

  it("does not persist or emit for no-op updates", () => {
    const storage = new MemoryStorage();
    const store = new VoicePreferencesStore(storage);
    const listener = vi.fn();
    store.addEventListener("change", listener);
    void store.value;

    store.update({ rate: 1, language: "zh-CN" });
    store.removeVocabulary("missing");
    store.clear();

    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("retries a dirty write after storage recovers without re-emitting", () => {
    const storage = new MemoryStorage();
    storage.setItem.mockImplementationOnce(() => {
      throw new Error("quota");
    });
    const store = new VoicePreferencesStore(storage);
    const listener = vi.fn();
    store.addEventListener("change", listener);

    store.update({ rate: 1.5 });
    expect(storage.values.has(STORAGE_KEY)).toBe(false);

    store.update({ rate: 1.5 });
    store.update({ rate: 1.5 });

    expect(storage.setItem).toHaveBeenCalledTimes(2);
    expect(JSON.parse(storage.values.get(STORAGE_KEY) ?? "{}").rate).toBe(1.5);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("removes a serialized default record without emitting a change", () => {
    const storage = new MemoryStorage();
    storage.values.set(STORAGE_KEY, JSON.stringify(DEFAULT_VOICE_PREFERENCES));
    const store = new VoicePreferencesStore(storage);
    const listener = vi.fn();
    store.addEventListener("change", listener);

    expect(store.value).toEqual(DEFAULT_VOICE_PREFERENCES);
    store.clear();

    expect(storage.removeItem).toHaveBeenCalledOnce();
    expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(storage.values.has(STORAGE_KEY)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("removes a corrupt persisted record after falling back to defaults", () => {
    const storage = new MemoryStorage();
    storage.values.set(STORAGE_KEY, "{bad json");
    const store = new VoicePreferencesStore(storage);
    const listener = vi.fn();
    store.addEventListener("change", listener);

    expect(store.value).toEqual(DEFAULT_VOICE_PREFERENCES);
    store.clear();

    expect(storage.removeItem).toHaveBeenCalledOnce();
    expect(storage.values.has(STORAGE_KEY)).toBe(false);
    expect(listener).not.toHaveBeenCalled();
  });

  it("does not remove or emit when clearing defaults from empty storage", () => {
    const storage = new MemoryStorage();
    const store = new VoicePreferencesStore(storage);
    const listener = vi.fn();
    store.addEventListener("change", listener);

    expect(store.value).toEqual(DEFAULT_VOICE_PREFERENCES);
    store.clear();

    expect(storage.removeItem).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it("retries removing a persisted record after a storage failure", () => {
    const storage = new MemoryStorage();
    storage.values.set(STORAGE_KEY, JSON.stringify(DEFAULT_VOICE_PREFERENCES));
    storage.removeItem.mockImplementationOnce(() => {
      throw new Error("blocked");
    });
    const store = new VoicePreferencesStore(storage);

    expect(store.value).toEqual(DEFAULT_VOICE_PREFERENCES);
    expect(() => store.clear()).not.toThrow();
    expect(storage.values.has(STORAGE_KEY)).toBe(true);

    store.clear();

    expect(storage.removeItem).toHaveBeenCalledTimes(2);
    expect(storage.values.has(STORAGE_KEY)).toBe(false);
  });

  it("deduplicates, updates, and removes vocabulary by normalized spoken form", () => {
    const storage = new MemoryStorage();
    const store = new VoicePreferencesStore(storage);
    const listener = vi.fn();
    store.addEventListener("change", listener);

    store.addVocabulary({ spoken: "  Top   Writer  ", written: " 顶级写作 " });
    store.addVocabulary({ spoken: "Top Writer", written: "Top Writer" });
    store.addVocabulary({ spoken: " ", written: "ignored" });

    expect(store.value.vocabulary).toEqual([
      { spoken: "Top Writer", written: "Top Writer" },
    ]);
    expect(listener).toHaveBeenCalledTimes(2);

    store.removeVocabulary("  Top   Writer ");
    expect(store.value.vocabulary).toEqual([]);
    expect(
      JSON.parse(storage.values.get(STORAGE_KEY) ?? "{}").vocabulary,
    ).toEqual([]);
  });

  it("does not apply compatibility expansion to vocabulary keys", () => {
    const store = new VoicePreferencesStore(new MemoryStorage());

    store.addVocabulary({ spoken: "Ａ", written: "全角" });
    store.addVocabulary({ spoken: "A", written: "半角" });
    store.removeVocabulary("A");

    expect(store.value.vocabulary).toEqual([{ spoken: "Ａ", written: "全角" }]);
  });

  it("clears changed preferences and removes persisted storage", () => {
    const storage = new MemoryStorage();
    const store = new VoicePreferencesStore(storage);
    store.update({ rate: 1.5, privacyNoticeAccepted: true });
    const listener = vi.fn();
    store.addEventListener("change", listener);

    store.clear();

    expect(store.value).toEqual(DEFAULT_VOICE_PREFERENCES);
    expect(storage.removeItem).toHaveBeenCalledWith(STORAGE_KEY);
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe("normalizeTranscript", () => {
  it("replaces literal custom terms longest-first", () => {
    expect(
      normalizeTranscript("OpenAI 和 Open，以及 a+b", [
        { spoken: "Open", written: "打开" },
        { spoken: "OpenAI", written: "开放人工智能" },
        { spoken: "a+b", written: "总和" },
      ]),
    ).toBe("开放人工智能 和 打开，以及 总和");
  });

  it("performs one non-cascading pass and ignores empty entries", () => {
    expect(
      normalizeTranscript("A B", [
        { spoken: "A", written: "B" },
        { spoken: "B", written: "C" },
        { spoken: "", written: "ignored" },
        { spoken: "ignored", written: "" },
      ]),
    ).toBe("B C");
  });

  it("treats regex metacharacters and replacement tokens literally", () => {
    expect(
      normalizeTranscript(" C++ .* [词] \\ $& ", [
        { spoken: "C++", written: "C Plus Plus" },
        { spoken: ".*", written: "点星" },
        { spoken: "[词]", written: "术语" },
        { spoken: "\\", written: "反斜杠" },
        { spoken: "$&", written: "美元与" },
      ]),
    ).toBe(" C Plus Plus 点星 术语 反斜杠 美元与 ");
  });

  it("preserves unmatched transcript and written replacement spacing", () => {
    expect(
      normalizeTranscript("  A  untouched  ", [
        { spoken: "A", written: "X  Y" },
      ]),
    ).toBe("  X  Y  untouched  ");
  });
});
