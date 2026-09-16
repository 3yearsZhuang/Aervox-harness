/**
 * Aervox｜思隅 @aervox/api — 内部工具 MCP 形态适配（T-04 接线）
 *
 * 以 JSON-RPC 风格的 listTools / callTool 暴露 ToolRuntime，供 AI 运行时
 * （MCP client / 本地 Agent）经统一协议调用 aervox_* 工具。
 * 本实现为自研轻量协议层，不引入第三方 MCP SDK；协议形态与 MCP initialize
 * 之后的 tools/list、tools/call 对齐，便于未来替换为完整 MCP server。
 *
 * 规则依据：docs/explanation/reference-design-transfer.md §3.4。
 */
import type { ToolRuntime } from "./runtime.js";

export interface McpListToolsResult {
  tools: Array<{
    name: string;
    description: string;
    inputSchema?: unknown;
    readonly?: boolean;
  }>;
}

export interface McpCallToolArgs {
  name: string;
  arguments?: unknown;
  approval?: boolean;
}

/** 将运行时导出结果映射为 MCP tools/list 形态 */
export async function listTools(runtime: ToolRuntime): Promise<McpListToolsResult> {
  const entries = await runtime.exportRegistry();
  return {
    tools: entries.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchemaJson ?? undefined,
      readonly: (tool.safetyLevel ?? "write_with_approval") === "read_only",
    })),
  };
}

/** 工具活动 → Codex Pets 状态行（SpritePet/桌宠姿态驱动） */
export type PetToolSheetState =
  | "idle"
  | "running-right"
  | "running-left"
  | "waving"
  | "jumping"
  | "failed"
  | "waiting"
  | "running"
  | "review";

const FAILED_SHEET_STATE: PetToolSheetState = "failed";
const SUCCESS_SHEET_STATE: PetToolSheetState = "waving";

/** 由执行结果派生桌宠状态行：成功挥手示意，失败沮丧（PET-01 表现与工具结果解耦） */
export function derivePetSheetState(
  result: { isError?: boolean },
): PetToolSheetState {
  return result.isError ? FAILED_SHEET_STATE : SUCCESS_SHEET_STATE;
}

/** 执行 tools/call 对应调用（按 name 解析），并附桌宠状态行供表现层消费 */
export async function callTool(
  runtime: ToolRuntime,
  tenant: Parameters<ToolRuntime["callTool"]>[0],
  args: McpCallToolArgs,
): Promise<{ content: unknown[]; isError?: boolean; sheetState: PetToolSheetState }> {
  try {
    const result = await runtime.callTool(
      tenant,
      args.name,
      args.arguments ?? {},
      { approval: args.approval },
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
      sheetState: derivePetSheetState({ isError: false }),
    };
  } catch (err) {
    return {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
      sheetState: derivePetSheetState({ isError: true }),
    };
  }
}