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
