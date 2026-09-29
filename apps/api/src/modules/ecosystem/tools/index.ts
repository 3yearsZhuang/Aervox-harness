import type { ModuleContext } from "../../context.js";
import { SqliteToolRegistryRepository } from "@aervox/repositories";
import { registerToolRoutes } from "./routes.js";
import { ToolRuntime } from "./runtime.js";

export type { ToolDefinition, ToolDisposer, ToolHandler, ToolRegistryPort } from "./runtime.js";
export type ToolExecutionPort = Pick<ToolRuntime, "callTool" | "exportRegistry">;
export type ToolContributionPort = Pick<ToolRuntime, "registerContribution">;
export type ToolRuntimePort = Pick<ToolRuntime, "callTool" | "exportRegistry" | "registerHandler" | "registerContribution" | "registerTool" | "unregisterTool" | "listTools" | "setEnabled">;
export { ToolRuntime };

export function registerToolsModule(ctx: ModuleContext): ToolRuntime {
  const runtime = new ToolRuntime({ registry: new SqliteToolRegistryRepository(ctx.db) });
  registerToolRoutes(ctx.app, runtime);
  ctx.app.addHook("onClose", async () => runtime.dispose());
  return runtime;
}
