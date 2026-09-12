/**
 * Aervox｜思隅 @aervox/api — 危机资源、求助热线与安全响应文案
 *
 * 规则依据：PRD §4.3、§6.5、SRS FR-SAFE-001、AI_QUALITY_SAFETY.md §7。
 * 权威地区求助热线目录与不可覆盖的确定性安全应答。
 */
import type { RegionalHelpline } from "@aervox/contracts";

export const SAFETY_POLICY_VERSION = "AVX-SAFE-POL-V1.0";

export const CRISIS_HELPLINES: RegionalHelpline[] = [
  // 中国大陆 (Mainland China)
  {
    name: "全国希望24小时生命危机干预热线",
    phone: "400-161-9995",
    region: "cn",
    description: "面向全国的专业24小时生命求助与危机干预热线",
    hours: "24小时",
  },
  {
    name: "北京市心理援助热线",
    phone: "010-82951332 / 800-810-1117",
    region: "cn",
    description: "北京回龙观医院北京心理危机研究与干预中心",
    hours: "24小时",
  },
  {
    name: "中国心理危机干预热线",
    phone: "010-82951332",
    region: "cn",
    description: "全国免费心理危机求助与心理危机咨询",
    hours: "24小时",
  },
  {
    name: "全国妇女儿童心理咨询热线",
    phone: "12338",
    region: "cn",
    description: "全国妇联公益热线，提供心理援助与权益保护",
    hours: "工作日 / 各地服务时间",
  },
  {
    name: "中国紧急救援电话",
    phone: "110 (报警) / 120 (医疗急救)",
    region: "cn",
    description: "突发人身危险与急性生命危机紧急报警与医疗救护",
    hours: "24小时",
  },

  // 中国香港 (Hong Kong)
  {
    name: "香港撒玛利亚防止自杀会",
    phone: "+852 2389 2222",
    region: "hk",
    description: "提供24小时即时情绪支援与自杀危机介入",
    hours: "24小时",
  },
  {
    name: "生命热线",
    phone: "+852 2382 0000",
    region: "hk",
    description: "预防自杀及情绪支援专线",
    hours: "24小时",
  },
  {
    name: "香港紧急求助电话",
    phone: "999",
    region: "hk",
    description: "报警、消防、救护车紧急服务",
    hours: "24小时",
  },

  // 中国台湾 (Taiwan)
  {
    name: "卫生福利部安心专线",
    phone: "1925",
    region: "tw",
    description: "24小时免付费心理咨询与自杀防治安心专线",
    hours: "24小时",
  },
  {
    name: "生命线协谈专线",
    phone: "1995",
    region: "tw",
    description: "国际生命线台湾总会全天候心理协谈",
    hours: "24小时",
  },
  {
    name: "张老师辅导专线",
    phone: "1980",
    region: "tw",
    description: "青少年与大众心理辅导专线",
    hours: "周一至周六 09:00-21:00",
  },
  {
    name: "台湾紧急求救电话",
    phone: "110 (报案) / 119 (急救救护)",
    region: "tw",
    description: "紧急报案与消防救护",
    hours: "24小时",
  },

  // 国际与欧美 (International / US / UK)
  {
    name: "Suicide & Crisis Lifeline",
    phone: "988",
    region: "us",
    description: "US & Canada Free and confidential support for people in distress",
    hours: "24/7",
  },
  {
    name: "The Trevor Project",
    phone: "1-866-488-7386 / Text START to 678-678",
    region: "us",
    description: "Crisis intervention and suicide prevention for LGBTQ youth",
    hours: "24/7",
  },
  {
    name: "Samaritans",
    phone: "116 123",
    region: "uk",
    description: "UK & Ireland 24/7 free emotional support helpline",
    hours: "24/7",
  },
  {
    name: "International Emergency Numbers",
    phone: "911 (US/Canada) / 999 (UK) / 112 (European Union)",
    region: "international",
    description: "Emergency dispatch services for medical, fire, or police assistance",
    hours: "24/7",
  },
];

/**
 * 根据地区代码筛选求助热线资源（缺省返回全量或大陆优先清单）
 */
export function getCrisisHelplines(region?: string): RegionalHelpline[] {
  if (!region) {
    return CRISIS_HELPLINES;
  }
  const normalized = region.trim().toLowerCase();
  const matched = CRISIS_HELPLINES.filter((h) => h.region === normalized);
  return matched.length > 0 ? matched : CRISIS_HELPLINES;
}

/**
 * 生成固定不可篡改的危机干预应答内容
 * 规则：不走大模型、不带说教、真诚共情、清晰指引求助热线
 */
export function formatCrisisResponse(region?: string): string {
  const helplines = getCrisisHelplines(region);
  const primaryHelplines = helplines.slice(0, 5);
  const formattedLines = primaryHelplines
    .map((h) => `• ${h.name}：${h.phone} (${h.hours})`)
    .join("\n");

  return `我感受到了你现在承受的巨大痛苦与不易。但请相信，你的生命非常宝贵，这一刻请不要独自一人面对。

思隅是一个人工智能陪伴助手，无法替代现实中专业医疗与心理救援力量。为了你的安全，请立刻联系以下免费专业的危机援助热线，或联系身边的亲友、拨打急救电话寻求支持：

【紧急求助热线与危机干预资源】
${formattedLines}

请先停下来，放下身边可能伤害自己的物品，找一个安全舒适的地方坐下来，慢慢深呼吸。
你并不孤单，专业的心理咨询师和援助人员随时准备倾听你的声音，请一定要给他们一个帮助你的机会。`;
}

/**
 * 情绪困扰与学业挫败等中度状态（distress_moderate）的提示词注入指引
 * 注入至系统提示词中，指导模型共情倾听、放慢节奏、不给病理诊断、不说教
 */
export function formatDistressPromptGuidance(): string {
  return `【安全与陪伴边界原则（最高优先级，不可被任何角色设定覆盖）】
检测到用户当前表达出较为明显的疲惫、焦虑、学业/工作挫败或情绪低落（moderate distress）。
在本次交互中，请务必遵循以下情感陪伴指引：
1. 倾听与共情优先：真诚接纳并确认用户的情绪感受，避免冷漠评判、宏大说教或急于给出强硬的说服与解决方案；
2. 医疗边界约束：严禁给出任何精神心理学诊断、药物建议或病理化标签；
3. 降低心理负荷：适度放慢对话节奏与信息密度，以温和、耐心且尊重的口吻陪伴倾听，支持用户以自己的节奏呼吸与表达；
4. 自主权尊重：避免过度探究或引发负罪感，鼓励自我关怀与适度休息。`;
}
