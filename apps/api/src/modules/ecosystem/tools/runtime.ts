/**
 * Aervox｜思隅 @aervox/api — 工具运行时适配器（T-04 接线）
 *
 * 依据 aervox_core_decoupling_plan.md Phase 3：
 * 工具沙箱容器、代际保护、信号组合与参数沙箱已全面下沉至 @aervox/host-agent 的 HostToolRuntime。
 * 本模块仅作为 Fastify / Drizzle SQLite 仓储与 ApiError 序列化的适配层。
 */

import {
  HostToolRuntime,
  defaultGatingEvaluator,
  type HostToolDefinition,
  type HostToolDisposer,
  type HostToolHandler,
} from "@aervox/host-agent";
import type {
  IToolRegistryRepository,
  ToolRegistrationModel,
  LocalContext,
} from "@aervox/repositories";
import { ForbiddenError, NotFoundError } from "../../../shared/errors.js";

export type ToolHandler = HostToolHandler;
export type ToolRegistryPort = Pick<
  IToolRegistryRepository,
  "getTool" | "listTools" | "registerTool" | "setEnabled" | "unregisterTool" | "exportRegistry"
>;
export interface ToolRuntimeDeps {
  registry: ToolRegistryPort;
}
export type ToolDefinition = HostToolDefinition;
export type ToolDisposer = HostToolDisposer;
export { defaultGatingEvaluator };

export class ToolRuntime extends HostToolRuntime {
  constructor(deps: ToolRuntimeDeps) {
    super({ registry: deps.registry });
  }

  // 保证与 Fastify / API 既有 ForbiddenError / NotFoundError 契约保持 100% 兼容
  override async callTool(
    ctx: LocalContext,
    toolId: string,
    args: unknown,
    opts: {
      approval?: boolean;
      proactiveAuthorization?: boolean;
      signal?: AbortSignal;
      controlContext?: import("@aervox/agent-loop").ControlContext;
    } = {},
  ): Promise<unknown> {
    try {
      return await super.callTool(ctx, toolId, args, opts);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; message?: string };
      if (error?.statusCode === 404) {
        throw new NotFoundError(error.message ?? "tool not found");
      }
      if (error?.statusCode === 403) {
        throw new ForbiddenError(error.message ?? "forbidden");
      }
      throw err;
    }
  }

  override registerHandler(id: string, handler: ToolHandler): ToolDisposer {
    try {
      return super.registerHandler(id, handler);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; message?: string };
      if (error?.statusCode === 403) throw new ForbiddenError(error.message ?? "forbidden");
      throw err;
    }
  }

  override async registerContribution(
    tool: ToolDefinition,
    handler: ToolHandler,
  ): Promise<ToolDisposer> {
    try {
      return await super.registerContribution(tool, handler);
    } catch (err: unknown) {
      const error = err as { statusCode?: number; message?: string };
      if (error?.statusCode === 403) throw new ForbiddenError(error.message ?? "forbidden");
      throw err;
    }
  }

  override async registerTool(tool: ToolDefinition): Promise<ToolRegistrationModel> {
    try {
      return (await super.registerTool(tool)) as ToolRegistrationModel;
    } catch (err: unknown) {
      const error = err as { statusCode?: number; message?: string };
      if (error?.statusCode === 403) throw new ForbiddenError(error.message ?? "forbidden");
      throw err;
    }
  }

  override async exportRegistry(options?: {
    disabledToolIds?: string[];
    category?: string;
  }): Promise<ToolRegistrationModel[]> {
    return (await super.exportRegistry(options)) as ToolRegistrationModel[];
  }

  override async listTools(): Promise<ToolRegistrationModel[]> {
    return (await super.listTools()) as ToolRegistrationModel[];
  }
}
