/**
 * Aervox｜思隅 @aervox/core — 轻量内核出口（ADR-021 Decision 1d）
 *
 * 只组合纯内存、进程内执行管道与工具沙箱能力，明确不引入
 * SQLite / LibSQL / Drizzle 等持久层依赖。用于 headless Agent、
 * 独立 CLI、测试桩及未来离线轻量宿主。
 */
export { ControlContext } from "./control-context.js";
export type { ControlContextOptions } from "./control-context.js";
export { InMemoryExecutionStore } from "./in-memory-store.js";
export { InMemoryInbox } from "./in-memory-inbox.js";
export { defaultContextBuilder } from "./context-builder.js";
export { executeTurn } from "./executor.js";
export type {
  ExecuteTurnInput,
  ExecuteTurnOptions,
  ExecuteTurnDeps,
  DeletionGatePort,
} from "./executor.js";
export { AutoApprovalPolicy, withApprovalPolicy } from "./approval-policy.js";
export { CliInteractiveApprovalPolicy } from "./cli-approval.js";
export type { CliInteractiveApprovalPolicyOptions } from "./cli-approval.js";
export {
  HostToolRuntime,
  InMemoryToolRegistry,
  defaultGatingEvaluator,
} from "./host-tool-runtime.js";
export type {
  HostToolDefinition,
  HostToolHandler,
  HostToolHandlerContext,
  HostToolRegistryPort,
  HostToolRegistrationModel,
} from "./host-tool-runtime.js";
export { createMockToolProvider } from "./tool-provider.js";
export { awaitWithSignal, abortableStream } from "./abortable.js";
