---
id: AVX-CAP-001
---

# Aervox 能力组合与数据所有权

<a id="AVX-TUT-002"></a>

本文保留能力组合独有的边界：什么可选、谁拥有数据、代码缺席如何收敛，以及外部运行时如何受限接入。CAP 分类、交付载体、状态与证据统一见[追踪矩阵](REQUIREMENTS_TRACEABILITY.md#4-cap-001cap-035-覆盖矩阵全部能力状态唯一速览)；架构决策见 [ADR-016](adr/ADR-016-base-boundaries.md)，现行包与进程见[架构](ARCHITECTURE.md)。

## 核心与可选的边界判定

一个功能同时满足以下条件才可纳入自选：移除后标准学习闭环完整；存在不侵入核心实体的公开接口；启停可撤销且不破坏数据；独立版本、发布或授权有价值。承担学习事实、安全、隐私、保留、删除、导出与恢复的责任不随实现开关关闭。

P0（CAP-001～013）必须进入标准产品 Profile 与默认构建；环境裁剪不修改标准产品承诺。CAP-027 是不可关闭的本地 SQLite 真源与数据权利责任。将 P0 改为自选、改变数据所有权或扩大外部权限需要先修订架构决定，不能仅移动目录完成。

<a id="交付载体与自选机制必选"></a>

## 交付载体与自选机制

构建选择决定代码是否进入产物；运行选择决定已安装代码能否被当前用户触发。未纳入默认构建集的可选能力不进入默认产物；运行停用保留既有数据和管理入口。两轴登记在追踪矩阵，不维护第二份清单。

### 模块化交付不变量

原 AVX-MOD-001 的交付约束继续有效：已裁决为独立演进、自选交付的非核心功能使用独立仓库及固定 commit/tag，经 `modules/*` 与 workspace 包消费，不复制实现或用路径绕过。当前尚无已注册的独立模块，`modules/*` 的完整构建/初始化门禁是目标机制，不是已存在运行能力；主仓已经交付的能力不自动重新分类。

每个模块接口只有一个可编辑来源（公共类型/Schema 与契约），不得在模块和主仓维护平行实现。只有组合根选择 Provider，消费者经公开 Query/Command Port；接口、迁移和回滚兼容随模块版本验证。`reference/` 是固定版本的只读研究材料，不作为 workspace 业务依赖；许可规则见[上游清单](ARCHITECTURE.md#reference-manifest)。

## 概念与依赖方向

| 概念 | 准确定义 |
|---|---|
| `Capability` | 用户或系统可选择的语义能力，例如对话、复习、会话地图 |
| `Definition` | 能力稳定的 Port、事件、错误和数据语义 |
| `Provider` | 对某个 Definition 的实现，例如 SQLite Memory、远程 LLM |
| `Consumer` | 调用或展示 Definition 的能力、API、Worker 或 Shell |
| `Plugin/Extension` | 向 Host 注册 Provider、Consumer 或 Contribution 的代码载体 |
| `Adapter` | 把外部运行时翻译为 Aervox Contract 的边界 |
| `Host` | 执行生命周期、权限、隔离和调用调度的进程 |
| `Contribution` | Tool、Provider、Event Listener、Command、UI Slot 等受限贡献 |
| `Manifest` | 身份、版本、依赖、权限、数据和入口的机器可读声明 |
| `Bundle` | 可一起分发的一组能力、Provider 和适配器 |
| `Profile` | 一套可运行的能力选择和 Provider 绑定 |
| `Overlay` | 对 Profile/Bundle 的环境或本地用户配置覆盖 |

`@aervox/core` 是执行内核，不是不可替换的产品业务目录。目标 Profile 可裁剪业务 Provider，但标准产品必须兑现 P0，Kernel 责任不能被裁剪。

```text
Consumer -> Definition/Port <- Provider
Adapter -> External Runtime + Aervox Contract
Host -> Provider selection + lifecycle
```

能力和 Consumer 不导入具体 SQLite、Drizzle、LibSQL 或外部运行时内部类型。跨能力写入只经公开 Command Port、候选或 typed event；不能自行拼接跨模块事务。

## 数据、安全与运维

| 数据 | Owner | 外部能力允许动作 |
|---|---|---|
| Session/Message/Turn | Conversation | 受限 Command 或候选事件 |
| Learning/Attempt/Review | 对应学习能力 | 提交候选，不能改最终掌握事实 |
| MemoryRecord/Revision | Memory | 提交 `MemoryCandidate` |
| Diary/Version | Diary | 提交授权素材或生成候选 |
| Consent/Deletion/Audit | Kernel Data Rights | 只允许 Host 受控操作 |
| View metadata | 对应 View Capability | 可重建、可导出、不可覆盖真源 |
| CAP-033 Profile/Action/Source | CAP-033 Privacy Host | 只在用户确认的 grant/revision、OS 能力和本地处理边界交集内观察、提炼和动作；原始副本七天且提炼后清理 |
| CAP-034/035 Connection/Entity/HealthSample | CAP-033 本地连接网关 | 只暴露脱敏连接状态、授权实体和规范化每日指标；凭据不进入 Contribution，撤销连接删除凭据与对应缓存 |

外部能力的有效权限是 Manifest 声明、本地用户授权和当前 Policy 的交集。模型请求、插件声明或外部运行时自报的身份字段不能产生授权。删除必须传播到摘要、索引、缓存、视图投影和外部副本，不能只删除安装记录。

## Kernel 的强制责任

组合/生命周期、协议校验、Policy/Consent、数据权利、Outbox/审计、沙箱/撤权及可观测/恢复是所有组合共同承担的责任。无法满足权限、删除和审计的外部代码或 Provider 不得激活；没有用户能力的组合仍须保留管理、导出、删除与恢复入口。

## Build to Delete 的公开边界（CR-056）

模块同步请求使用公开 Query/Command Port，可靠事实和后台工作使用 Outbox；可丢通知不得作为提交证明。领域命令承担业务原子性，普通消费者不能拼接跨模块事务。模块只经 `index.ts` 对外，组合根负责选择实现；导入模块不启动资源。首轮仍沿用既有交付载体，不将标准产品能力自动变为可选。

代码缺席与显式卸载分开：缺少包、不可读目录或非法清单只能阻断执行并保留诊断、配置、Secret 和数据管理入口。恢复包须重新校验当前授权。注册、在途任务和释放句柄绑定实例代际；旧句柄/迟到结果不能操作新实例。具体实施证据见 CR-056（已归档至 Aervox-docs-archive）。

<a id="future-composition"></a>

## 目标组合模型（提案，尚非目录现状）

以下是已接受方向下仍待实施和验证的设计，吸收原迁移教程 AVX-TUT-002 的有效内容；示例名称不声明路径、Resolver 或 SDK 已存在。当前真实落点由架构和源码决定，实施不能恢复 CR-030 已删除的 `@aervox/database` 兼容出口。

### 目标目录与所有权

| 目标位置 | 拟承担责任 | 不得承担 |
|---|---|---|
| `capabilities/*` | Definition、Application、Consumer、Manifest | 具体数据库连接、Shell API、外部运行时类型 |
| `providers/*` | Definition 的具体实现 | HTTP/UI 与其他领域编排 |
| `adapters/*` | 外部协议翻译、进程、Contribution 映射 | 核心数据直写和产品事实真源 |
| `packages/host-*` | 组合根、注册、生命周期、调度 | 具体能力规则 |
| `profiles/*` | 选择、Provider 绑定、Overlay/lock 输入 | 业务 TypeScript 实现 |
| `registry/*` | 来源、版本、许可、完整性与迁移证据 | 未固定版本的可执行代码 |

Definition、Provider、Consumer 可在同一个 workspace 包内分层；出现第二种 Provider/Consumer 或独立发布需要时再拆包。目录分层不能产生两条写入事实的路径。

### Manifest 与 Profile

目标 Aervox Manifest 需描述身份/版本/来源 ref/许可证、角色与 `provides/requires/conflicts`、默认激活/平台、权限模式与 scope、数据 owner/读写/保留/删除、事件、Host 入口、Kernel/Contract 兼容、checksum 和签名状态。外部 `package.json`、DSH Bundle/Profile 或 pi 配置仅作为 source metadata，不能替代内部契约。Provider 另声明实现的 Definition、优先级、隔离和迁移能力。

Profile 合并顺序为 Kernel → Capability Bundle → Provider Bindings → Host/Shell Bindings → Local User Overlay。Resolver 应校验来源与版本、完整性、许可、撤销、唯一兼容 Provider、冲突、平台/信任/数据责任和迁移兼容，再按依赖拓扑生成 `profile.lock`（版本、SHA、checksum、许可、权限交集、activation plan）。缺 Provider 或权限失败必须显式拒绝，不能静默跳过；相同 Profile + lock 应得到相同计划。

### 生命周期与迁移切片

目标状态为 `discovered → verified → resolved → installed → enabled → activating → ready`，并可转 `degraded/disabled/revoked`、`uninstalling → removed`。单能力失败可降级，Kernel 失败中止启动。注册、监听器、Provider、定时器、子进程、临时资源和在途调用绑定实例代际；停用阻止新调用并等待或取消在途任务，逆序释放且 disposer 幂等。

迁移先选 `aervox_memory_store` 这类已有限权调用链：工具只提出带来源的 MemoryCandidate，不把 `ai_inferred` 直接晋升长期事实；Application 只依赖 Port，具体 SQLite 由组合根注入。兼容路由和新 Host 共用单一 Application/写路径，契约、导出与回滚验证通过后再删除旧入口。

Worker 的目标 Job Handler 接收 `AbortSignal` 并报告处理/可重试结果；Host 只管注册、顺序、租约、超时、重试、DLQ 与关闭。复习通知经 Review/Notification Port，日记经 Scheduler/Material Port，删除按 ownerModule 派发，Embedding 经 Backfill Port，压缩经 Memory Job Port 并保留 Outbox 幂等；不把裸 SQL 移进新的消费者。

Disable 保留 Manifest、lock 和数据；Revoke 写控制事实并立即阻断访问；Uninstall 先确认导出、迁移或删除；Rollback 恢复上一 lock 并验证契约/迁移/事件兼容。代码缺席与卸载仍按上文公开边界区别处理。

### DSH 与 pi 的受限适配

DSH 的 `inject/service key/apply(ctx)/typed event/effect` 分别映射 requires、Definition、activate、版本事件与 disposer；`cordis.patch.yml` 只在 Adapter 内解析为 Overlay 输入。Adapter 启动或连接固定版本外部 Host，规范化 service/tool/event/provider，并传递受限 Context、权限决定、取消与审计。Cordis Context、DSH Session 或外部工具类型不穿透业务 Port；DSH 会话日志不能替代 Aervox 事实。

pi 的 factory、registerTool/on/registerProvider/registerCommand、appendEntry 与 package resources 分别映射激活、受限贡献及有生命周期的数据；仅允许白名单资源类型，global/project settings 只是来源范围，`pi config` 不替代 Consent。Extension 默认拥有系统权限，必须在进程外经 Project Trust、Permission Broker、超时/输出/并发/资源配额及 kill switch 运行；禁止在 API、Worker、Renderer 或 Node.js `vm` 直接加载。

首轮实验仅使用只读 Tool/Event。外部参数重新按内部 Schema 校验，未批准权限失败；崩溃、超时、非法 Schema 或未安装时标记 Adapter 降级并保留原生能力；Host 被杀后核心会话、导出和删除仍可用。既有 DSH 整 Turn Driver 的实际范围见 [Harness 契约](agent-harness-loop.md)，不与本提案的通用组合 Host 混为一谈；pi 接入仍需独立验证。

### dsh-synapse 边界

Synapse 是 DSH 的独立视图插件，不是 DSH 本体；只保存真实 Session ID、分支锚点、位置、折叠与布局。目标 owner 为 `aervox.conversation.view`，消息、权限和删除归业务 Host；画布 JSON 不能成为第二套消息数据库。DSH/Synapse 不可用时原生 Conversation Consumer 继续工作。

### 提案验收面

需要 Manifest、依赖图、Port 契约、生命周期/代际、Profile 可重复性、DSH 控制、pi 进程/文件隔离，以及删除零召回测试；验证缺依赖、冲突、未批准权限、版本/许可/完整性失败、超大输出、取消、Host kill 与重复 disposer。没有 DSH/pi 仍能运行核心学习、导出和删除。外部来源、SHA、checksum、许可、权限和回滚证据随交付 PR 保留，具体发布 gate 统一见[追踪基线](REQUIREMENTS_TRACEABILITY.md#9-发布门禁)。
