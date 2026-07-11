export interface VocabularyEntry {
  spoken: string;
  written: string;
}

export interface VoicePreferences {
  language: "zh-CN";
  rate: number;
  voiceURI: string | null;
  vocabulary: VocabularyEntry[];
  privacyNoticeAccepted: boolean;
}

export const DEFAULT_VOICE_PREFERENCES: VoicePreferences = {
  language: "zh-CN",
  rate: 1,
  voiceURI: null,
  vocabulary: [],
  privacyNoticeAccepted: false,
};

type VoicePreferencesStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

const STORAGE_KEY = "top-writer:voice-preferences";

const clonePreferences = (value: VoicePreferences): VoicePreferences => ({
  ...value,
  vocabulary: value.vocabulary.map((entry) => ({ ...entry })),
});

const createDefaults = () => clonePreferences(DEFAULT_VOICE_PREFERENCES);

const clampRate = (value: number) => Math.min(2, Math.max(0.5, value));

const normalizeSpoken = (value: string) => value.trim().replace(/\s+/g, " ");

const normalizeWritten = (value: string) => value.trim();

const sanitizeVocabularyEntry = (value: unknown): VocabularyEntry | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const candidate = value as Partial<VocabularyEntry>;
  if (
    typeof candidate.spoken !== "string" ||
    typeof candidate.written !== "string"
  ) {
    return null;
  }

  const spoken = normalizeSpoken(candidate.spoken);
  const written = normalizeWritten(candidate.written);
  return spoken && written ? { spoken, written } : null;
};

const sanitizeVocabulary = (value: unknown): VocabularyEntry[] => {
  if (!Array.isArray(value)) return [];

  const entries: VocabularyEntry[] = [];
  for (const candidate of value) {
    const entry = sanitizeVocabularyEntry(candidate);
    if (!entry) continue;

    const index = entries.findIndex(
      (current) => normalizeSpoken(current.spoken) === entry.spoken,
    );
    if (index === -1) entries.push(entry);
    else entries[index] = entry;
  }
  return entries;
};

const sanitizePreferences = (value: unknown): VoicePreferences => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createDefaults();
  }

  const candidate = value as Partial<VoicePreferences>;
  return {
    language: "zh-CN",
    rate:
      typeof candidate.rate === "number" && Number.isFinite(candidate.rate)
        ? clampRate(candidate.rate)
        : DEFAULT_VOICE_PREFERENCES.rate,
    voiceURI:
      candidate.voiceURI === null
        ? null
        : typeof candidate.voiceURI === "string" && candidate.voiceURI.trim()
          ? candidate.voiceURI.trim()
          : null,
    vocabulary: sanitizeVocabulary(candidate.vocabulary),
    privacyNoticeAccepted:
      typeof candidate.privacyNoticeAccepted === "boolean"
        ? candidate.privacyNoticeAccepted
        : DEFAULT_VOICE_PREFERENCES.privacyNoticeAccepted,
  };
};

const preferencesEqual = (left: VoicePreferences, right: VoicePreferences) =>
  left.language === right.language &&
  left.rate === right.rate &&
  left.voiceURI === right.voiceURI &&
  left.privacyNoticeAccepted === right.privacyNoticeAccepted &&
  left.vocabulary.length === right.vocabulary.length &&
  left.vocabulary.every(
    (entry, index) =>
      entry.spoken === right.vocabulary[index].spoken &&
      entry.written === right.vocabulary[index].written,
  );

const defaultStorage = (): VoicePreferencesStorage | null => {
  try {
    return (
      (
        globalThis as typeof globalThis & {
          localStorage?: VoicePreferencesStorage;
        }
      ).localStorage ?? null
    );
  } catch {
    return null;
  }
};

export class VoicePreferencesStore extends EventTarget {
  private readonly injectedStorage: VoicePreferencesStorage | null | undefined;
  private resolvedStorage: VoicePreferencesStorage | null | undefined;
  private preferences: VoicePreferences | null = null;
  private persistedRecordPresent = false;

  constructor(storage?: VoicePreferencesStorage | null) {
    super();
    this.injectedStorage = storage;
  }

  get value(): VoicePreferences {
    return clonePreferences(this.ensureLoaded());
  }

  update(patch: Partial<Omit<VoicePreferences, "vocabulary">>): void {
    const next = clonePreferences(this.ensureLoaded());

    if (patch.language === "zh-CN") next.language = "zh-CN";
    if (typeof patch.rate === "number" && Number.isFinite(patch.rate)) {
      next.rate = clampRate(patch.rate);
    }
    if (patch.voiceURI === null) next.voiceURI = null;
    else if (typeof patch.voiceURI === "string") {
      next.voiceURI = patch.voiceURI.trim() || null;
    }
    if (typeof patch.privacyNoticeAccepted === "boolean") {
      next.privacyNoticeAccepted = patch.privacyNoticeAccepted;
    }

    this.commit(next, "set");
  }

  addVocabulary(entry: VocabularyEntry): void {
    const sanitized = sanitizeVocabularyEntry(entry);
    if (!sanitized) return;

    const next = clonePreferences(this.ensureLoaded());
    const index = next.vocabulary.findIndex(
      (current) => normalizeSpoken(current.spoken) === sanitized.spoken,
    );
    if (index === -1) next.vocabulary.push(sanitized);
    else next.vocabulary[index] = sanitized;
    this.commit(next, "set");
  }

  removeVocabulary(spoken: string): void {
    if (typeof spoken !== "string") return;

    const normalized = normalizeSpoken(spoken);
    if (!normalized) return;

    const next = clonePreferences(this.ensureLoaded());
    next.vocabulary = next.vocabulary.filter(
      (entry) => normalizeSpoken(entry.spoken) !== normalized,
    );
    this.commit(next, "set");
  }

  clear(): void {
    this.commit(createDefaults(), "remove");
  }

  private storage(): VoicePreferencesStorage | null {
    if (this.resolvedStorage !== undefined) return this.resolvedStorage;
    this.resolvedStorage =
      this.injectedStorage === undefined
        ? defaultStorage()
        : this.injectedStorage;
    return this.resolvedStorage;
  }

  private ensureLoaded(): VoicePreferences {
    if (this.preferences) return this.preferences;

    let persisted: string | null = null;
    try {
      persisted = this.storage()?.getItem(STORAGE_KEY) ?? null;
    } catch {
      persisted = null;
    }

    if (persisted !== null) this.persistedRecordPresent = true;

    if (persisted === null) {
      this.preferences = createDefaults();
      return this.preferences;
    }

    try {
      this.preferences = sanitizePreferences(JSON.parse(persisted));
    } catch {
      this.preferences = createDefaults();
    }
    return this.preferences;
  }

  private commit(next: VoicePreferences, persistence: "set" | "remove"): void {
    const current = this.ensureLoaded();
    const valueChanged = !preferencesEqual(current, next);

    if (valueChanged) this.preferences = clonePreferences(next);

    if (persistence === "remove") {
      if (this.persistedRecordPresent) {
        try {
          const storage = this.storage();
          if (storage) {
            storage.removeItem(STORAGE_KEY);
            this.persistedRecordPresent = false;
          }
        } catch {
          // Keep the flag set so a later clear can retry.
        }
      }
    } else if (valueChanged) {
      try {
        const storage = this.storage();
        if (storage) {
          storage.setItem(STORAGE_KEY, JSON.stringify(this.preferences));
          this.persistedRecordPresent = true;
        }
      } catch {
        // Storage failures must not block in-memory preferences.
      }
    }

    if (!valueChanged) return;

    this.dispatchEvent(
      new CustomEvent<VoicePreferences>("change", {
        detail: clonePreferences(next),
      }),
    );
  }
}

export const normalizeTranscript = (
  transcript: string,
  vocabulary: readonly VocabularyEntry[],
) => {
  const entries = sanitizeVocabulary(vocabulary).sort(
    (left, right) => right.spoken.length - left.spoken.length,
  );
  if (entries.length === 0 || !transcript) return transcript;

  let normalized = "";
  let index = 0;
  while (index < transcript.length) {
    const match = entries.find((entry) =>
      transcript.startsWith(entry.spoken, index),
    );
    if (match) {
      normalized += match.written;
      index += match.spoken.length;
    } else {
      normalized += transcript[index];
      index += 1;
    }
  }
  return normalized;
};
