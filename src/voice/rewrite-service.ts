import type { UserConfig } from "../components/wordflow/user-config";
import {
  createAbortError,
  type TextGenerationService,
} from "../llms/text-generation-service";
import type { EditorSnapshot, VoiceRange } from "./types";

export type RewriteServiceErrorCode =
  | "empty-output"
  | "unchanged-output"
  | "non-plain-output"
  | "invalid-range"
  | "stale-revision";

export class RewriteServiceError extends Error {
  constructor(readonly code: RewriteServiceErrorCode) {
    super(code);
    this.name = "RewriteServiceError";
  }
}

interface RewriteInput {
  snapshot: EditorSnapshot;
  range: VoiceRange;
  constraints: string[];
  userConfig: UserConfig;
  userID: string;
  signal?: AbortSignal;
}

interface ValidatedTarget {
  firstPosition: number;
  lastPosition: number;
}

const canReconstructParagraph = (
  paragraph: EditorSnapshot["paragraphs"][number],
) =>
  typeof paragraph.text === "string" &&
  Number.isSafeInteger(paragraph.index) &&
  Number.isSafeInteger(paragraph.nodeFrom) &&
  Number.isSafeInteger(paragraph.nodeTo) &&
  Number.isSafeInteger(paragraph.from) &&
  Number.isSafeInteger(paragraph.to) &&
  paragraph.nodeFrom < paragraph.nodeTo &&
  paragraph.from === paragraph.nodeFrom + 1 &&
  paragraph.to === paragraph.nodeTo - 1 &&
  paragraph.from <= paragraph.to &&
  paragraph.text.length === paragraph.to - paragraph.from;

const reconstructRangeText = (
  range: VoiceRange,
  paragraphs: EditorSnapshot["paragraphs"],
): string | null => {
  let text = "";

  for (const [position, paragraph] of paragraphs.entries()) {
    if (!canReconstructParagraph(paragraph)) return null;

    const from = Math.max(range.from, paragraph.from);
    const to = Math.min(range.to, paragraph.to);
    const slice =
      from < to
        ? paragraph.text.slice(from - paragraph.from, to - paragraph.from)
        : "";
    if (slice.length !== Math.max(0, to - from)) return null;

    if (position > 0) {
      if (typeof paragraph.separatorBefore !== "string") return null;
      text += paragraph.separatorBefore;
    }
    text += slice;
  }

  return text;
};

const validateTarget = (
  snapshot: EditorSnapshot,
  range: VoiceRange,
): ValidatedTarget | null => {
  if (
    !Number.isSafeInteger(range.from) ||
    !Number.isSafeInteger(range.to) ||
    range.from < 0 ||
    range.to <= range.from ||
    typeof range.text !== "string" ||
    range.text.length === 0 ||
    !Array.isArray(range.paragraphIndexes) ||
    range.paragraphIndexes.length === 0
  ) {
    return null;
  }

  const selected = snapshot.paragraphs
    .map((paragraph, position) => ({ paragraph, position }))
    .filter(
      ({ paragraph }) =>
        range.from < paragraph.nodeTo && range.to > paragraph.nodeFrom,
    );
  if (selected.length !== range.paragraphIndexes.length) return null;

  for (let index = 0; index < selected.length; index += 1) {
    if (
      !Number.isInteger(range.paragraphIndexes[index]) ||
      selected[index].paragraph.index !== range.paragraphIndexes[index] ||
      !canReconstructParagraph(selected[index].paragraph) ||
      (index > 0 &&
        (selected[index].position !== selected[index - 1].position + 1 ||
          range.paragraphIndexes[index] !==
            range.paragraphIndexes[index - 1] + 1))
    ) {
      return null;
    }
  }

  const first = selected[0];
  const last = selected[selected.length - 1];
  if (
    !first ||
    !last ||
    range.from < first.paragraph.nodeFrom ||
    range.from >= first.paragraph.nodeTo ||
    range.to <= last.paragraph.nodeFrom ||
    range.to > last.paragraph.nodeTo
  ) {
    return null;
  }

  if (
    reconstructRangeText(
      range,
      selected.map(({ paragraph }) => paragraph),
    ) !== range.text
  ) {
    return null;
  }

  return { firstPosition: first.position, lastPosition: last.position };
};

const hasNonPlainOutput = (output: string) => {
  const fencedCodeBlock = /(?:^|\n)[ \t]{0,3}(?:`{3,}|~{3,})[^\n]*(?:\n|$)/u;
  const commentaryPrefix =
    /^(?:改写如下|修改如下|改写后(?:的)?(?:文本|版本)?|修改(?:后)?(?:的)?(?:文本|版本)?|(?:以下|这里)是(?:改写|修改)(?:后)?(?:的)?(?:文本|版本)?|建议(?:改写|修改)(?:为|如下)?)[：:]/u;

  return fencedCodeBlock.test(output) || commentaryPrefix.test(output);
};

const promptFor = (input: RewriteInput, target: ValidatedTarget) => {
  const before =
    input.snapshot.paragraphs[target.firstPosition - 1]?.text ?? "";
  const after = input.snapshot.paragraphs[target.lastPosition + 1]?.text ?? "";
  return [
    "请只返回可直接替换目标原文的纯文本，不要解释，不要 Markdown 代码围栏。",
    `前文：${JSON.stringify(before)}`,
    `目标原文：${JSON.stringify(input.range.text)}`,
    `后文：${JSON.stringify(after)}`,
    `修改要求：${JSON.stringify(input.constraints)}`,
  ].join("\n");
};

export class RewriteService {
  constructor(private readonly generator: TextGenerationService) {}

  async rewrite(input: RewriteInput): Promise<string> {
    if (input.signal?.aborted) throw createAbortError();
    if (input.range.revision !== input.snapshot.revision) {
      throw new RewriteServiceError("stale-revision");
    }

    const target = validateTarget(input.snapshot, input.range);
    if (!target) throw new RewriteServiceError("invalid-range");

    const output = await this.generator.generate({
      prompt: promptFor(input, target),
      temperature: 0.2,
      userConfig: input.userConfig,
      userID: input.userID,
      signal: input.signal,
      useCache: false,
    });
    if (input.signal?.aborted) throw createAbortError();

    const replacement = output.trim();
    if (replacement.length === 0) {
      throw new RewriteServiceError("empty-output");
    }
    if (hasNonPlainOutput(replacement)) {
      throw new RewriteServiceError("non-plain-output");
    }
    if (replacement === input.range.text.trim()) {
      throw new RewriteServiceError("unchanged-output");
    }

    return replacement;
  }
}
