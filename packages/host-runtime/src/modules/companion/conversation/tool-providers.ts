/**
 * Aervox｜思隅 @aervox/api — Agent Loop 工具提供者（Contribution 授权门 + ToolRuntime 适配）
 *
 * 机械拆分自 agent-executor.ts（B 档第三步，零行为变更）：
 * 静态 Contribution 工具的通用写授权门（PET-05 / 阶段 3a / CR-022 full_access
 * 预授权）与动态 tool_registrations 运行时适配（CAP-033 主动动作授权）逐字节迁移。
 */
import { inspectToolInput, resolveToolSafetyLevel, validateJsonSchema } from "@aervox/core";
import type {
  ToolExecutionInput,
  ToolExecutionResult,
  ToolProviderPort,
  ToolSpec,
} from "@aervox/core";
import type {
  LocalContext,
} from "@aervox/repositories";
import type { Observability } from "@aervox/observability";
import {
  getRequestToolApprovalMode,
  isToolAutoApprovable,
} from "../../../shared/tool-approval-policy.js";
import {
  PROACTIVE_ACTION_DECIDER_PREFIX,
  type ProactiveActionPort,
} from "../../proactive/proactive/index.js";
import type { ToolRuntimePort as ToolRuntime } from "../../ecosystem/tools/index.js";
import { stableSerialize as stableStringify } from "@aervox/core";
import { FULL_PROFILE_SOURCE_MANIFEST } from "@aervox/repositories";

const profilePermissions = new Set<string>(FULL_PROFILE_SOURCE_MANIFEST.map(source => source.sourceKey));

/** Bot transports cannot expose CAP-033 sources or use its action authorization package. */
export function hasBotExcludedPermissions(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (!Array.isArray(value)) return true;
  return value.some(item => {
    const permission = typeof item === "string" ? item : item?.permission;
    return typeof permission !== "string" || profilePermissions.has(permission)
      || /^(device|profile|restricted|background)\./.test(permission);
  });
}

function bindAuthoritativeToolSource(input: ToolExecutionInput): ToolExecutionInput {
  if (input.name !== "aervox_memory_store" || !input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) return input;
  return { ...input, arguments: { ...input.arguments, sourceTurnId: input.turnId } };
}

function approvalArguments(input: ToolExecutionInput): unknown {
  if (input.name !== "aervox_memory_store" || !input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) return input.arguments;
  const { sourceTurnId: _hostProvenance, ...argumentsToApprove } = input.arguments as Record<string, unknown>;
  return argumentsToApprove;
}

function validateToolArguments(schema: unknown, args: unknown, code = "invalid_tool_input"): ToolExecutionResult | undefined {
  const result = validateJsonSchema(schema, args);
  if (result.valid) return undefined;
  const detail = result.errors?.map(error => `${error.path || "(root)"}: ${error.message}`).join("; ");
  return { ok: false, error: `${code}${detail ? `: ${detail}` : ""}` };
}

/** 自动授权决策人前缀；显式授权查询排除该类记录，避免关闭完全访问后泄漏。 */
export const FULL_ACCESS_DECIDER_PREFIX = "permission:full_access:";

export interface ToolApprovalRepository {
  recordToolApproval(context: LocalContext, input: {
    turnId: string; attemptId: string; toolName: string; argumentsHash: string;
    requester: string; state: "pending" | "granted" | "denied"; toolVersion?: string | null;
  }): Promise<{ id: string }>;
  decideToolApproval(context: LocalContext, approvalId: string, decision: "granted" | "denied", decidedBy: string): Promise<{ id: string } | null>;
  findGrantedToolApproval(context: LocalContext, input: {
    toolName: string; argumentsHash: string; excludeDecidedByPrefixes?: string[];
  }): Promise<{ id: string; toolVersion?: string | null } | null>;
}

async function findExplicitToolApproval(
  repo: ToolApprovalRepository,
  tenant: LocalContext,
  input: { toolName: string; argumentsHash: string },
) {
  return repo.findGrantedToolApproval(tenant, {
    ...input,
    excludeDecidedByPrefixes: [FULL_ACCESS_DECIDER_PREFIX, PROACTIVE_ACTION_DECIDER_PREFIX],
  });
}

async function recordAutomaticApproval(
  repo: ToolApprovalRepository,
  tenant: LocalContext,
  input: {
    turnId: string;
    attemptId: string;
    toolName: string;
    argumentsHash: string;
    toolVersion?: string | null;
  },
  decidedBy: string,
): Promise<boolean> {
  const approval = await repo.recordToolApproval(tenant, {
    ...input,
    requester: tenant.subjectUserId,
    state: "pending",
  });
  const actor = tenant.actorId ?? tenant.subjectUserId;
  const granted = await repo.decideToolApproval(
    tenant,
    approval.id,
    "granted",
    decidedBy || `${FULL_ACCESS_DECIDER_PREFIX}${actor}`,
  );
  return granted !== null;
}

async function executeAuthorizedProactiveAction(
  authorizer: ProactiveActionPort,
  tenant: LocalContext,
  actionId: string,
  execute: () => Promise<ToolExecutionResult>,
): Promise<ToolExecutionResult> {
  try {
    await authorizer.markRunning(tenant, actionId);
    const result = await execute();
    if (result.ok) await authorizer.markExecuted(tenant, actionId, result.output);
    else await authorizer.markFailed(tenant, actionId, result.error ?? "tool_execution_failed");
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await authorizer.markFailed(tenant, actionId, message).catch(() => undefined);
    return { ok: false, error: message };
  }
}

/** One declaration carries identity, policy metadata and a controlled dispatcher. */
export interface ToolBinding {
  id: string;
  revision?: string;
  owner: string;
  generation?: string;
  requireVersionedApproval?: boolean;
  spec: ToolSpec;
  category?: string;
  requiredPermissions?: unknown;
  toolVersion?: string | null;
  checkActive?(): Promise<boolean>;
  dispatch(input: ToolExecutionInput, authorization: { approval: boolean; proactiveAuthorization?: boolean }): Promise<ToolExecutionResult>;
}

/** A snapshot is replaced atomically; conflicting identities never partially publish. */
export class ToolBindingCatalog {
  private bindings = new Map<string, ToolBinding>();
  replace(bindings: ToolBinding[]): void {
    const next = new Map<string, ToolBinding>();
    for (const binding of bindings) {
      if (next.has(binding.spec.name)) throw new Error(`duplicate_tool_binding: ${binding.spec.name}`);
      next.set(binding.spec.name, { ...binding, spec: structuredClone(binding.spec) });
    }
    this.bindings = next;
  }
  get(name: string): ToolBinding | undefined { return this.bindings.get(name); }
  register(owner: string, generation: string, bindings: ToolBinding[]): () => void {
    const next = new Map([...this.bindings].filter(([, binding]) => binding.owner !== owner));
    const installed = new Map<string, ToolBinding>();
    for (const binding of bindings) {
      if (next.has(binding.spec.name) || installed.has(binding.spec.name)) throw new Error(`duplicate_tool_binding: ${binding.spec.name}`);
      const entry = { ...binding, owner, generation, spec: structuredClone(binding.spec) };
      next.set(entry.spec.name, entry); installed.set(entry.spec.name, entry);
    }
    this.bindings = next;
    return () => {
      for (const [name, identity] of installed) if (this.bindings.get(name) === identity) this.bindings.delete(name);
    };
  }
  clear(): void { this.bindings.clear(); }
}

interface BindingSource {
  tools: ToolSpec[];
  list(): Promise<ToolBinding[]>;
  resolve(name: string): Promise<ToolBinding | undefined>;
  invalidInputCode: string;
  restricted?: boolean;
}

/** Product approval policy has one implementation for all tool registration sources. */
function createCatalogToolProvider(
  source: BindingSource, tenant: LocalContext, repo: ToolApprovalRepository,
  proactiveActionAuthorizer?: ProactiveActionPort, observability?: Observability,
): ToolProviderPort {
  const catalog = new ToolBindingCatalog();
  let declared = false;
  let declarationRevision = 0;
  return {
    tools: source.tools,
    async listTools() {
      try {
        const bindings = await source.list();
        catalog.replace(bindings);
        declared = true;
        declarationRevision += 1;
        return bindings.map(binding => binding.spec);
      } catch (error) {
        // A failed refresh cannot confirm that the old declaration is still
        // available or retains its previous safety level. Revoke the complete
        // snapshot until a later declaration succeeds; never publish a batch
        // that only some sources managed to resolve.
        catalog.clear();
        declared = true;
        declarationRevision += 1;
        throw error;
      }
    },
    async execute(raw) {
      const input = bindAuthoritativeToolSource(raw);
      const emit = (result: ToolExecutionResult) => {
        observability?.metrics.emit({ type: "counter", name: result.ok ? "agent.tool.executed" : "agent.tool.blocked", value: 1 });
        return result;
      };
      input.signal?.throwIfAborted();
      const inspection = inspectToolInput({ name: input.name, arguments: input.arguments });
      if (!inspection.safe) return emit({ ok: false, error: `unsafe_tool_arguments: ${inspection.reason ?? "validation_failed"}` });
      const revision = declarationRevision;
      const snapshot = declared ? catalog.get(input.name) : undefined;
      if (declared && !snapshot) return emit({ ok: false, error: `unregistered_tool: ${input.name}` });
      const binding = await source.resolve(input.name);
      if (!binding) return emit({ ok: false, error: `unregistered_tool: ${input.name}` });
      if (snapshot && (snapshot.id !== binding.id || snapshot.revision !== binding.revision || snapshot.generation !== binding.generation)) return emit({ ok: false, error: "tool_not_declared" });
      const invalid = binding.spec.parameters === undefined ? undefined : validateToolArguments(binding.spec.parameters, input.arguments, source.invalidInputCode);
      if (invalid) return emit(invalid);
      const active = async () => {
        input.signal?.throwIfAborted();
        if (revision !== declarationRevision) return false;
        const allowed = !binding.checkActive || await binding.checkActive();
        return allowed && revision === declarationRevision;
      };
      if (!(await active())) return emit({ ok: false, error: "tool_permission_denied" });
      const dispatch = async (approval: boolean, proactiveAuthorization = false) => {
        if (!(await active())) return { ok: false, error: "tool_permission_denied" };
        return binding.dispatch(input, { approval, proactiveAuthorization });
      };
      const safetyLevel = resolveToolSafetyLevel(binding.spec);
      if (safetyLevel === "read_only") return emit(await dispatch(false));
      if (source.restricted) return emit({ ok: false, error: `tool_restricted_in_tier_l1: ${input.name}` });
      if (!["write_with_approval", "privileged", "destructive"].includes(safetyLevel)) return emit({ ok: false, error: `requires_approval: ${input.name}（未支持的安全级别）` });
      const argumentsHash = stableStringify(approvalArguments(input));
      const approvalInput = { turnId: input.turnId, attemptId: input.attemptId, toolName: input.name, argumentsHash, toolVersion: binding.toolVersion };
      const granted = await findExplicitToolApproval(repo, tenant, { toolName: input.name, argumentsHash });
      if (granted && (granted.toolVersion === binding.toolVersion || (!binding.requireVersionedApproval && !granted.toolVersion))) return emit(await dispatch(true));
      if (getRequestToolApprovalMode(tenant) === "full_access") {
        if (proactiveActionAuthorizer) {
          const authorization = await proactiveActionAuthorizer.authorize(tenant, {
            turnId: input.turnId, attemptId: input.attemptId, invocationId: input.invocationId,
            toolId: binding.id, toolName: input.name, category: binding.category ?? "system",
            safetyLevel, irreversible: safetyLevel === "destructive", requiredPermissions: binding.requiredPermissions,
            arguments: input.arguments,
          });
          if (authorization.authorized) {
            if (!(await recordAutomaticApproval(repo, tenant, approvalInput, authorization.decidedBy))) {
              await proactiveActionAuthorizer.markFailed(tenant, authorization.action.id, "proactive_action_approval_not_recorded");
              return emit({ ok: false, error: "proactive_action_approval_not_recorded" });
            }
            return emit(await executeAuthorizedProactiveAction(proactiveActionAuthorizer, tenant, authorization.action.id, () => dispatch(true, true)));
          }
        }
        if (safetyLevel === "write_with_approval" && isToolAutoApprovable({ name: input.name, category: binding.category, safetyLevel }, input.arguments)) {
          const actor = tenant.actorId ?? tenant.subjectUserId;
          if (!(await recordAutomaticApproval(repo, tenant, approvalInput, `${FULL_ACCESS_DECIDER_PREFIX}${actor}`))) return emit({ ok: false, error: "full_access_approval_not_recorded" });
          return emit(await dispatch(true));
        }
      }
      const approval = await repo.recordToolApproval(tenant, { ...approvalInput, requester: tenant.subjectUserId, state: "pending" });
      return emit({ ok: false, needsApproval: { approvalId: approval.id, toolName: input.name, argumentsHash } });
    },
  };
}

export interface ContributionToolSource {
  provider: ToolProviderPort;
  owner?: string;
  generation?: string;
  checkActive?: () => Promise<boolean>;
}

/** Static and plugin contributions normalize to the same binding policy as runtime rows. */
export function createContributionToolProvider(
  sources: ContributionToolSource[], tenant: LocalContext, repo: ToolApprovalRepository,
  proactiveActionAuthorizer?: ProactiveActionPort, observability?: Observability,
): ToolProviderPort {
  const bind = (source: ContributionToolSource, spec: ToolSpec): ToolBinding => ({
    id: spec.name, owner: source.owner ?? "host",
    generation: source.generation, requireVersionedApproval: source.generation !== undefined,
    revision: stableStringify(spec), spec,
    toolVersion: source.generation ? `${source.generation}:${stableStringify(spec)}` : stableStringify(spec),
    checkActive: source.checkActive,
    dispatch: input => source.provider.execute(input),
  });
  let current = new Map(sources.flatMap(source => source.provider.tools.map(spec => [spec.name, bind(source, spec)] as const)));
  return createCatalogToolProvider({
    tools: sources.flatMap(source => source.provider.tools), invalidInputCode: "invalid_tool_input",
    async list() {
      const bindings: ToolBinding[] = [];
      for (const source of sources) {
        if (source.checkActive && !(await source.checkActive())) continue;
        const tools = source.provider.listTools ? await source.provider.listTools() : source.provider.tools;
        bindings.push(...tools.map(spec => bind(source, spec)));
      }
      const next = new ToolBindingCatalog();
      next.replace(bindings);
      current = new Map(bindings.map(binding => [binding.spec.name, binding]));
      return bindings;
    },
    async resolve(name) { return current.get(name); },
  }, tenant, repo, proactiveActionAuthorizer, observability);
}

export function createApprovalGatedToolProvider(
  provider: ToolProviderPort, tenant: LocalContext, repo: ToolApprovalRepository,
  proactiveActionAuthorizer?: ProactiveActionPort, observability?: Observability,
): ToolProviderPort {
  return createContributionToolProvider([{ provider }], tenant, repo, proactiveActionAuthorizer, observability);
}

export function createRuntimeToolProvider(
  runtime: ToolRuntime, tenant: LocalContext,
  deps: {
    conversationRepo: ToolApprovalRepository;
    proactiveActionAuthorizer?: ProactiveActionPort;
    observability?: Observability;
    capabilityTier?: string;
    generationFor?: (tool: Awaited<ReturnType<ToolRuntime["listTools"]>>[number]) => string | undefined;
    signalFor?: (tool: Awaited<ReturnType<ToolRuntime["listTools"]>>[number]) => AbortSignal | undefined;
    isToolAllowed?: (tool: Awaited<ReturnType<ToolRuntime["listTools"]>>[number]) => Promise<boolean>;
  },
): ToolProviderPort {
  type RuntimeRow = Awaited<ReturnType<ToolRuntime["listTools"]>>[number];
  const bind = (tool: RuntimeRow): ToolBinding => ({
    id: tool.id, owner: tool.pluginId ?? "host", revision: tool.runtimeRevision,
    generation: deps.generationFor?.(tool), requireVersionedApproval: Boolean(deps.generationFor?.(tool)),
    toolVersion: deps.generationFor?.(tool) ? `${deps.generationFor(tool)}:${tool.updatedAt ?? ""}` : tool.updatedAt,
    category: tool.category, requiredPermissions: tool.requiredPermissionsJson,
    spec: {
      name: tool.name, description: tool.description, readOnly: tool.safetyLevel === "read_only",
      safetyLevel: tool.safetyLevel ?? "write_with_approval", budget: tool.budget,
      parameters: typeof tool.inputSchemaJson === "boolean" ? tool.inputSchemaJson
        : tool.inputSchemaJson && typeof tool.inputSchemaJson === "object" && !Array.isArray(tool.inputSchemaJson) ? tool.inputSchemaJson as Record<string, unknown> : undefined,
    },
    checkActive: () => deps.isToolAllowed ? deps.isToolAllowed(tool) : Promise.resolve(true),
    async dispatch(input, authorization) {
      try {
        return { ok: true, output: await runtime.callTool(tenant, tool.id, input.arguments, {
          ...authorization, signal: deps.signalFor?.(tool)
            ? AbortSignal.any([deps.signalFor(tool)!, ...(input.signal ? [input.signal] : [])]) : input.signal,
          controlContext: input.controlContext,
          expectedRevision: tool.runtimeRevision, authorize: () => deps.isToolAllowed ? deps.isToolAllowed(tool) : Promise.resolve(true),
        }) };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "tool_execution_error" }; }
    },
  });
  return createCatalogToolProvider({
    tools: [], invalidInputCode: "schema_validation_failed", restricted: deps.capabilityTier === "restricted",
    async list() {
      const bindings: ToolBinding[] = [];
      for (const row of await runtime.exportRegistry()) {
        if (deps.capabilityTier === "restricted" && row.safetyLevel !== "read_only") continue;
        if (deps.isToolAllowed && !(await deps.isToolAllowed(row))) continue;
        bindings.push(bind(row));
      }
      return bindings;
    },
    async resolve(name) {
      const row = (await runtime.exportRegistry()).find(tool => tool.name === name && tool.enabled === 1);
      if (row && deps.isToolAllowed) await deps.isToolAllowed(row);
      return row ? bind(row) : undefined;
    },
  }, tenant, deps.conversationRepo, deps.proactiveActionAuthorizer, deps.observability);
}
