/**
 * Aervox｜思隅 @aervox/api — 工具运行时（T-04 接线）
 *
 * 把 tool_registrations（注册表）与具体 handler 绑定，向 AI 运行时提供
 * listTools / exportRegistry / callTool 入口。PET-05 安全级别在调用侧强制：
 * - read_only：AI 可自主调用；
 * - write_with_approval：必须显式传 approval=true（模型请求 ≠ 授权）；
 * - privileged：仅管理员透传（本运行时一律拒绝，交由管理员通道）。
 *
 * 规则依据：docs/explanation/reference-design-transfer.md §3.4 / §4.11。
 */
import type { IToolRegistryRepository, ToolRegistrationModel, LocalContext } from "@aervox/repositories";
import { ForbiddenError, NotFoundError } from "../../../shared/errors.js";
import { inspectToolInput } from "@aervox/agent-loop";

/** 工具调用处理器：入参已过注册表校验，返回结果由调用方编码 */
export interface ToolHandler {
  call(
    ctx: LocalContext,
    args: unknown,
    context: { approval: boolean; proactiveAuthorization: boolean; signal: AbortSignal; controlContext?: import("@aervox/agent-loop").ControlContext },
  ): Promise<unknown>;
}

/** 运行时构造依赖 */
export type ToolRegistryPort = Pick<IToolRegistryRepository,
  "getTool" | "listTools" | "registerTool" | "setEnabled" | "unregisterTool" | "exportRegistry">;
export interface ToolRuntimeDeps { registry: ToolRegistryPort }
export type ToolDefinition = Parameters<ToolRegistryPort["registerTool"]>[0];
export type ToolDisposer = () => void;
interface Registration {
  owner: symbol;
  handler: ToolHandler;
  controller: AbortController;
  definition: Promise<ToolRegistrationModel | null>;
}

/** Metadata affecting dispatch must belong to the same registration as its handler. */
function definitionKey(tool: ToolRegistrationModel): string {
  return JSON.stringify([tool.name, tool.safetyLevel, tool.inputSchemaJson,
    tool.requiredPermissionsJson, tool.pluginId, tool.gatingConditionsJson, tool.replay]);
}

export class ToolRuntime {
  private readonly handlers = new Map<string, Registration>();
  private readonly writes = new Map<string, Promise<unknown>>();
  private disposed = false;
  constructor(private readonly deps: ToolRuntimeDeps) {}

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.writes.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.writes.set(id, next);
    void next.finally(() => { if (this.writes.get(id) === next) this.writes.delete(id); }).catch(() => undefined);
    return next;
  }

  private attach(id: string, handler: ToolHandler, definition: Promise<ToolRegistrationModel | null>, owner = Symbol(id)): ToolDisposer {
    if (this.disposed) throw new ForbiddenError("tool runtime disposed");
    this.handlers.get(id)?.controller.abort();
    const entry = { owner, handler, definition, controller: new AbortController() };
    this.handlers.set(id, entry);
    void definition.catch(() => { if (this.handlers.get(id) === entry) this.handlers.delete(id); entry.controller.abort(); });
    return () => {
      entry.controller.abort();
      const current = this.handlers.get(id);
      if (current?.owner === owner) { current.controller.abort(); this.handlers.delete(id); }
    };
  }

  /** Compatibility attachment; new contributions bind definition + handler in registerContribution. */
  registerHandler(id: string, handler: ToolHandler): ToolDisposer {
    const pending = this.writes.get(id) ?? Promise.resolve();
    return this.attach(id, handler, pending.then(() => this.deps.registry.getTool(id)));
  }

  async registerContribution(tool: ToolDefinition, handler: ToolHandler): Promise<ToolDisposer> {
    if (this.disposed) throw new ForbiddenError("tool runtime disposed");
    const definition = this.serial(tool.id, () => this.deps.registry.registerTool(tool));
    const release = this.attach(tool.id, handler, definition);
    try { await definition; return release; } catch (error) { release(); throw error; }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.handlers.values()) entry.controller.abort();
    this.handlers.clear();
  }

  /** 列出全部已注册工具（注册表数据） */
  async listTools(): Promise<ToolRegistrationModel[]> {
    return this.deps.registry.listTools();
  }

  /** 注册工具（幂等，enabled 保持） */
  async registerTool(tool: ToolDefinition) {
    if (this.disposed) throw new ForbiddenError("tool runtime disposed");
    const pending = this.serial(tool.id, () => this.deps.registry.registerTool(tool));
    return pending;
  }

  /** 启停工具 */
  async setEnabled(id: string, enabled: boolean) {
    const entry = this.handlers.get(id);
    const pending = this.serial(id, () => this.deps.registry.setEnabled(id, enabled));
    if (entry) this.attach(id, entry.handler, pending, entry.owner);
    return pending;
  }

  /** 注销工具（内置工具拒绝） */
  async unregisterTool(id: string) {
    const entry = this.handlers.get(id);
    entry?.controller.abort();
    this.handlers.delete(id);
    return this.serial(id, () => this.deps.registry.unregisterTool(id));
  }

  /** 导出运行时可调用快照（enabled + 门控过滤） */
  async exportRegistry(options?: {
    disabledToolIds?: string[];
    category?: string;
  }): Promise<ToolRegistrationModel[]> {
    const entries = new Map(this.handlers);
    const tools = await this.deps.registry.exportRegistry({
      disabledToolIds: options?.disabledToolIds,
      category: options?.category,
      gatingEvaluator: (condition) => defaultGatingEvaluator(condition),
    });
    const available = await Promise.all(tools.map(async (tool) => {
      const entry = entries.get(tool.id);
      const definition = await entry?.definition.catch(() => null);
      return entry && this.handlers.get(tool.id) === entry && !entry.controller.signal.aborted
        && definition && definitionKey(definition) === definitionKey(tool) ? tool : null;
    }));
    return available.filter((tool): tool is ToolRegistrationModel => tool !== null);
  }

  /** 调用工具：安全级别 + handler 存在性双重检查 */
  async callTool(
    ctx: LocalContext,
    toolId: string,
    args: unknown,
    opts: { approval?: boolean; proactiveAuthorization?: boolean; signal?: AbortSignal; controlContext?: import("@aervox/agent-loop").ControlContext } = {},
  ): Promise<unknown> {
    const entry = this.handlers.get(toolId);
    if (!entry || this.disposed) throw new ForbiddenError(`tool handler not registered: ${toolId}`);
    const definition = await entry.definition;
    const tool = await this.deps.registry.getTool(toolId);
    if (entry.controller.signal.aborted || this.handlers.get(toolId) !== entry) throw new ForbiddenError(`tool registration expired: ${toolId}`);
    if (!tool) throw new NotFoundError(`tool not found: ${toolId}`);
    if (!definition || definitionKey(definition) !== definitionKey(tool)) throw new ForbiddenError(`tool definition changed: ${toolId}`);
    if (tool.enabled !== 1) throw new ForbiddenError(`tool disabled: ${toolId}`);

    // PET-05：非只读工具必须显式授权
    if ((tool.safetyLevel ?? "write_with_approval") !== "read_only" && !opts.approval) {
      throw new ForbiddenError(`tool requires approval: ${toolId}（write_with_approval / privileged）`);
    }

    // B4-B：工具入参沙箱校验（防路径穿越、防空字节、防命令注入）
    const inspection = inspectToolInput({ name: tool.name, arguments: args });
    if (!inspection.safe) {
      throw new ForbiddenError(`unsafe tool arguments: ${inspection.reason ?? "validation_failed"}`);
    }

    const signals = [entry.controller.signal, opts.signal, opts.controlContext?.abortSignal].filter((signal): signal is AbortSignal => Boolean(signal));
    const signal = AbortSignal.any(signals);
    return new Promise((resolve, reject) => {
      const abort = () => reject(new ForbiddenError(`tool registration expired: ${toolId}`));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) { signal.removeEventListener("abort", abort); abort(); return; }
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return entry.handler.call(ctx, args, {
          approval: opts.approval === true,
          proactiveAuthorization: opts.proactiveAuthorization === true,
          signal,
          controlContext: opts.controlContext,
        });
      }).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
}

/** 默认 AST-04 门控求值（生产接线处；equals/in/truthy 基础实现） */
export function defaultGatingEvaluator(condition: {
  field: string;
  operator: string;
  value?: unknown;
  evaluatorId?: string;
}): boolean {
  switch (condition.operator) {
    case "truthy":
      return !!condition.value;
    case "equals":
      return condition.value !== undefined && condition.value !== null;
    case "in":
      return Array.isArray(condition.value) && condition.value.length > 0;
    case "custom":
      return false; // custom 需注入真实求值器
    default:
      return true;
  }
}
