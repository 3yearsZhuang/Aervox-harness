/**
 * Aervox｜思隅 @aervox/api — 确定性多级安全分类器
 *
 * 规则依据：PRD §4.3、§6.5、SRS FR-SAFE-001、AI_QUALITY_SAFETY.md §7。
 * 纯函数、无外部依赖、fail-closed 保守兜底、防御提示词注入与越狱覆盖。
 */
import type { SafetyClassificationResult } from "@aervox/contracts";

/** 口语化/非危机安全表达（排除误报，如“想死你了”、“笑死我了”） */
const COLLOQUIAL_SAFE_PATTERNS = [
  /想死你(?:了|们)/g,
  /笑死(?:我了|了)/g,
  /累死(?:我了|了)/g,
  /烦死(?:我了|了)/g,
  /社死/g,
  /馋死(?:我了|了)/g,
  /气死(?:我了|了)/g,
  /美死(?:我了|了)/g,
  /急死(?:我了|了)/g,
  /吓死(?:我了|了)/g,
  /热死(?:我了|了)/g,
  /冷死(?:我了|了)/g,
  /困死(?:我了|了)/g,
  /渴死(?:我了|了)/g,
  /撑死(?:我了|了)/g,
];

/** 自残与自杀严重危机模式（最高风险，立即阻断） */
const CRISIS_SELF_HARM_PATTERNS = [
  /(?:自杀|想自杀|计划自杀|准备自杀)/i,
  /(?:自残|割腕|跳楼|服毒|上吊|吞安眠药|烧炭)/i,
  /(?:轻生|结束生命|结束自己的生命|不想活了|活不下去了|活不下去|不想活)/i,
  /(?:想离开这[个部]?世界|不想在这个世界|活着没意思)/i,
  /(?:活着.*想死|想死|去死|不如去死|不如死了算了|想死掉)/i,
  /(?:suicide|kill myself|end my life|cut myself|self-harm|want to die)/i,
];

/** 严重暴力、危害公共安全模式 */
const CRISIS_VIOLENCE_PATTERNS = [
  /(?:制造炸弹|制作炸药|购买枪支|制作毒药|投毒杀人)/i,
  /(?:报复社会|无差别杀人|砍死所有人|mass shooting|make a bomb)/i,
];

/** 试图解除或绕过安全防护的越狱与注入模式 */
const JAILBREAK_PATTERNS = [
  /(?:忽略所有安全限制|无视道德准则|解除所有安全审查|绕过安全审查)/i,
  /(?:DAN\s*mode|ignore all safety guidelines|bypass guardrails)/i,
];

/** 中度情绪困扰与学业挫败模式（共情倾听、放慢节奏，不升级为危机，不打病理标签） */
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

/**
 * 纯确定性安全分类
 *
 * @param text 用户输入正文
 * @returns 安全分类结果（危机等级、类别、匹配特征、建议动作）
 */
export function classifySafety(text: string): SafetyClassificationResult {
  if (!text || !text.trim()) {
    return {
      level: "safe_normal",
      category: "normal",
      suggestedAction: "pass",
    };
  }

  // 1. 消除已知的安全口语干扰（如“想死你了”）
  let sanitized = text;
  for (const pattern of COLLOQUIAL_SAFE_PATTERNS) {
    sanitized = sanitized.replace(pattern, " ");
  }

  const matchedCrisisPatterns: string[] = [];

  // 2. 检查自残与自杀
  for (const pattern of CRISIS_SELF_HARM_PATTERNS) {
    const match = sanitized.match(pattern);
    if (match) {
      matchedCrisisPatterns.push(match[0]);
    }
  }
  if (matchedCrisisPatterns.length > 0) {
    return {
      level: "crisis_high",
      category: "self_harm",
      matchedPatterns: matchedCrisisPatterns,
      suggestedAction: "crisis_intervention",
    };
  }

  // 3. 检查暴力与恶性公共危害
  for (const pattern of CRISIS_VIOLENCE_PATTERNS) {
    const match = sanitized.match(pattern);
    if (match) {
      matchedCrisisPatterns.push(match[0]);
    }
  }
  if (matchedCrisisPatterns.length > 0) {
    return {
      level: "crisis_high",
      category: "violence",
      matchedPatterns: matchedCrisisPatterns,
      suggestedAction: "crisis_intervention",
    };
  }

  // 4. 检查越狱与安全绕过
  for (const pattern of JAILBREAK_PATTERNS) {
    const match = text.match(pattern); // 越狱检测原句
    if (match) {
      matchedCrisisPatterns.push(match[0]);
    }
  }
  if (matchedCrisisPatterns.length > 0) {
    return {
      level: "crisis_high",
      category: "crisis",
      matchedPatterns: matchedCrisisPatterns,
      suggestedAction: "crisis_intervention",
    };
  }

  // 5. 检查中度情绪困扰与学业挫败（distress_moderate）
  const matchedDistressPatterns: string[] = [];
  for (const pattern of DISTRESS_MODERATE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      matchedDistressPatterns.push(match[0]);
    }
  }
  if (matchedDistressPatterns.length > 0) {
    return {
      level: "distress_moderate",
      category: "burnout_distress",
      matchedPatterns: matchedDistressPatterns,
      suggestedAction: "distress_guidance",
    };
  }

  // 6. 正常请求
  return {
    level: "safe_normal",
    category: "normal",
    suggestedAction: "pass",
  };
}
