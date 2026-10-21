/**
 * Aervox｜思隅 @aervox/core — 工具运行时容器 (HostToolRuntime) 内存版
 *
 * 依据 ADR-021 自 PR #235 分支移植：
 * 开箱即用的内存工具沙箱容器、代际保护（Generation Protection）、
 * AbortSignal 级联与工具入参校验。SQLite 注册表实现仍留 apps/api 生态模块，
 * 本文件零持久层依赖（持久化仓储适配走 HostToolRegistryPort 注入）。
 */

import type { ControlContext } from "./control-context.js";
import { inspectToolInput } from "./tool-input-safe.js";
import type { ToolBudget, ToolValidatorPort } from "./types.js";
import { validateJsonSchema } from "./json-schema-validator.js";

/**
 * 本地单用户上下文（ADR-021：core 零运行时依赖，故本地声明）。
 * 与 `@aervox/repositories` 的 `LocalContext` 结构兼容（TS 结构化类型），
 * 宿主持有 repositories 上下文时可直接传入。
 */
export interface LocalContext {
  readonly workspaceId: string;
  readonly subjectUserId: string;
  readonly actorId?: string;
}

export class HostToolError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 500, code = "TOOL_ERROR") {
    super(message);
    this.name = "HostToolError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export class HostToolForbiddenError extends HostToolError {
  constructor(message = "forbidden") {
    super(message, 403, "FORBIDDEN");
    this.name = "HostToolForbiddenError";
  }
}

export class HostToolNotFoundError extends HostToolError {
  constructor(message = "resource not found") {
    super(message, 404, "NOT_FOUND");
    this.name = "HostToolNotFoundError";
  }
}

export class HostToolValidationError extends HostToolError {
  readonly errors?: import("./types.js").ToolValidationErrorDetail[];
  constructor(toolName: string, errors?: import("./types.js").ToolValidationErrorDetail[]) {
    const detail = errors && errors.length > 0 ? `: ${errors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("; ")}` : "";
    super(`tool argument schema validation failed for ${toolName}${detail}`, 400, "SCHEMA_VALIDATION_FAILED");
    this.name = "HostToolValidationError";
    this.errors = errors;
  }
}

/** 拒绝会被 Node 定时器截断或溢出为 1ms 的期限。 */
export function validateToolBudget(budget: ToolBudget | undefined): void {
  if (budget === undefined) return;
  if (budget === null || typeof budget !== "object" || Array.isArray(budget)) {
    throw new HostToolError("invalid_tool_budget: expected an object", 400, "INVALID_TOOL_BUDGET");
  }
  const timeout = budget.timeoutMs;
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 2_147_483_647)) {
    throw new HostToolError(
      "invalid_tool_budget: timeoutMs must be an integer between 1 and 2147483647",
      400,
      "INVALID_TOOL_BUDGET",
    );
  }
}

function copyBudget(budget: ToolBudget | undefined): ToolBudget | undefined {
  validateToolBudget(budget);
  return budget === undefined ? undefined : { timeoutMs: budget.timeoutMs };
}

export interface HostToolRegistrationModel {
  id: string;
  name: string;
  description: string;
  category: string;
  safetyLevel?: string | null;
  enabled: number;
  builtin?: number;
  inputSchemaJson?: unknown;
  requiredPermissionsJson?: unknown;
  gatingConditionsJson?: unknown;
  replay?: string | null;
  pluginId?: string | null;
  updatedAt?: string | null;
  runtimeRevision?: string;
  /** 执行期预算；持久化注册表可省略，由 HostToolRuntime 补入当前进程登记值。 */
  budget?: ToolBudget;
}

export interface HostToolDefinition {
  id: string;
  name: string;
  category: string;
  description: string;
  safetyLevel?: string | null;
  enabled?: number;
  builtin?: boolean;
  inputSchema?: unknown;
  requiredPermissions?: unknown;
  gatingConditions?: unknown;
  replay?: string | null;
  pluginId?: string | null;
  priority?: number;
  budget?: ToolBudget;
}

export interface HostToolHandlerContext {
  approval: boolean;
  proactiveAuthorization: boolean;
  signal: AbortSignal;
  controlContext?: ControlContext;
}

export interface HostToolHandler {
  call(
    ctx: LocalContext,
    args: unknown,
    context: HostToolHandlerContext,
  ): Promise<unknown>;
}

export type HostToolDisposer = () => void;

export interface HostToolRegistryPort {
  getTool(id: string): Promise<HostToolRegistrationModel | null>;
  listTools(): Promise<HostToolRegistrationModel[]>;
  registerTool(tool: HostToolDefinition): Promise<HostToolRegistrationModel>;
  setEnabled(id: string, enabled: boolean): Promise<HostToolRegistrationModel | null>;
  unregisterTool(id: string): Promise<boolean | void>;
  exportRegistry(options?: {
    disabledToolIds?: string[];
    category?: string;
    gatingEvaluator?: (condition: { field: string; operator: string; value?: unknown; evaluatorId?: string }, context?: unknown) => boolean;
    gatingContext?: unknown;
  }): Promise<HostToolRegistrationModel[]>;
}

/** 按 dot-path 从门禁上下文解析字段值；上下文缺失或路径断裂返回 undefined */
function resolveGatingField(context: unknown, field: string): unknown {
  if (context === null || typeof context !== "object") return undefined;
  let current: unknown = context;
  for (const part of field.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.hasOwn(current, part)) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * 默认 AST-04 门控求值（equals/in/truthy 基础实现）：
 * 字段值从门禁上下文按 dot-path 实际解析并与条件值比较；未知算子与
 * custom（需要宿主注册自定义求值器）一律 fail-closed 返回 false。
 */
export function defaultGatingEvaluator(
  condition: { field: string; operator: string; value?: unknown; evaluatorId?: string },
  context?: unknown,
): boolean {
  if (!condition || typeof condition.field !== "string" || !condition.field) return false;
  const resolved = resolveGatingField(context, condition.field);
  if (resolved === undefined) return false;
  switch (condition.operator) {
    case "truthy":
      return Boolean(resolved);
    case "equals":
      if (typeof resolved === "object" && typeof condition.value === "object") {
        return JSON.stringify(resolved ?? null) === JSON.stringify(condition.value ?? null);
      }
      return resolved === condition.value;
    case "in":
      return Array.isArray(condition.value) && (condition.value as unknown[]).includes(resolved);
    case "custom":
      return false;
    default:
      return false;
  }
}

function gatingAllows(conditions: unknown, context?: unknown): boolean {
  if (conditions == null) return true;
  return Array.isArray(conditions) && conditions.every(c => defaultGatingEvaluator(c, context));
}

/** 纯内存工具注册表（供独立 CLI / Desktop 或测试使用） */
export class InMemoryToolRegistry implements HostToolRegistryPort {
  private readonly rows = new Map<string, HostToolRegistrationModel>();

  async registerTool(d: HostToolDefinition): Promise<HostToolRegistrationModel> {
    const budget = copyBudget(d.budget);
    const existing = this.rows.get(d.id);
    const row: HostToolRegistrationModel = {
      id: d.id,
      name: d.name,
      description: d.description,
      category: d.category,
      safetyLevel: d.safetyLevel ?? "write_with_approval",
      enabled: existing?.enabled ?? d.enabled ?? 1,
      builtin: d.builtin ? 1 : 0,
      inputSchemaJson: d.inputSchema ?? null,
      requiredPermissionsJson: d.requiredPermissions ?? null,
      gatingConditionsJson: d.gatingConditions ?? null,
      replay: d.replay ?? null,
      pluginId: d.pluginId ?? null,
      updatedAt: new Date().toISOString(),
      budget,
    };
    this.rows.set(d.id, row);
    return row;
  }

  async getTool(id: string): Promise<HostToolRegistrationModel | null> {
    return this.rows.get(id) ?? null;
  }

  async listTools(): Promise<HostToolRegistrationModel[]> {
    return Array.from(this.rows.values());
  }

  async setEnabled(id: string, enabled: boolean): Promise<HostToolRegistrationModel | null> {
    const r = this.rows.get(id);
    if (!r) return null;
    const next: HostToolRegistrationModel = {
      ...r,
      enabled: enabled ? 1 : 0,
      updatedAt: new Date().toISOString(),
    };
    this.rows.set(id, next);
    return next;
  }

  async unregisterTool(id: string): Promise<boolean> {
    return this.rows.delete(id);
  }

  async exportRegistry(options?: {
    disabledToolIds?: string[];
    category?: string;
    gatingEvaluator?: (condition: { field: string; operator: string; value?: unknown; evaluatorId?: string }, context?: unknown) => boolean;
    gatingContext?: unknown;
  }): Promise<HostToolRegistrationModel[]> {
    const disabled = new Set(options?.disabledToolIds ?? []);
    return Array.from(this.rows.values()).filter((r) => {
      if (r.enabled !== 1) return false;
      if (disabled.has(r.id)) return false;
      if (options?.category && r.category !== options.category) return false;
      // AST-04 门控条件求值（与 SqliteToolRegistryRepository.exportRegistry 同语义）
      if (options?.gatingEvaluator && r.gatingConditionsJson) {
        const conditions = Array.isArray(r.gatingConditionsJson) ? r.gatingConditionsJson : [];
        for (const cond of conditions as Array<{
          field: string;
          operator: string;
          value?: unknown;
          evaluatorId?: string;
        }>) {
          if (!options.gatingEvaluator(cond, options.gatingContext)) return false;
        }
      }
      return true;
    });
  }
}

export interface HostToolRuntimeDeps {
  registry?: HostToolRegistryPort;
  validator?: ToolValidatorPort;
}

interface Registration {
  owner: symbol;
  generation: number;
  handler: HostToolHandler;
  controller: AbortController;
  definition: Promise<HostToolRegistrationModel | null>;
}

/** 影响工具派发的核心元数据哈希指纹，用于代际过期判定 */
function definitionKey(tool: HostToolRegistrationModel): string {
  return JSON.stringify([
    tool.name,
    tool.safetyLevel,
    tool.inputSchemaJson,
    tool.requiredPermissionsJson,
    tool.pluginId,
    tool.gatingConditionsJson,
    tool.replay,
    tool.budget,
  ]);
}

/**
 * 宿主工具沙箱运行时（HostToolRuntime）
 */
export class HostToolRuntime {
  private readonly handlers = new Map<string, Registration>();
  private readonly writes = new Map<string, Promise<unknown>>();
  // SQLite 持久化权限/门控元数据仍为真源；预算随进程登记，不要求仓储新增列。
  private readonly budgets = new Map<string, ToolBudget | undefined>();
  private readonly registry: HostToolRegistryPort;
  private readonly validator: ToolValidatorPort;
  private disposed = false;
  private generation = 0;

  constructor(deps: HostToolRuntimeDeps = {}) {
    this.registry = deps.registry ?? new InMemoryToolRegistry();
    this.validator = deps.validator ?? validateJsonSchema;
  }

  get rawRegistry(): HostToolRegistryPort {
    return this.registry;
  }

  private projectDefinition(tool: HostToolRegistrationModel): HostToolRegistrationModel {
    const budget = this.budgets.has(tool.id) ? this.budgets.get(tool.id) : tool.budget;
    return { ...tool, budget: copyBudget(budget) };
  }

  private writeDefinition(tool: HostToolDefinition): Promise<HostToolRegistrationModel> {
    // 在排队前验证和复制，调用方后续修改对象不能改变已登记的执行预算。
    const budget = copyBudget(tool.budget);
    return this.serial(tool.id, async () => {
      const registered = await this.registry.registerTool({ ...tool, budget: copyBudget(budget) });
      this.budgets.set(tool.id, budget);
      return this.projectDefinition(registered);
    });
  }

  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.writes.get(id) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.writes.set(id, next);
    void next.finally(() => {
      if (this.writes.get(id) === next) this.writes.delete(id);
    }).catch(() => undefined);
    return next;
  }

  private attach(
    id: string,
    handler: HostToolHandler,
    definition: Promise<HostToolRegistrationModel | null>,
    owner = Symbol(id),
  ): HostToolDisposer {
    if (this.disposed) throw new HostToolForbiddenError("tool runtime disposed");
    this.handlers.get(id)?.controller.abort();
    const entry: Registration = { owner, generation: ++this.generation, handler, definition, controller: new AbortController() };
    this.handlers.set(id, entry);
    void definition.catch(() => {
      if (this.handlers.get(id) === entry) this.handlers.delete(id);
      entry.controller.abort();
    });
    return () => {
      entry.controller.abort();
      const current = this.handlers.get(id);
      if (current?.owner === owner) {
        current.controller.abort();
        this.handlers.delete(id);
      }
    };
  }

  /** 兼容绑定：将 handler 挂载到现有工具 ID */
  registerHandler(id: string, handler: HostToolHandler): HostToolDisposer {
    const pending = this.writes.get(id) ?? Promise.resolve();
    return this.attach(id, handler, pending.then(async () => {
      const tool = await this.registry.getTool(id);
      return tool ? this.projectDefinition(tool) : null;
    }));
  }

  /** 原子注册工具元数据与 Handler，返回生命周期销毁函数 */
  async registerContribution(tool: HostToolDefinition, handler: HostToolHandler): Promise<HostToolDisposer> {
    if (this.disposed) throw new HostToolForbiddenError("tool runtime disposed");
    const definition = this.writeDefinition(tool);
    const release = this.attach(tool.id, handler, definition);
    try {
      await definition;
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.handlers.values()) entry.controller.abort();
    this.handlers.clear();
    this.budgets.clear();
  }

  /** 列出全部已注册工具 */
  async listTools(): Promise<HostToolRegistrationModel[]> {
    return (await this.registry.listTools()).map(tool => this.projectDefinition(tool));
  }

  /** 注册工具（幂等） */
  async registerTool(tool: HostToolDefinition): Promise<HostToolRegistrationModel> {
    if (this.disposed) throw new HostToolForbiddenError("tool runtime disposed");
    return this.writeDefinition(tool);
  }

  /** 启停工具 */
  async setEnabled(id: string, enabled: boolean): Promise<HostToolRegistrationModel | null> {
    const entry = this.handlers.get(id);
    const pending = this.serial(id, async () => {
      const tool = await this.registry.setEnabled(id, enabled);
      return tool ? this.projectDefinition(tool) : null;
    });
    if (entry) this.attach(id, entry.handler, pending, entry.owner);
    return pending;
  }

  /** 注销工具 */
  async unregisterTool(id: string): Promise<boolean> {
    const entry = this.handlers.get(id);
    entry?.controller.abort();
    this.handlers.delete(id);
    const result = await this.serial(id, async () => {
      const res = await this.registry.unregisterTool(id);
      this.budgets.delete(id);
      return res !== false;
    });
    return result;
  }

  /** 导出运行时可调用快照（enabled + 门控过滤） */
  async exportRegistry(options?: {
    disabledToolIds?: string[];
    category?: string;
    gatingContext?: unknown;
  }): Promise<HostToolRegistrationModel[]> {
    const entries = new Map(this.handlers);
    const tools = await this.registry.exportRegistry({
      disabledToolIds: options?.disabledToolIds,
      category: options?.category,
      gatingContext: options?.gatingContext,
      gatingEvaluator: (condition) => defaultGatingEvaluator(condition, options?.gatingContext),
    });
    const available = await Promise.all(
      tools.map(async (row) => {
        const tool = this.projectDefinition(row);
        const entry = entries.get(tool.id);
        const definition = await entry?.definition.catch(() => null);
        return entry &&
          this.handlers.get(tool.id) === entry &&
          !entry.controller.signal.aborted &&
          definition &&
          definitionKey(definition) === definitionKey(tool)
          && tool.enabled === 1 && gatingAllows(tool.gatingConditionsJson, options?.gatingContext)
          ? { ...tool, runtimeRevision: `${entry.generation}:${definitionKey(tool)}` }
          : null;
      }),
    );
    return available.filter(tool => tool !== null);
  }

  /** 调用工具：门禁求值 + 安全级别 + handler 存在性 + 参数沙箱检查 + 信号级联 */
  async callTool(
    ctx: LocalContext,
    toolId: string,
    args: unknown,
    opts: {
      approval?: boolean;
      proactiveAuthorization?: boolean;
      signal?: AbortSignal;
      controlContext?: ControlContext;
      gatingContext?: unknown;
      expectedRevision?: string;
      authorize?: () => Promise<boolean>;
    } = {},
  ): Promise<unknown> {
    if (this.disposed) throw new HostToolForbiddenError("tool runtime disposed");
    const entry = this.handlers.get(toolId);
    if (!entry) throw new HostToolForbiddenError(`tool handler not registered: ${toolId}`);
    const definition = await entry.definition;
    const row = await this.registry.getTool(toolId);
    const tool = row ? this.projectDefinition(row) : null;
    if (entry.controller.signal.aborted || this.handlers.get(toolId) !== entry) {
      throw new HostToolForbiddenError(`tool registration expired: ${toolId}`);
    }
    if (!tool) throw new HostToolNotFoundError(`tool not found: ${toolId}`);
    if (!definition || definitionKey(definition) !== definitionKey(tool)) {
      throw new HostToolForbiddenError(`tool definition changed: ${toolId}`);
    }
    if (opts.expectedRevision !== undefined && opts.expectedRevision !== `${entry.generation}:${definitionKey(tool)}`) throw new HostToolForbiddenError(`tool declaration expired: ${toolId}`);
    if (tool.enabled !== 1) throw new HostToolForbiddenError(`tool disabled: ${toolId}`);

    // AST-04：调用时门禁求值——列表过滤之外的调用边界防线；
    // 条件不满足或上下文无法满足条件一律 fail-closed（覆盖直呼工具 ID 绕过列表过滤的路径）
    if (!gatingAllows(tool.gatingConditionsJson, opts.gatingContext)) {
      throw new HostToolForbiddenError(`tool gated: ${toolId}`);
    }

    // PET-05：非只读工具必须显式授权
    if ((tool.safetyLevel ?? "write_with_approval") !== "read_only" && !opts.approval) {
      throw new HostToolForbiddenError(`tool requires approval: ${toolId}（write_with_approval / privileged）`);
    }

    // B4-B：工具入参沙箱校验（防路径穿越、防空字节、防命令注入）
    const inspection = inspectToolInput({ name: tool.name, arguments: args });
    if (!inspection.safe) {
      throw new HostToolForbiddenError(`unsafe tool arguments: ${inspection.reason ?? "validation_failed"}`);
    }

    // Schema 校验：若工具定义了 inputSchemaJson，在派发 handler 前强校验
    if (tool.inputSchemaJson != null) {
      const validation = this.validator(tool.inputSchemaJson, args);
      if (!validation.valid) {
        throw new HostToolValidationError(tool.name, validation.errors);
      }
    }

    if (opts.authorize && !(await opts.authorize())) throw new HostToolForbiddenError(`tool permission denied: ${toolId}`);
    const timeoutController = new AbortController();
    const signals = [entry.controller.signal, opts.signal, opts.controlContext?.abortSignal, timeoutController.signal].filter(
      (signal): signal is AbortSignal => Boolean(signal),
    );
    const signal = AbortSignal.any(signals);

    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal.removeEventListener("abort", abort);
      };
      const abort = () => {
        cleanup();
        // 注册生命周期取消保持「注册过期」语义；调用方 / controlContext 取消保留原始原因。
        if (entry.controller.signal.aborted && entry.controller.signal.reason === signal.reason) {
          reject(new HostToolForbiddenError(`tool registration expired: ${toolId}`));
          return;
        }
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new HostToolForbiddenError(`tool registration expired: ${toolId}`),
        );
      };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      Promise.resolve()
        .then(() => {
          signal.throwIfAborted();
          if (tool.budget?.timeoutMs !== undefined) {
            timer = setTimeout(() => timeoutController.abort(new HostToolError(
              `tool execution timed out after ${tool.budget!.timeoutMs}ms: ${toolId}`,
              408,
              "TOOL_TIMEOUT",
            )), tool.budget.timeoutMs);
          }
          return entry.handler.call(ctx, args, {
            approval: opts.approval === true,
            proactiveAuthorization: opts.proactiveAuthorization === true,
            signal,
            controlContext: opts.controlContext,
          });
        })
        .then(resolve, reject)
        .finally(cleanup);
    });
  }
}
