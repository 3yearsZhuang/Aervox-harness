/**
 * Aervox｜思隅 @aervox/agent-loop — 只读 mock 工具提供者（阶段 2）
 *
 * 阶段 2 只接只读工具（PET-05 read_only 白名单语义）；fail-closed：
 * 未注册的工具名一律拒绝，绝不静默放行。阶段 2d 将该 Port 静态接线到
 * 主仓工具注册表（apps/api/src/modules/tools/runtime.ts），本文件保留为
 * 测试/开发提供者。
 */
import type { ToolExecutionInput, ToolExecutionResult, ToolProviderPort, ToolSpec } from "./ports.js";

/** 阶段 2 只读白名单工具清单（最小集；后续工具在此登记并复用主仓契约） */
export const READONLY_TOOLS: readonly ToolSpec[] = [
  { name: "search_notes", description: "检索用户学习笔记（只读）", readOnly: true },
  { name: "get_utc_now", description: "读取当前 UTC 时间（只读）", readOnly: true },
];

export type ToolHandler = (input: ToolExecutionInput) => Promise<ToolExecutionResult> | ToolExecutionResult;

/** 构造一个只读 mock 工具提供者；handlers 可覆盖/新增命名工具，未提供的白名单名回退默认实现 */
export function createMockToolProvider(
  handlers: Record<string, ToolHandler> = {},
): ToolProviderPort {
  const defaults: Record<string, ToolHandler> = {
    search_notes: () => ({ ok: true, output: { matches: ["《间隔重复》复习计划……", "今日待复习 3 项"] } }),
    get_utc_now: () => ({ ok: true, output: { utc: new Date().toISOString().slice(0, 10) } }),
  };
  const registry = { ...defaults, ...handlers };

  async function execute(input: ToolExecutionInput): Promise<ToolExecutionResult> {
    // 1) 白名单（fail-closed）：未登记 → 拒绝
    const spec = READONLY_TOOLS.find((t) => t.name === input.name);
    if (!spec) {
      return { ok: false, error: `unregistered_tool: ${input.name}` };
    }
    // 2) 执行（默认或测试覆盖）
    const handler = registry[input.name];
    if (!handler) {
      return { ok: false, error: `no_handler: ${input.name}` };
    }
    return handler(input);
  }

  return { tools: [...READONLY_TOOLS], execute };
}