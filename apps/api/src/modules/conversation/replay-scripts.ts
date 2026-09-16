/**
 * Aervox｜思隅 @aervox/api — scripted* 确定性回放脚本常量
 *
 * 机械拆分自 agent-executor.ts（B 档第三步，零行为变更）：
 * AERVOX_LOOP_PROVIDER=scripted* 系列的固定回放步骤逐字节迁移。
 */
import type { ReplayStep } from "@aervox/agent-loop";

/** 阶段 2d 工具路径脚本（AERVOX_LOOP_PROVIDER=scripted 时使用；跨 Step 验证只读工具链） */
export const API_TOOL_SCRIPT: readonly ReplayStep[] = [
  {
    text: "我先查一下学习笔记。",
    toolCalls: [{ id: "call_api_1", name: "aervox_notes_search", arguments: { query: "复习计划" } }],
  },
  { text: "查到了：今天复习三角函数。", toolCalls: [] },
];

/** 阶段 3a 写工具脚本（AERVOX_LOOP_PROVIDER=scripted-write；单 Step 请求写工具 → 审批待决） */
export const API_WRITE_SCRIPT: readonly ReplayStep[] = [
  {
    text: "我需要保存一条复习笔记。",
    toolCalls: [{ id: "call_write_1", name: "aervox_save_note", arguments: { content: "今日复习三角函数" } }],
  },
];

/** 3b privileged 管理员通道脚本（AERVOX_LOOP_PROVIDER=scripted-privileged；单 Step 请求特权工具） */
export const API_PRIVILEGED_SCRIPT: readonly ReplayStep[] = [
  {
    text: "需要执行特权操作。",
    toolCalls: [{ id: "call_priv_1", name: "aervox_privileged_op", arguments: { op: "export_all" } }],
  },
];

/** CAP-016 刷题闭环脚本（AERVOX_LOOP_PROVIDER=scripted-quiz；record_practice_attempt 落库验证） */
export const API_QUIZ_SCRIPT: readonly ReplayStep[] = [
  {
    text: "我来记录本次作答。",
    toolCalls: [
      {
        id: "call_quiz_1",
        name: "record_practice_attempt",
        arguments: {
          prompt: "1 + 1 等于几？",
          questionType: "short_answer",
          userAnswer: "3",
          correctAnswer: "2",
          judgement: "incorrect",
          explanation: "基础加法：1 + 1 = 2。",
        },
      },
    ],
  },
  { text: "答错了，正确答案是 2。", toolCalls: [] },
];
