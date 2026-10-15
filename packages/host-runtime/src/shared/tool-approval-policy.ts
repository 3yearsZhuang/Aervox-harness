/**
 * Aervox｜思隅 @aervox/api — Turn 级工具授权策略上下文
 *
 * 对话路由在中间件重构期保持不变；preValidation 从已解析的
 * CreateTurn body 固化本次 Turn 策略，并以 request-scoped LocalContext 对象为键传给执行层。
 */
import type { FastifyReply, FastifyRequest } from "fastify";
import type { LocalContext } from "@aervox/repositories";
import type { ToolApprovalMode } from "@aervox/contracts";
import { resolveLocalContext } from "./local-context.js";

const requestModes = new WeakMap<LocalContext, ToolApprovalMode>();

export function setRequestToolApprovalMode(
  tenant: LocalContext,
  mode: ToolApprovalMode,
): void {
  requestModes.set(tenant, mode);
}

export function getRequestToolApprovalMode(
  tenant: LocalContext,
): ToolApprovalMode {
  return requestModes.get(tenant) ?? "ask";
}

/** 仅对 CreateTurn 请求取值；非法值由路由内 Zod 契约统一返回 400。 */
export function createToolApprovalPolicyHook() {
  return async (req: FastifyRequest, _reply: FastifyReply): Promise<void> => {
    if (req.routeOptions.url !== "/v1/sessions/:sessionId/turns") return;
    const body = (req.body ?? {}) as { toolApprovalMode?: unknown };
    const mode: ToolApprovalMode = body.toolApprovalMode === "full_access" ? "full_access" : "ask";
    setRequestToolApprovalMode(resolveLocalContext(req), mode);
  };
}

export interface ToolAutoApprovalCandidate {
  name: string;
  category?: string;
  safetyLevel?: string;
}

/** 明确禁止完全访问自动免审的高危工具名称集合（安全红线） */
export const NON_AUTO_APPROVABLE_TOOL_NAMES = new Set<string>([
  "aervox_skill_promote",
  "aervox_skill_rollback",
  "aervox_skill_sync",
]);

/** 高危 Home Assistant 域与服务动作正则（门锁、安防报警、物理出入口控制等） */
const HA_HIGH_RISK_ENTITY_OR_SERVICE =
  /\b(lock\.|alarm_control_panel\.|unlock|disarm|open_cover|open_door|open_gate)\b/i;

/**
 * 判断指定工具及其参数是否允许在 full_access 模式下自动放行。
 * 若返回 false，即使当前 Turn 处于 full_access，也必须强制拦截为 pending 待用户显式确认。
 */
export function isToolAutoApprovable(
  tool: ToolAutoApprovalCandidate,
  args?: unknown,
): boolean {
  // 1. 特权工具（privileged）绝对不允许由普通完全访问自动放行（须走管理员通道或 CAP-033 全动作授权）
  if (tool.safetyLevel === "privileged") {
    return false;
  }

  // 2. 检查静态高危黑名单
  if (NON_AUTO_APPROVABLE_TOOL_NAMES.has(tool.name)) {
    return false;
  }

  // 3. 检查破坏性分类特征
  if (tool.category === "destructive" || tool.category === "privileged") {
    return false;
  }

  // 4. 针对 Home Assistant 外部物理安防控制工具的细粒度动作红线判定
  if (tool.name === "ha_call_service" && args && typeof args === "object") {
    const record = args as Record<string, unknown>;
    const entityId = typeof record.entityId === "string" ? record.entityId : "";
    const service = typeof record.service === "string" ? record.service : "";
    if (
      HA_HIGH_RISK_ENTITY_OR_SERVICE.test(entityId) ||
      HA_HIGH_RISK_ENTITY_OR_SERVICE.test(service)
    ) {
      return false;
    }
  }

  return true;
}

