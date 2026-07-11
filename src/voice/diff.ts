import DiffMatchPatch from "diff-match-patch";

import type { DiffSegment } from "./types";

const DIFF_DELETE = -1;
const DIFF_EQUAL = 0;
const DIFF_INSERT = 1;

const MAX_SEGMENTS_PER_TEXT = 60_000;
const FIRST_TOKEN_CODE = 1;
const LAST_TOKEN_CODE = 0xffff;
const FIRST_SURROGATE = 0xd800;
const LAST_SURROGATE = 0xdfff;

type DiffOperation =
  typeof DIFF_DELETE | typeof DIFF_EQUAL | typeof DIFF_INSERT;
type RawDiff = [DiffOperation, string];

interface StructuralSegmenter {
  segment(input: string): unknown;
}

interface StructuralSegmenterConstructor {
  new (
    locales?: string | string[],
    options?: { granularity?: string },
  ): StructuralSegmenter;
}

interface EncodedTokens {
  original: string;
  replacement: string;
  tokenByCode: Map<number, string>;
}

const kindByOperation = {
  [DIFF_DELETE]: "delete",
  [DIFF_EQUAL]: "equal",
  [DIFF_INSERT]: "insert",
} as const;

const isObjectLike = (value: unknown): value is Record<PropertyKey, unknown> =>
  (typeof value === "object" && value !== null) || typeof value === "function";

const createSegmenter = (): StructuralSegmenter | null => {
  try {
    const intl = (
      globalThis as unknown as {
        Intl?: { Segmenter?: unknown };
      }
    ).Intl;
    const Segmenter = intl?.Segmenter;

    if (typeof Segmenter !== "function") return null;

    const segmenter = new (Segmenter as StructuralSegmenterConstructor)(
      "zh-CN",
      { granularity: "word" },
    );

    return segmenter && typeof segmenter.segment === "function"
      ? segmenter
      : null;
  } catch {
    return null;
  }
};

const collectTokens = (
  segmenter: StructuralSegmenter,
  input: string,
): string[] | null => {
  try {
    const segmented = segmenter.segment(input);
    if (!isObjectLike(segmented)) return null;

    const iterator = segmented[Symbol.iterator];
    if (typeof iterator !== "function") return null;

    const tokens: string[] = [];
    let rawLength = 0;

    for (const entry of segmented as unknown as Iterable<unknown>) {
      if (tokens.length >= MAX_SEGMENTS_PER_TEXT || !isObjectLike(entry)) {
        return null;
      }

      const token = entry.segment;
      if (typeof token !== "string" || token.length === 0) return null;

      rawLength += token.length;
      if (rawLength > input.length) return null;
      tokens.push(token);
    }

    return rawLength === input.length && tokens.join("") === input
      ? tokens
      : null;
  } catch {
    return null;
  }
};

const nextSafeTokenCode = (current: number): number | null => {
  const candidate =
    current >= FIRST_SURROGATE && current <= LAST_SURROGATE
      ? LAST_SURROGATE + 1
      : current;

  return candidate <= LAST_TOKEN_CODE ? candidate : null;
};

const encodeTokenPair = (
  originalTokens: readonly string[],
  replacementTokens: readonly string[],
): EncodedTokens | null => {
  const tokenToCode = new Map<string, number>();
  const tokenByCode = new Map<number, string>();
  let nextCode = FIRST_TOKEN_CODE;

  const encode = (tokens: readonly string[]): string | null => {
    const encoded: string[] = [];

    for (const token of tokens) {
      let code = tokenToCode.get(token);

      if (code === undefined) {
        const safeCode = nextSafeTokenCode(nextCode);
        if (safeCode === null) return null;

        code = safeCode;
        nextCode = safeCode + 1;
        tokenToCode.set(token, code);
        tokenByCode.set(code, token);
      }

      encoded.push(String.fromCharCode(code));
    }

    return encoded.join("");
  };

  const original = encode(originalTokens);
  if (original === null) return null;

  const replacement = encode(replacementTokens);
  if (replacement === null) return null;

  return { original, replacement, tokenByCode };
};

const decodeDiffs = (
  diffs: readonly [number, string][],
  tokenByCode: ReadonlyMap<number, string>,
): RawDiff[] | null => {
  const decoded: RawDiff[] = [];

  for (const [operation, encoded] of diffs) {
    if (
      operation !== DIFF_DELETE &&
      operation !== DIFF_EQUAL &&
      operation !== DIFF_INSERT
    ) {
      return null;
    }

    const tokens: string[] = [];
    for (let index = 0; index < encoded.length; index += 1) {
      const token = tokenByCode.get(encoded.charCodeAt(index));
      if (token === undefined) return null;
      tokens.push(token);
    }

    decoded.push([operation, tokens.join("")]);
  }

  return decoded;
};

const runDiff = (original: string, replacement: string): RawDiff[] | null => {
  try {
    const engine = new DiffMatchPatch();
    const diffs = engine.diff_main(original, replacement, false);
    engine.diff_cleanupSemantic(diffs);

    return diffs.every(
      ([operation]) =>
        operation === DIFF_DELETE ||
        operation === DIFF_EQUAL ||
        operation === DIFF_INSERT,
    )
      ? (diffs as RawDiff[])
      : null;
  } catch {
    return null;
  }
};

const runTokenDiff = (
  originalTokens: readonly string[],
  replacementTokens: readonly string[],
): RawDiff[] | null => {
  const encoded = encodeTokenPair(originalTokens, replacementTokens);
  if (!encoded) return null;

  try {
    const engine = new DiffMatchPatch();
    const encodedDiffs = engine.diff_main(
      encoded.original,
      encoded.replacement,
      false,
    );
    const decodedDiffs = decodeDiffs(encodedDiffs, encoded.tokenByCode);
    if (!decodedDiffs) return null;

    engine.diff_cleanupSemantic(decodedDiffs);
    return decodedDiffs;
  } catch {
    return null;
  }
};

const mergeSegments = (diffs: readonly RawDiff[]): DiffSegment[] => {
  const segments: DiffSegment[] = [];

  for (const [operation, text] of diffs) {
    if (!text) continue;

    const kind = kindByOperation[operation];
    const previous = segments[segments.length - 1];

    if (previous?.kind === kind) {
      previous.text += text;
    } else {
      segments.push({ kind, text });
    }
  }

  return segments;
};

const reconstructOriginal = (segments: readonly DiffSegment[]): string =>
  segments
    .filter((segment) => segment.kind !== "insert")
    .map((segment) => segment.text)
    .join("");

const reconstructReplacement = (segments: readonly DiffSegment[]): string =>
  segments
    .filter((segment) => segment.kind !== "delete")
    .map((segment) => segment.text)
    .join("");

const isExactDiff = (
  segments: readonly DiffSegment[],
  original: string,
  replacement: string,
): boolean =>
  reconstructOriginal(segments) === original &&
  reconstructReplacement(segments) === replacement;

const buildCharacterDiff = (
  original: string,
  replacement: string,
): DiffSegment[] => {
  const charactersOriginal = Array.from(original);
  const charactersReplacement = Array.from(replacement);
  const characterDiffs =
    charactersOriginal.length <= MAX_SEGMENTS_PER_TEXT &&
    charactersReplacement.length <= MAX_SEGMENTS_PER_TEXT
      ? runTokenDiff(charactersOriginal, charactersReplacement)
      : null;
  const diffs = characterDiffs ?? runDiff(original, replacement);
  const segments = diffs ? mergeSegments(diffs) : [];

  if (isExactDiff(segments, original, replacement)) return segments;

  return [
    ...(original ? [{ kind: "delete" as const, text: original }] : []),
    ...(replacement ? [{ kind: "insert" as const, text: replacement }] : []),
  ];
};

export const buildDiffSegments = (
  original: string,
  replacement: string,
): DiffSegment[] => {
  if (original === replacement) {
    return original ? [{ kind: "equal", text: original }] : [];
  }
  if (!original) return [{ kind: "insert", text: replacement }];
  if (!replacement) return [{ kind: "delete", text: original }];

  const segmenter = createSegmenter();
  if (!segmenter) return buildCharacterDiff(original, replacement);

  const originalTokens = collectTokens(segmenter, original);
  const replacementTokens = collectTokens(segmenter, replacement);
  if (!originalTokens || !replacementTokens) {
    return buildCharacterDiff(original, replacement);
  }

  const tokenDiffs = runTokenDiff(originalTokens, replacementTokens);
  if (!tokenDiffs) return buildCharacterDiff(original, replacement);

  const segments = mergeSegments(tokenDiffs);
  return isExactDiff(segments, original, replacement)
    ? segments
    : buildCharacterDiff(original, replacement);
};
