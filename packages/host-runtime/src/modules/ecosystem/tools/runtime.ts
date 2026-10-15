/** API adapter: one core runtime owns lifecycle, gating and cancellation. */
import {
  HostToolRuntime, HostToolError,
  type HostToolHandler, type HostToolDefinition,
} from "@aervox/core";
import type { IToolRegistryRepository, ToolRegistrationModel, LocalContext } from "@aervox/repositories";
import { ForbiddenError, NotFoundError } from "../../../shared/errors.js";

export { defaultGatingEvaluator } from "@aervox/core";
export type ToolHandler = HostToolHandler;
export type ToolDisposer = () => void;
export type ToolRegistryPort = Pick<IToolRegistryRepository,
  "getTool" | "listTools" | "registerTool" | "setEnabled" | "unregisterTool" | "exportRegistry">;
export type ToolDefinition = Parameters<ToolRegistryPort["registerTool"]>[0];
export interface ToolRuntimeDeps { registry: ToolRegistryPort }

export class ToolRuntime extends HostToolRuntime {
  constructor(deps: ToolRuntimeDeps) {
    const registry = deps.registry;
    super({ registry: {
      getTool: id => registry.getTool(id),
      listTools: () => registry.listTools(),
      registerTool: tool => registry.registerTool({ ...tool, safetyLevel: tool.safetyLevel ?? undefined, replay: tool.replay ?? undefined }),
      setEnabled: (id, enabled) => registry.setEnabled(id, enabled),
      unregisterTool: id => registry.unregisterTool(id),
      exportRegistry: options => registry.exportRegistry(options),
    } });
  }

  // The adapter's registry always returns the full SQLite record. Core preserves it.
  override async listTools(): Promise<ToolRegistrationModel[]> {
    return await super.listTools() as ToolRegistrationModel[];
  }
  override async registerTool(tool: HostToolDefinition): Promise<ToolRegistrationModel> {
    return await super.registerTool(tool) as ToolRegistrationModel;
  }
  override async setEnabled(id: string, enabled: boolean): Promise<ToolRegistrationModel | null> {
    return await super.setEnabled(id, enabled) as ToolRegistrationModel | null;
  }
  override async exportRegistry(options?: Parameters<HostToolRuntime["exportRegistry"]>[0]): Promise<ToolRegistrationModel[]> {
    return await super.exportRegistry(options) as ToolRegistrationModel[];
  }
  override async callTool(ctx: LocalContext, id: string, args: unknown, options?: Parameters<HostToolRuntime["callTool"]>[3]): Promise<unknown> {
    try { return await super.callTool(ctx, id, args, options); }
    catch (error) {
      if (error instanceof HostToolError && error.statusCode === 403) throw new ForbiddenError(error.message);
      if (error instanceof HostToolError && error.statusCode === 404) throw new NotFoundError(error.message);
      throw error;
    }
  }
}
