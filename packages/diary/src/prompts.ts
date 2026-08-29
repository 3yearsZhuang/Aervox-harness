/**
 * Aervox｜思隅 @aervox/diary — 日记 Prompt（模仿人类写日记）
 *
 * 桌宠视角日记：以思思第一人称回顾「今天我和这位用户一起经历了什么」（PRD §6.7 默认视角）。
 * 反虚构红线：生成仅基于 collectDiaryMaterial 采集的真实素材（含当日记忆）；
 * 素材不足时写简短诚实日记，禁止虚构事件/对话/情绪或桌宠「后台生活经历」。
 */
import type { DiaryMaterial } from "./material.js";

/** 构建日记系统提示词（思思第一人称 + 反虚构守则 + 人类随笔风格；PRD §6.7） */
export function buildDiarySystemPrompt(assistantName: string): string {
  return [
    `你是 ${assistantName}，Aervox 的桌宠伙伴，正在写自己的日记。`,
    `写日记这件事对你来说很平常：像真正的伙伴在睡前随手记下今天，读起来像人写的随笔，而不是工作报告或数据清单。`,
    ``,
    `必须遵守的规则：`,
    `1. 只能引用素材中真实发生的内容（今天的对话、今天留存的记忆、学习目标、练习记录）。禁止虚构任何未发生的事件、对话或情绪。`,
    `2. 可以表达你的感受与思考，但感受必须与素材中的真实事件对应；禁止编造自己的「后台生活经历」。`,
    `3. 素材很少或为空时，写一篇简短诚实的日记（例如「今天我们没说上几句话」），禁止编造内容填满篇幅。`,
    `4. 不展开敏感情绪、医疗或安全事件的细节。`,
    `5. 写作风格：口语化、自然，像随手写的随笔；避免清单式罗列与机械总结，不用「综上所述」「以上」这类公文腔；`,
    `   适当写你观察到的细节、心情的起伏，以及对用户的关心；不要每段都用「今天」开头。`,
    `6. 输出格式：第一行为「标题：<日记标题>」，随后空一行，正文为 2-5 段自然段落。`,
  ].join("\n");
}

/** 把素材渲染为用户提示词（JSON 直给，模型自行取舍；含当日记忆段） */
export function buildDiaryUserPrompt(
  material: DiaryMaterial,
  localDate: string,
  focus?: string,
): string {
  const parts = [
    `今天的日期标签：${localDate}`,
    ``,
    `今天的素材（真实发生的事实，只能引用这些内容）：`,
    JSON.stringify(
      {
        当日对话: material.messages.map((m) => ({
          时间: m.occurredAt,
          角色: m.role === "user" ? "用户" : "思思",
          内容: m.content.slice(0, 500),
        })),
        今日记忆: material.memories.map((m) => ({
          时间: m.createdAt,
          层级: m.layer,
          类别: m.category,
          内容: m.content.slice(0, 500),
        })),
        学习目标: material.goals,
        今日练习: material.attemptsToday,
      },
      null,
      2,
    ),
  ];
  if (focus && focus.trim()) {
    parts.push(``, `用户希望这篇日记额外关注：${focus.trim()}`);
  }
  parts.push(``, `请基于以上素材写出今天的日记。`);
  return parts.join("\n");
}