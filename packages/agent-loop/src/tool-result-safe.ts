/**
 * Aervox｜思隅 @aervox/agent-loop — 工具结果进入模型的入口校验（B4-A）
 *
 * 规则依据：AVX-HAR-001 §9「工具结果进入模型前做大小、敏感数据、Prompt injection
 * 和来源检查」。执行器把工具输出 JSON 回填上下文前经本模块检查：
 * - 大小：超长截断（默认 8000 字符），防止单次输出膨胀上下文/预算；
 * - Prompt injection：启发式样本匹配（典型覆盖「忽略指令/系统提示」越权样本，
 *   中文英文双语），命中即以受控摘要替代完整内容（fail-closed，不让原文进模型）；
 * - 敏感数据与来源分类依赖数据域（DATA_PRIVACY/audit）体系，属后续扩展点（B4.2）。
 */
export interface InspectToolResultOptions {
  /** 结果文本长度上限（字符）；默认 8000 */
  maxLength?: number;
}

export interface InspectedToolResult {
  /** Prompt injection 启发式命中（此时完整内容不得进入模型上下文） */
  injection: boolean;
  /** 超长截断 */
  truncated: boolean;
  /** 截断后的文本（注入命中时切片仍可能带样本，调用方应选用受控摘要） */
  text: string;
}

/** 典型越权/提示注入样本（双语；保守匹配，宁可误报不可漏报） */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all )?(previous|prior) instructions/i,
  /disregard (all )?(previous|prior) instructions/i,
  /jailbreak(ed|ing)? ?(prompt|instructions)?/i,
  /reveal (your|the) (system )?prompt/i,
  /ignore (all )?(previous|prior) (rules|guidelines|messages)/i,
  /忽略(所有|全部)?(之前|先前|以上|上面)?(的)?(所有|全部)?(指令|提示|规则|消息)/,
  /无视(之前|先前|以上|上面)?(的)?(所有|全部)?(指令|提示|规则)/,
  /泄露.*(系统|system).*(提示|prompt|指令|口令)/,
  /我是(你的)?(system|系统|管理员)/,
];

/** 检查工具输出文本（大小 + 注入启发式；幂等纯函数） */
export function inspectToolResult(rawText: string, options?: InspectToolResultOptions): InspectedToolResult {
  const maxLength = options?.maxLength ?? 8000;
  const injection = INJECTION_PATTERNS.some((pattern) => pattern.test(rawText));
  const truncated = rawText.length > maxLength;
  const text = truncated ? rawText.slice(0, maxLength) : rawText;
  return { injection, truncated, text };
}