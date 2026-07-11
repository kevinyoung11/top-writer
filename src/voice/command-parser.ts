import type { VoiceAction, VoicePlan, VoiceScope } from "./types";

const locatePattern =
  /(?:找到|找出|定位)(?:一下)?(?:讲|关于)?(.+?)(?:的)?(?:那一段|段落|那段|地方|部分)(?=，|,|然后|再|$)/;

const controlPattern = /暂停|继续|停止|快一点|慢一点/;
const rewritePattern = /改|润色|调整|压缩|精简/;

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
  const numbered = text.match(/第\s*([+-]?\s*\d+|负\s*\d+)\s*段/);
  if (numbered) {
    const oneBasedIndex = Number(
      numbered[1].replace(/\s+/g, "").replace(/^负/, "-"),
    );

    return oneBasedIndex >= 1
      ? { kind: "paragraph", index: oneBasedIndex - 1 }
      : null;
  }

  if (/从头|全文|全部/.test(text)) return { kind: "document" };
  if (/选中/.test(text)) return { kind: "selection" };
  if (/上一段|前一段/.test(text)) return { kind: "previous" };
  if (/下一段|后一段/.test(text)) return { kind: "next" };
  return { kind: "current" };
};

const rewriteConstraint = (text: string): string[] => {
  const rewriteStart = text.search(rewritePattern);
  if (rewriteStart === -1) return ["保持原意并改善表达"];

  const constraint = text.slice(rewriteStart).trim();
  return constraint ? [constraint] : ["保持原意并改善表达"];
};

export const parseVoicePlan = (rawTranscript: string): VoicePlan => {
  const transcript = normalize(rawTranscript);
  const actions: VoiceAction[] = [];
  const locate = transcript.match(locatePattern);

  if (locate) {
    actions.push({
      intent: "locate",
      scope: { kind: "semantic", query: locate[1].trim() },
      constraints: [],
    });

    const remainder = transcript.slice((locate.index ?? 0) + locate[0].length);
    if (/读|念/.test(remainder)) {
      actions.push({
        intent: "read",
        scope: { kind: "resolved-target" },
        constraints: [],
      });
    }
    if (rewritePattern.test(remainder)) {
      actions.push({
        intent: "rewrite",
        scope: { kind: "resolved-target" },
        constraints: rewriteConstraint(remainder),
      });
    }
  } else if (/撤回|恢复刚才|回到修改前/.test(transcript)) {
    actions.push({ intent: "undo", scope: null, constraints: [] });
  } else {
    const control = transcript.match(controlPattern);
    if (control) {
      actions.push({
        intent: "control",
        scope: null,
        constraints: [],
        control: controlValues[control[0]],
      });
    } else if (/读|念/.test(transcript)) {
      const scope = readScope(transcript);
      if (scope) actions.push({ intent: "read", scope, constraints: [] });
    } else if (rewritePattern.test(transcript)) {
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
