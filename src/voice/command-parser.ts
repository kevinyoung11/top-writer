import type { VoiceAction, VoicePlan, VoiceScope } from "./types";

const locatePattern =
  /^(?:请\s*)?(?:找到|找出|定位)(?:一下)?(?:讲|关于)?(.+?)(?:的)?(?:那一段|段落|那段|地方|部分)(?=$|[，,；;\s]|然后|再)/;

const locateVerbPattern = /^(?:请\s*)?(?:找到|找出|定位)/;
const rewritePattern = /改|润色|调整|压缩|精简/;
const directRewritePattern =
  /^(?:请\s*)?(?:(?:改写|改得|改成|润色|调整|压缩|精简)|(?:把|将).+(?:改写|改得|改成|改|润色|调整|压缩|精简))/;
const compoundRewritePattern = /^(?:改写|改得|改成|改|润色|调整|压缩|精简)/;
const compoundReadPattern =
  /^(?:朗读|读|念)(?:一下|一遍)?(?=$|[\s，,；;]|然后|再)/;
const directUndoPattern =
  /^(?:请\s*)?(?:撤回|恢复刚才(?:的修改)?|回到修改前)(?:一下)?$/;
const directControlPattern =
  /^(?:请\s*)?(?:(暂停|继续|停止)(?:朗读|播放)?|(?:朗读|播放)?(快一点|慢一点))(?:一下)?$/;
const directReadPattern =
  /^(?:请\s*)?(?:(?:给我\s*)?(?:朗读|读|念)\s*(?:一下\s*)?(?:(?:第[\s\S]*?段)|(?:上一段|前一段|下一段|后一段|当前段|当前一段|这一段|这段|选中(?:的)?(?:内容|文字)?|从头(?:到尾)?|全文|全部))?\s*(?:一下|一遍)?|(?:从头(?:到尾)?|全文|全部)\s*(?:给我\s*)?(?:朗读|读|念)\s*(?:一下|一遍)?)$/;
const negatedCommandPattern =
  /^(?:请\s*)?(?:不要|别)\s*(?:找到|找出|定位|撤回|恢复刚才|回到修改前|暂停|继续|停止|快一点|慢一点|朗读|读|念|改写|改得|改成|润色|调整|压缩|精简|改(?=$|\s|一下|这|那|第|选中))/;

const controlValues: Record<string, NonNullable<VoiceAction["control"]>> = {
  暂停: "pause",
  继续: "resume",
  停止: "stop",
  快一点: "faster",
  慢一点: "slower",
};

const normalize = (value: string) =>
  value
    .replace(/[。！？!?]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const readScope = (text: string): VoiceScope | null => {
  const numbered = text.match(/第\s*([\s\S]*?)\s*段/);
  if (numbered) {
    const rawIndex = numbered[1].trim();
    if (!/^\d+$/.test(rawIndex)) return null;

    const oneBasedIndex = Number(rawIndex);

    return Number.isSafeInteger(oneBasedIndex) && oneBasedIndex >= 1
      ? { kind: "paragraph", index: oneBasedIndex - 1 }
      : null;
  }

  if (/从头|全文|全部/.test(text)) return { kind: "document" };
  if (/选中/.test(text)) return { kind: "selection" };
  if (/上一段|前一段/.test(text)) return { kind: "previous" };
  if (/下一段|后一段/.test(text)) return { kind: "next" };
  return { kind: "current" };
};

const normalizeSemanticQuery = (value: string) =>
  value
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const stripActionSeparators = (value: string) =>
  value.replace(/^(?:(?:[\s，,；;]+)|(?:(?:然后|再)\s*))+/u, "").trim();

const unsupportedPlan = (transcript: string): VoicePlan => ({
  transcript,
  confidence: 0,
  actions: [],
});

const rewriteConstraint = (text: string): string[] => {
  const rewriteStart = text.search(rewritePattern);
  if (rewriteStart === -1) return ["保持原意并改善表达"];

  const constraint = text.slice(rewriteStart).trim();
  return constraint ? [constraint] : ["保持原意并改善表达"];
};

export const parseVoicePlan = (rawTranscript: string): VoicePlan => {
  const transcript = normalize(rawTranscript);
  const actions: VoiceAction[] = [];

  if (!transcript || negatedCommandPattern.test(transcript)) {
    return unsupportedPlan(transcript);
  }

  const locate = transcript.match(locatePattern);

  if (locate) {
    const query = normalizeSemanticQuery(locate[1]);
    if (!/[\p{L}\p{N}]/u.test(query)) return unsupportedPlan(transcript);

    actions.push({
      intent: "locate",
      scope: { kind: "semantic", query },
      constraints: [],
    });

    let remainder = stripActionSeparators(
      transcript.slice((locate.index ?? 0) + locate[0].length),
    );
    const read = remainder.match(compoundReadPattern);
    if (read) {
      actions.push({
        intent: "read",
        scope: { kind: "resolved-target" },
        constraints: [],
      });
      remainder = stripActionSeparators(remainder.slice(read[0].length));
    }
    if (compoundRewritePattern.test(remainder)) {
      actions.push({
        intent: "rewrite",
        scope: { kind: "resolved-target" },
        constraints: rewriteConstraint(remainder),
      });
      remainder = "";
    }

    if (remainder) return unsupportedPlan(transcript);
  } else if (locateVerbPattern.test(transcript)) {
    return unsupportedPlan(transcript);
  } else if (directUndoPattern.test(transcript)) {
    actions.push({ intent: "undo", scope: null, constraints: [] });
  } else {
    const control = transcript.match(directControlPattern);
    if (control) {
      const value = control[1] ?? control[2];
      actions.push({
        intent: "control",
        scope: null,
        constraints: [],
        control: controlValues[value],
      });
    } else if (directReadPattern.test(transcript)) {
      const scope = readScope(transcript);
      if (scope) actions.push({ intent: "read", scope, constraints: [] });
    } else if (directRewritePattern.test(transcript)) {
      actions.push({
        intent: "rewrite",
        scope: /选中/.test(transcript)
          ? { kind: "selection" }
          : { kind: "effective" },
        constraints: [transcript],
      });
    }
  }

  return {
    transcript,
    confidence: actions.length > 0 ? 1 : 0,
    actions: actions.slice(0, 3),
  };
};
