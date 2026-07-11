import {
  createAbortError,
  type TextGenerationService,
} from "../llms/text-generation-service";
import type { UserConfig } from "../components/wordflow/user-config";
import type {
  EditorSnapshot,
  LocateCandidate,
  ParagraphRef,
  VoiceRange,
} from "./types";

const normalizeForMatching = (value: string) =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\p{White_Space}\p{Punctuation}]+/gu, "");

const bigrams = (value: string) => {
  const codepoints = Array.from(value);
  const result = new Set<string>();
  for (let index = 0; index + 1 < codepoints.length; index += 1) {
    result.add(`${codepoints[index]}${codepoints[index + 1]}`);
  }
  return result;
};

const jaccard = (left: ReadonlySet<string>, right: ReadonlySet<string>) => {
  if (left.size === 0 || right.size === 0) return 0;

  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / (left.size + right.size - intersection);
};

const isAbortError = (error: unknown) =>
  (error instanceof Error && error.name === "AbortError") ||
  (typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError");

const rangeForParagraph = (
  paragraph: ParagraphRef,
  revision: number,
): VoiceRange => ({
  revision,
  from: paragraph.nodeFrom,
  to: paragraph.nodeTo,
  text: paragraph.text,
  paragraphIndexes: [paragraph.index],
  block: true,
});

const localCandidates = (
  shortlist: Array<{ paragraph: ParagraphRef; score: number }>,
  revision: number,
): LocateCandidate[] =>
  shortlist.slice(0, 3).map(({ paragraph, score }) => ({
    range: rangeForParagraph(paragraph, revision),
    score,
    reason: "本地相关度匹配",
  }));

const parseModelCandidates = (
  response: string,
  shortlist: Array<{ paragraph: ParagraphRef; score: number }>,
  revision: number,
): LocateCandidate[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(response);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) return null;
  if (parsed.length === 0) return [];

  const paragraphsByIndex = new Map(
    shortlist.map(({ paragraph }) => [paragraph.index, paragraph]),
  );
  const deduplicated = new Map<number, LocateCandidate>();

  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      continue;
    }
    const { index, score, reason } = item as Record<string, unknown>;
    const candidateIndex =
      typeof index === "number" && Number.isInteger(index) ? index : undefined;
    const paragraph =
      candidateIndex === undefined
        ? undefined
        : paragraphsByIndex.get(candidateIndex);
    if (
      candidateIndex === undefined ||
      !paragraph ||
      typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1 ||
      typeof reason !== "string" ||
      reason.trim().length === 0
    ) {
      continue;
    }

    const candidate: LocateCandidate = {
      range: rangeForParagraph(paragraph, revision),
      score,
      reason,
    };
    const previous = deduplicated.get(candidateIndex);
    if (!previous || candidate.score > previous.score) {
      deduplicated.set(candidateIndex, candidate);
    }
  }

  if (deduplicated.size === 0) return null;

  return [...deduplicated.values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.range.paragraphIndexes[0] - right.range.paragraphIndexes[0],
    )
    .slice(0, 3);
};

export const shortlistParagraphs = (
  query: string,
  paragraphs: ParagraphRef[],
  limit = 8,
): Array<{ paragraph: ParagraphRef; score: number }> => {
  const normalizedQuery = normalizeForMatching(query);
  const maxResults = Number.isFinite(limit)
    ? Math.max(0, Math.floor(limit))
    : 0;
  if (
    normalizedQuery.length === 0 ||
    paragraphs.length === 0 ||
    maxResults === 0
  ) {
    return [];
  }

  const queryBigrams = bigrams(normalizedQuery);
  return paragraphs
    .map((paragraph, inputOrder) => {
      const normalizedParagraph = normalizeForMatching(paragraph.text);
      const score = normalizedParagraph.includes(normalizedQuery)
        ? 1
        : jaccard(queryBigrams, bigrams(normalizedParagraph));
      return { paragraph, score, inputOrder };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.paragraph.index - right.paragraph.index ||
        left.inputOrder - right.inputOrder,
    )
    .slice(0, maxResults)
    .map(({ paragraph, score }) => ({ paragraph, score }));
};

export class SemanticLocator {
  constructor(private readonly generator: TextGenerationService) {}

  async locate(
    query: string,
    snapshot: EditorSnapshot,
    context: { userConfig: UserConfig; userID: string; signal?: AbortSignal },
  ): Promise<LocateCandidate[]> {
    if (context.signal?.aborted) throw createAbortError();

    const normalizedQuery = normalizeForMatching(query);
    if (normalizedQuery.length === 0 || snapshot.paragraphs.length === 0) {
      return [];
    }

    const exactMatches = snapshot.paragraphs.filter((paragraph) =>
      normalizeForMatching(paragraph.text).includes(normalizedQuery),
    );
    if (exactMatches.length === 1) {
      return [
        {
          range: rangeForParagraph(exactMatches[0], snapshot.revision),
          score: 1,
          reason: "精确文本匹配",
        },
      ];
    }

    const shortlist = shortlistParagraphs(query, snapshot.paragraphs, 8);
    if (shortlist.length === 0) return [];

    const prompt = [
      "你是文档段落定位器。只可从候选段落中选择，不要使用候选外的信息。",
      "严格只返回 JSON 数组，每项必须是 {index,score,reason}。",
      JSON.stringify({
        query,
        candidates: shortlist.map(({ paragraph }) => ({
          index: paragraph.index,
          text: paragraph.text,
        })),
      }),
    ].join("\n");

    try {
      const response = await this.generator.generate({
        prompt,
        temperature: 0,
        userConfig: context.userConfig,
        userID: context.userID,
        signal: context.signal,
        useCache: false,
      });
      if (context.signal?.aborted) throw createAbortError();

      return (
        parseModelCandidates(response, shortlist, snapshot.revision) ??
        localCandidates(shortlist, snapshot.revision)
      );
    } catch (error) {
      if (isAbortError(error) || context.signal?.aborted) throw error;
      return localCandidates(shortlist, snapshot.revision);
    }
  }
}
