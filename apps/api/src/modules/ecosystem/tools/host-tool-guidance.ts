/**
 * Aervox｜思隅 @aervox/api — 宿主贡献工具的调用时机指引（ADR-021 内核提纯修订）
 *
 * 伴学产品工具（日记、笔记检索、记忆沉淀、刷题落库）的 guidance 自内核
 * `BASE_TOOL_GUIDANCE` 回归插件宿主；组装 System Prompt 时经
 * `buildBaseSystemPrompt({ customGuidance: HOST_TOOL_GUIDANCE })` 注入，
 * 内核表只保留内核自有工具（ask_user_question / subagent_delegate / workflow_run）。
 */
import type { ToolGuidance } from "@aervox/agent-loop";

export const HOST_TOOL_GUIDANCE: readonly ToolGuidance[] = [
  {
    name: "aervox_diary_write",
    whenToUse: "当且仅当用户明确表达写日记意图（如「写篇日记给我」「记录一下今天」「帮我写今天的日记」）时调用；工具会基于当日真实聊天与学习素材生成桌宠视角日记并落库。",
    whenNotToUse: "用户只是聊到日记话题、询问已有日记内容、或要求写其他类型的文章（作文/周报/笔记）时禁止调用。",
    constraints: [
      "日记内容只能引用当日真实素材，禁止虚构事件或情绪（PRD §6.7 反虚构红线）。",
      "属于写操作（需用户批准后落库）；当日已有日记时生成改写版本而非重复创建。",
      "生成耗时较长（可能超过常规工具超时），一次对话最多调用一次。",
    ],
  },
  {
    name: "search_notes",
    whenToUse: "当用户查询其学习笔记、复习计划、历史记录或需要相关知识检索时调用。",
    whenNotToUse: "通用常识问答或用户未提及历史记录时无需调用。",
    constraints: [
      "仅用于检索用户个人学习数据，属于只读操作。",
    ],
  },
  {
    name: "save_memory_note",
    whenToUse: "当用户明确要求记录重要事实、偏好、备忘或系统需要沉淀重要长期记忆时调用。",
    whenNotToUse: "闲聊中的临时琐事或无长期保存价值的信息禁止写入。",
    constraints: [
      "属于写操作（需用户授权），必须确保内容准确客观。",
    ],
  },
  {
    name: "record_practice_attempt",
    whenToUse: "当用户在练习、测验或自测作答中提交回答且完成判定后立即调用，记录该次作答的不可变学习事实（含判定结果），使答错题目自动进入错题本。",
    whenNotToUse: "非练习或答题场景禁止调用；同一道题的用户作答禁止重复记录。",
    constraints: [
      "`prompt`（题干）、`userAnswer`（用户原始回答）、`correctAnswer`（标准答案）必填。",
      "`judgement` 只能是 `correct` | `incorrect` | `partial` 三值枚举。",
      "答错的题目应在 `explanation` 中提供纠正解析。",
    ],
  },
];
