# 教程：迁移已集成能力并接入 DSH/pi

> 文档编号：AVX-TUT-002  
> 类型：Tutorials  
> 版本：v0.1  
> 更新日期：2026-08-26  
> 状态：Review Candidate  
> 责任角色：技术负责人（技术复核）  
> 关联：[能力组合与可选化目录规范](../reference/capability-composition.md)、[参考项目能力迁移与借鉴评估](../explanation/reference-design-transfer.md)、[ADR-009](../reference/adr/ADR-009-electron-plugin-sandbox.md)、[ADR-010](../reference/adr/ADR-010-dsh-pi-adapters.md)、[需求追踪基线](../reference/REQUIREMENTS_TRACEABILITY.md)

本教程带维护者把当前仓库中的 Aervox 工具、插件和技能能力迁移到可组合宿主，并设计一个受限的 DSH（DeepSeek Harness）与 pi 接入。教程终点是一个可解析、激活、停用和回滚的 Profile。当前仓库尚未实现 `adapters/dsh`、`adapters/pi` 或进程外 Host；相关步骤标为目标/实验，不得当作已完成集成。

本文中的 `DSH` 专指 `reference/deepseek-harness`，固定参考 commit 为 `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`。`dsh-synapse` 是 DSH 的独立 MIT Web 视图插件，只在最后作为投影案例出现，不是 DSH 本体。

## 你将完成什么

- 把一个现有 Aervox 能力拆成 `Definition`、`Provider` 和 `Consumer`；
- 为能力写统一 `Manifest`，让 Resolver 能检查依赖、权限和来源；
- 把 API 路由和 Worker cycle 接到 Port/Job Handler，而不是直接接数据库；
- 将一个只读 DSH Plugin 和一个只读 pi Extension 映射为受限 `Contribution`；
- 用一个 Profile 组合原生能力、DSH 能力和 pi 能力，并演练缺依赖、冲突、撤权和回滚。

Session、Learning、Memory、Consent、Deletion 和 Audit 的数据所有权在整个过程中保持不变。

## 前置条件

```bash
mise x -- node --version
mise x -- pnpm --version
git submodule update --init --recursive
mise x -- pnpm install --frozen-lockfile
```

开始前阅读[能力组合与可选化目录规范](../reference/capability-composition.md)、[ADR-009](../reference/adr/ADR-009-electron-plugin-sandbox.md) 和 [ADR-010](../reference/adr/ADR-010-dsh-pi-adapters.md)。第一轮不要接入 shell、文件写入、子进程、网络代理或其他高权限工具；先用只读 Tool/Event 证明适配器边界。

外部仓库仅用于固定版本的设计复核。不要把 `reference/deepseek-harness` 或 `reference/pi` 直接作为 Aervox workspace 依赖，也不要复制其源码进入 `packages/`。

## 当前实现到目标目录

| 当前实现 | 迁移后的职责 | 目标位置 |
|---|---|---|
| `apps/api/src/modules/tools/{runtime,memory-store-tool}.ts` | 工具 Definition、用例和 API Consumer | `capabilities/tools/` |
| `apps/api/src/modules/plugins/{service,index}.ts` | 插件安装态、权限和工具 Provider | `capabilities/plugins/` |
| `apps/api/src/modules/skills/` | 技能注册、生命周期和声明校验 | `capabilities/skills/` |
| `packages/contracts/src/schemas.ts` | Manifest、Contribution、事件 schema | `packages/capability-contracts/` |
| `packages/database/src/schema/tool-registry.ts` | SQLite Provider 内部 schema | `providers/tools/sqlite/` |
| `packages/database/src/repositories/sqlite/*` | Port 的 SQLite 实现 | `providers/*/sqlite/` |
| `apps/worker/src/*.ts` | 可独立测试的 Job Handler | `packages/host-worker/` + 能力 Provider |
| `apps/api/src/app.ts` | 组合根 | `packages/host-api/` + `profiles/` |
| 尚不存在 | DSH/Pi 外部运行时翻译层 | `adapters/dsh/`、`adapters/pi/` |

迁移期间保留旧 HTTP 路由、表和 `@aervox/database` 兼容出口；新入口通过契约测试后才删除旧入口。

## 第一步：迁移一个原生能力

选择现有 `aervox_memory_store` 工具作为第一条迁移链。它已有 ToolRegistry、审批门控和 Memory 写入路径，但仍必须把最终写入限制为候选。

创建 `capabilities/tools-memory-store/capability.yaml`：

```yaml
apiVersion: aervox.dev/v1
kind: CapabilityManifest
metadata:
  id: aervox.tools.memory-store
  version: 0.1.0
  displayName: Memory Store
  source: native
  sourceRef: workspace:capabilities/tools-memory-store
  license: MIT
spec:
  roles: [definition, consumer]
  provides: [tool.aervox.memory.store]
  requires: [aervox.memory.command, aervox.policy.approval]
  conflicts: []
  defaultActivation: disabled
  platforms: [api, worker]
  permissions:
    - id: memory.candidate.write
      mode: candidate_only
      scope: workspace
  data:
    owner: aervox.memory
    reads: [SessionExcerpt]
    writes: [MemoryCandidate]
    retention: inherited
    deletion: delegated
  events:
    subscribes: [turn.completed]
    publishes: [memory.candidate.created]
  entrypoints:
    host: process
    activate: ./dist/activate.js
```

`data.owner` 明确最终事实由 Memory 能力拥有；工具只能创建 `MemoryCandidate`，不能把 `ai_inferred` 内容直接晋升为长期记忆。

目标目录：

```text
capabilities/tools-memory-store/
  capability.yaml
  package.json
  src/
    definition.ts       # Port、输入输出、错误和 typed events
    application.ts      # 校验、审批、候选写入和幂等编排
    consumers/api.ts
    consumers/worker.ts
    activate.ts         # 注册并返回 disposer
  tests/contract.test.ts
  tests/lifecycle.test.ts
```

`application.ts` 只能依赖 Port。SQLite 具体类由组合根创建并注入；路由只把 HTTP 输入翻译成用例输入。

## 第二步：拆分 Definition、Provider 和 Consumer

对现有 `tools`、`plugins` 和 `skills` 填写以下角色表：

| 角色 | 要回答的问题 | 当前代码示例 |
|---|---|---|
| `Definition` | 输入、输出、事件和错误是什么？ | Tool schema、`TenantContext`、事件 envelope |
| `Provider` | 谁实现能力？ | `ToolRuntime`、`PluginService`、SQLite repository |
| `Consumer` | 谁触发或展示结果？ | `/v1/tools`、Worker、Web/Desktop |

示意 Port：

```ts
export interface MemoryCommandPort {
  proposeCandidate(input: {
    tenant: TenantContext;
    content: string;
    source: "user_said" | "ai_inferred";
    sourceTurnId?: string;
  }): Promise<{
    candidateId: string;
    verificationStatus: "unverified" | "verified";
  }>;
}

export interface CapabilityContext {
  readonly tenant: TenantContext;
  readonly memory: { commands: MemoryCommandPort };
  readonly policy: { require(permission: string): Promise<void> };
  effect(register: () => Promise<() => Promise<void>> | (() => void)): void;
}
```

这段接口是迁移示意，不是已冻结 Contract。它必须保证能力拿不到全局数据库、写入经过 Policy、注册可以被卸载。

保留兼容桥，确保单一写入路径：

```text
旧 /v1/tools -> compatibility consumer -> new application service -> Port
新 capability host -----------------------------------------------┘
```

不要让旧路由和新能力同时生成两份事实数据。

## 第三步：把 Worker 改成 Job Handler

当前 Worker 入口在 [apps/worker/src/index.ts](../../apps/worker/src/index.ts) 中集中创建具体仓储并执行 cycle。先定义统一 Handler：

```ts
export interface JobHandler {
  readonly id: string;
  readonly capabilityId: string;
  run(input: {
    workerId: string;
    signal: AbortSignal;
  }): Promise<{ processed: number; retryable: boolean }>;
}
```

按 Owner 迁移：

1. `review-notifier` 使用 Review/Notification Port，不直接查询 `reviewItems`；
2. `diary-generator` 使用 Diary Scheduler/Material Port，不直接更新 `diarySchedules`；
3. `deletion-worker` 使用按 `ownerModule` 注册的 `DeletionTargetHandler`；
4. `embedding-migration` 使用 Embedding Backfill Port，不执行裸 SQL；
5. `compaction-marker` 使用 Memory Job Port，保留 Outbox 幂等语义。

Worker Host 只负责 registry、顺序、租约、超时、重试和 DLQ。停用能力时阻止新任务，正在执行的任务要取消或完成后再释放资源。

```bash
mise x -- pnpm --filter @aervox/worker typecheck
mise x -- pnpm --filter @aervox/worker test
```

迁移完成前可以保留旧 Worker，但新 Handler 不得新增对 schema 或 Drizzle 的直接引用。

## 第四步：设计受限 DSH 适配器

### 4.1 只读 DSH 示例

DSH 的 Cordis 模式是插件声明 `inject`，通过 `apply(ctx)` 注册服务、工具或事件，并用 effect/disposer 管理生命周期。第一轮只选只读 Tool 或 Event Observer：

```ts
import type { Context } from "@deepseek-ai/cordis";

export const name = "aervox-readonly-observer";
export const inject = ["tools"];

export function apply(ctx: Context) {
  return ctx.tools.register({
    name: "aervox_readonly_context",
    description: "Read an approved context projection",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return { content: [{ type: "text", text: "read-only result" }] };
    },
  });
}
```

这是 DSH 形状示意，不是 Aervox 可直接编译的实现。DSH `Context`、Cordis Tool 类型和 DSH Session 不能穿过适配器边界暴露给业务能力。

### 4.2 `adapter-dsh` 的职责

`adapters/dsh/adapter-dsh` 负责：

1. 启动或连接固定版本的 DSH 外部 Host；
2. 读取 DSH Bundle/Profile 和 Cordis Plugin 声明；
3. 把 service、tool、event、provider 转成 Aervox `Contribution`；
4. 将受限 Context、权限决定、取消信号和审计结果传给外部 Host。

| DSH | Aervox |
|---|---|
| `inject` | `requires` |
| service key | `provides` 的 Definition ID |
| `apply(ctx)` | `activate(context)` |
| Cordis typed event | Aervox typed event；跨进程用 Outbox envelope |
| `ctx.effect()` disposer | Capability disposer |
| `cordis.patch.yml` | Profile Overlay 输入 |
| DSH Bundle/Profile | Bundle source metadata |

Aervox Manifest 仍是唯一事实源。不能把 `cordis.patch.yml` 直接当作 Aervox Profile，也不能让 DSH Session log 替代 Aervox Session/Message 真源。

建立 `registry/locks/adapter-dsh.yaml`：

```yaml
source: reference/deepseek-harness
commit: b150a551b8d465e31e418e1b2eaf5e79bbb7d28e
license: MIT
host: process
permissions: [tool.read]
checksum: sha256:<artifact-digest>
```

DSH 未安装、崩溃、超时或返回非法 schema 时，Aervox 必须保留原生 Profile，并把该 Adapter 标记为 `degraded`。DSH 只能读取授权工作区；提交记忆只能进入 `MemoryCandidate`。

## 第五步：设计受限 pi 适配器

### 5.1 只读 pi Extension

pi Extension 是默认导出的 factory，接收 `ExtensionAPI`，可以注册 Tool、事件、命令、Provider 和持久化条目。第一轮只用只读 Tool 或通知：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Aervox adapter is ready", "info");
  });

  pi.registerTool({
    name: "aervox_readonly_context",
    label: "Aervox read-only context",
    description: "Read an approved context projection",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return { content: [{ type: "text", text: "read-only result" }], details: {} };
    },
  });
}
```

实际 pi 版本可能要求 TypeBox schema；Adapter 负责重新校验并转成规范化 Contribution，不把 pi 类型暴露给 Aervox 业务包。

### 5.2 外部 Host 和权限代理

pi Extension 默认拥有完整系统权限，所以 `adapter-pi` 必须：

- 在进程外运行，并记录 npm/git/local 的精确版本或 commit；
- 未完成 Project Trust 时不自动激活；
- 通过 Permission Broker 校验每个 Tool；
- 设置超时、输出大小、并发和资源配额；
- 提供 kill switch；
- 为 `appendEntry()` 产生的数据登记保留、导出和删除策略。

pi `package.json.pi` 的 `extensions`、`skills`、`prompts` 和 `themes` 映射为 Resource Contribution；global/project settings 映射为 Source Scope；`pi config` 映射为 Activation Overlay，不能替代 Aervox Consent 或撤权。

建立 `registry/locks/adapter-pi.yaml`：

```yaml
source: reference/pi
commit: c49906ec77788625aacbdc53ebca6fbe65bd20f5
license: MIT
host: process
trust: project-approved
permissions: [tool.read, ui.notify]
checksum: sha256:<artifact-digest>
```

至少验证：未批准权限失败、超时、超大 payload、停用后 disposer 清理、Host kill 后核心会话继续，以及 Extension 无法打开 Aervox SQLite 文件。

## 第六步：组合 Profile

创建 `profiles/dsh-lab/profile.yaml`：

```yaml
apiVersion: aervox.dev/v1
kind: CapabilityProfile
metadata:
  id: dsh-lab
  version: 0.1.0
spec:
  capabilities:
    - aervox.identity
    - aervox.conversation
    - aervox.learning
    - aervox.memory
    - aervox.tools
  providers:
    aervox.identity: aervox.provider.identity.anonymous
    aervox.conversation.store: aervox.provider.conversation.sqlite
    aervox.memory.command: aervox.provider.memory.sqlite
    aervox.llm: aervox.provider.llm.internal
  adapters:
    - dsh.readonly-observer
    - pi.readonly-context
  activation:
    dsh.readonly-observer: enabled
    pi.readonly-context: disabled
  overlays: [dev]
```

Resolver 应输出稳定的 activation plan：

```text
substrate
  -> identity/consent/policy
  -> conversation/learning/memory
  -> tools
  -> dsh.readonly-observer
  -> pi.readonly-context (disabled)
```

故意加入以下错误并确认 Resolver 显式拒绝：缺 Provider；两个冲突 Provider；版本不兼容；声明 `memory.final.write` 等未批准权限；缺许可证、checksum 或签名。

## 第七步：停用、撤权、卸载和回滚

1. **Disable**：保留 Manifest、lock 和数据，阻止新调用，等待当前调用结束或取消；
2. **Revoke**：写入控制事件、阻断访问、撤销授权并触发 Owner Handler；
3. **Uninstall**：确认导出、迁移或删除后再移除实现；
4. **Rollback**：恢复上一份 Profile lock，验证 Contract、迁移和事件序列兼容；
5. **Zero recall**：检查 FTS、Vector、缓存、日记、视图投影和外部副本。

删除请求始终由 Aervox Privacy/Governance Substrate 发起；外部能力不能实现删除旁路。

## 第八步：可选接入 dsh-synapse 视图

`reference/dsh-synapse` 固定 commit 为 `a323f76b0c47ffad59194d8ac7efacb3aa6bdfba`，许可证为 MIT。接入时只映射 Session ID、分支锚点、位置、折叠和展示状态。Session/Message/权限仍由 Aervox 或 DSH Host 拥有；画布 JSON 是可重建投影，不是第二套消息数据库。

目标 Manifest 的 `data.owner` 应是独立的 `aervox.conversation.view`，而不是 `aervox.conversation`。DSH 或 Synapse 不可用时，原生 Conversation Consumer 仍必须工作。

## 验证与门禁

每完成一个迁移阶段运行：

```bash
mise x -- pnpm --filter @aervox/contracts typecheck
mise x -- pnpm --filter @aervox/api typecheck
mise x -- pnpm --filter @aervox/worker typecheck
mise tasks run ci-code
mise tasks run ci-docs
```

至少建立以下测试：

| 测试 | 验证内容 |
|---|---|
| Manifest schema | 必填字段、版本、来源、checksum |
| Capability graph | `requires/provides/conflicts` 和拓扑排序 |
| Lifecycle | activate、disable、revoke、uninstall、disposer 幂等 |
| Port contract | SQLite 与未来 PostgreSQL Provider 语义一致 |
| DSH adapter contract | Plugin、事件、超时、候选写入、无 DSH 回退 |
| pi adapter security | 外部进程、Project Trust、权限、kill switch、文件隔离 |
| Profile reproducibility | 同一 Profile + lock 得到同一 activation plan |
| Deletion zero recall | 索引、缓存、视图和外部副本清理 |
| Core no-plugin E2E | 不安装 DSH/pi 时学习、导出和删除仍通过 |

将实现登记到[需求追踪基线 §4.2](../reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)。来源字段分别写 `native`、`DSH`、`pi` 或 `dsh-synapse`；当前 DSH/pi Adapter 仍是 `Planned`，不可登记为已完成。

## 常见错误

| 错误 | 后果 | 修复 |
|---|---|---|
| 用 `modules/*` 目录表达能力边界 | 代码来源和语义边界混淆 | 以 Manifest/Definition/Provider 表达能力 |
| 把 DSH `cordis.patch.yml` 当作 Aervox Profile | 外部配置成为内部事实源 | 只在 `adapter-dsh` 解析并生成 lock |
| 在 API 进程直接加载 pi Extension | 任意代码获得核心进程权限 | 外部 Host + Permission Broker + kill switch |
| 用 dsh-synapse 画布保存消息正文 | 形成第二套会话真源 | 只保存投影和真实 ID |
| 插件直接写 MemoryRecord 或 Review 状态 | 绕过用户确认和业务规则 | 使用 Candidate/Command Port |
| 禁用能力时删除全部数据 | 破坏导出、恢复和重新启用 | Disable 保留数据，Uninstall 先迁移/删除 |
| 缺 Provider 时自动跳过 | Profile 不完整但看似启动 | Resolver 显式失败 |
| 第一轮接 shell 或文件写入 | 隔离和安全评审面过大 | 先接只读 Tool/Event |

## 下一步

本教程完成后建立 `ADR-016`，明确 Kernel Substrate、`AVX-MOD-001` 的替代/迁移日期、`ADR-014` 的过渡期，以及 DSH（DeepSeek Harness）、pi、MCP 和 dsh-synapse 的统一 Adapter 范围。在 ADR-016 和相关 `CR-*` 接受前，生产 Profile 不应把外部 DSH/pi 运行时视为核心依赖。
