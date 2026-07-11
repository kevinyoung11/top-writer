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

  const positions = range.paragraphIndexes.map((index) => {
    if (!Number.isInteger(index)) return -1;
    return snapshot.paragraphs.findIndex(
      (paragraph) => paragraph.index === index,
    );
  });
  if (positions.some((position) => position < 0)) return null;

  for (let index = 1; index < positions.length; index += 1) {
    if (
      positions[index] !== positions[index - 1] + 1 ||
      range.paragraphIndexes[index] !== range.paragraphIndexes[index - 1] + 1
    ) {
      return null;
    }
  }

  const firstPosition = positions[0];
  const lastPosition = positions[positions.length - 1];
  const first = snapshot.paragraphs[firstPosition];
  const last = snapshot.paragraphs[lastPosition];
  if (
    range.from < first.nodeFrom ||
    range.from >= first.nodeTo ||
    range.to <= last.nodeFrom ||
    range.to > last.nodeTo
  ) {
    return null;
  }

  return { firstPosition, lastPosition };
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
    if (replacement.includes("```")) {
      throw new RewriteServiceError("non-plain-output");
    }
    if (replacement === input.range.text.trim()) {
      throw new RewriteServiceError("unchanged-output");
    }

    return replacement;
  }
}
