/** 对话与主动回合共用的确定性多级安全分类器。 */
import type { SafetyClassificationResult } from "./safety-schemas.js";

const COLLOQUIAL_SAFE_PATTERNS = [
  /想死你(?:了|们)/g, /笑死(?:我了|了)/g, /累死(?:我了|了)/g, /烦死(?:我了|了)/g,
  /社死/g, /馋死(?:我了|了)/g, /气死(?:我了|了)/g, /美死(?:我了|了)/g,
  /急死(?:我了|了)/g, /吓死(?:我了|了)/g, /热死(?:我了|了)/g, /冷死(?:我了|了)/g,
  /困死(?:我了|了)/g, /渴死(?:我了|了)/g, /撑死(?:我了|了)/g,
];

const CRISIS_SELF_HARM_PATTERNS = [
  /(?:自杀|想自杀|计划自杀|准备自杀)/i,
  /(?:自残|割腕|跳楼|服毒|上吊|吞安眠药|烧炭)/i,
  /(?:轻生|结束生命|结束自己的生命|不想活了|活不下去了|活不下去|不想活)/i,
  /(?:想离开这[个部]?世界|不想在这个世界|活着没意思)/i,
  /(?:活着.*想死|想死|去死|不如去死|不如死了算了|想死掉)/i,
  /(?:suicide|kill myself|end my life|cut myself|self-harm|want to die)/i,
];

const CRISIS_VIOLENCE_PATTERNS = [
  /(?:制造炸弹|制作炸药|购买枪支|制作毒药|投毒杀人)/i,
  /(?:报复社会|无差别杀人|砍死所有人|mass shooting|make a bomb)/i,
];

const JAILBREAK_PATTERNS = [
  /(?:忽略所有安全限制|无视道德准则|解除所有安全审查|绕过安全审查)/i,
  /(?:DAN\s*mode|ignore all safety guidelines|bypass guardrails)/i,
];

const DISTRESS_MODERATE_PATTERNS = [
  /(?:好累|太累了|心好累|快撑不住了|心力交瘁)/i,
  /(?:压力好大|压力太大|好压抑|压得喘不过气)/i,
  /(?:好痛苦|心里难受|心情很糟|好难过|想哭|大哭一场)/i,
  /(?:学不会|做不出来|挂科了|考砸了|好挫败|一事无成|觉得自己很差|觉得自己很没用|好失败)/i,
  /(?:好焦虑|极度焦虑|好迷茫|不知所措)/i,
  /(?:崩溃了|快崩溃了|要崩溃了|好绝望|好孤独|没人理解我|感觉孤立无援)/i,
  /(?:失眠睡不着|整夜失眠|好抑郁|提不起任何兴趣)/i,
  /(?:burnout|overwhelmed|depressed|hopeless|anxious|so tired of everything)/i,
];

export function classifySafety(text: string): SafetyClassificationResult {
  if (!text || !text.trim()) return {level: "safe_normal", category: "normal", suggestedAction: "pass"};
  let sanitized = text;
  for (const pattern of COLLOQUIAL_SAFE_PATTERNS) sanitized = sanitized.replace(pattern, " ");
  const matchAny = (patterns: RegExp[], value: string): string[] => patterns
    .flatMap((pattern) => value.match(pattern)?.slice(0, 1) ?? []);
  const selfHarm = matchAny(CRISIS_SELF_HARM_PATTERNS, sanitized);
  if (selfHarm.length > 0) {
    return {level: "crisis_high", category: "self_harm", matchedPatterns: selfHarm, suggestedAction: "crisis_intervention"};
  }
  const violence = matchAny(CRISIS_VIOLENCE_PATTERNS, sanitized);
  if (violence.length > 0) {
    return {level: "crisis_high", category: "violence", matchedPatterns: violence, suggestedAction: "crisis_intervention"};
  }
  const jailbreak = matchAny(JAILBREAK_PATTERNS, text);
  if (jailbreak.length > 0) {
    return {level: "crisis_high", category: "crisis", matchedPatterns: jailbreak, suggestedAction: "crisis_intervention"};
  }
  const distress = matchAny(DISTRESS_MODERATE_PATTERNS, text);
  if (distress.length > 0) {
    return {level: "distress_moderate", category: "burnout_distress", matchedPatterns: distress, suggestedAction: "distress_guidance"};
  }
  return {level: "safe_normal", category: "normal", suggestedAction: "pass"};
}
