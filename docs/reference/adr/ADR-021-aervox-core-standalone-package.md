---
id: ADR-021
decision_status: accepted
---

# ADR-021 Aervox Core 独立内核包与最小发行边界

## Context

维护者于 2026-10-03 接受独立内核包、Apache-2.0 许可及包内 Provider 统一。此前轻量消费者因 CLI 审批位于 Host 包而被迫依赖 SQLite，内核与产品域出口也混杂，难以形成可独立使用的库。

历史来源保留于 [PR #231](https://github.com/3yearsZhuang/Aervox-harness/pull/231)、[回退 #232](https://github.com/3yearsZhuang/Aervox-harness/pull/232)、[关闭的 #235](https://github.com/3yearsZhuang/Aervox-harness/pull/235)、[内核切片 #241](https://github.com/3yearsZhuang/Aervox-harness/pull/241) 与 [#244](https://github.com/3yearsZhuang/Aervox-harness/pull/244)。ADR-020 已退役，不复用其编号。

## Decision

1. `packages/core`（`@aervox/core`）承载宿主无关的执行器、ControlContext、审批 SPI、取消原语、上下文、Provider、内存工具运行时和执行存储；保持零运行时依赖，不导入数据库、宿主或产品实现。
2. CLI TTY 审批和纯内存组合入口归 Core；SQLite 注册表、业务持久化、进程生命周期和产品装配归宿主。Core 是库，不能以独立发行替代 API/Worker 的所有权或恢复责任。
3. Core 使用 Apache-2.0，产品代码仍按 AGPLv3 分层；公开出口不包含伴学提示词、作答落库工具或产品域类型。
4. 统一模型调用面在 Core 内形成公共 API，经 Provider Port 消费；不为统一模型再建立第二套执行循环。
5. 公共出口为 `@aervox/core` 与 `@aervox/core/core`，内部收集、终态、工具账本及序列化实现不自动成为稳定 API。公开 npm 发布、包名/版本策略和发行文档另行决定；当前保持 private workspace 包。

## Alternatives

| 方案 | 拒绝或采用原因 |
|---|---|
| 新 Core 包渐进吸收 | 采用；可分步迁移与回退，明确包和许可边界 |
| 直接改名并一次修改所有下游 | 当时拒绝；改动面和历史断裂过大 |
| 仅在 Host 包增加子路径出口 | 拒绝；安装仍牵引数据库依赖 |
| 先在旧包统一 Provider 再立包 | 拒绝；重复搬迁并使新包出生时 API 仍不稳定 |

## Amendment

内核提纯修订将专注模式提示词、`PracticeAttemptPort` 与作答工具迁回产品；宿主工具 guidance 经 `customGuidance` 注入。通用用户提问与子任务贡献仍属内核。第一方插件最终归属见 [ADR-016](ADR-016-base-boundaries.md#cr-060)。

渐进迁移的 `packages/agent-loop` re-export 壳和 Host CLI 审批壳已移除，下游直接消费 Core；Core 本地定义通用负载，类型兼容由测试锁定，不再依赖 Contracts 类型。旧壳不作为长期兼容入口。

<a id="cr-061"></a>

## 执行与恢复合同修订

原 CR-061 于 2026-10-08 接受以下执行边界，实施证据见 [PR #257](https://github.com/3yearsZhuang/Aervox-harness/pull/257)，详细参数和规则以[执行规范](../agent-harness-loop.md#execution-contract)为准：

- API 与内存宿主复用工具运行时，审批后重新核对取消、租约、注册代际、插件生效状态与当前授权；门控上下文缺失拒绝派发。
- 模型截断、过滤、异常终止或不完整工具参数不能触发工具批次；安全正文前缀可保留，但回合不得标为完整成功。模型能力、窗口和用量经 Provider 合同表达。
- 下一步指令进入实际请求；每 Step 使用当次受权工具声明快照，执行时复验。最终序列化输入与预留输出共同校验模型窗口，超限明确拒绝。
- 压缩保持系统约束与完整工具调用/结果组，省略不冒充摘要；正文以有界窗口提交，取消和丢租约可中断静默源，已提交正文不得重试重复输出。
- 恢复逐执行标识核对完整账本、最新意图及持久事件上界，仅确定结果可续跑；未知结果、审批待决、撤权、删除或损坏配对均拒绝自动恢复。
- 恢复默认关闭；`AERVOX_LOOP_RESUME=local-results` 只允许当前准入的本机模型补完已知工具结果正文，不派发新工具、不运行回合插件钩子。未知副作用不能在降级时重试。

该修订不改变数据库 Schema、持久化终态枚举、公开 SSE 形状或本地单用户部署；没有历史数据转换，不含公开软件包发布与生产数据库操作。

## API 与 Worker 共享产品宿主

维护者在 PR #280 审核修复中选择完整提取宿主装配。`@aervox/host-runtime` 统一持有产品模块、人格、Skill、插件、工具、审批、隐私闸门与模型路由；`apps/api` 负责监听，`apps/worker` 负责持久队列与调度，二者调用同一会话执行入口。`@aervox/host-agent` 保持 SQLite 执行适配职责，Core 保持无产品依赖。

默认 Turn 仍由 API 执行。只有 `AERVOX_LOOP_DISPATCH=worker` 的后台接单写入 `agent.turn.requested` 并由 Worker 消费；`turn.created` 保留 API 归属，不能投影成 Worker 工作。inline 模式始终由 API 执行。接单事务同时保存执行归属、metadata、独立的工具审批模式、认证审计身份、用户输入和首个 Attempt，产品前置钩子之前即领取 Attempt，准备阶段续租并将租约交给内核；重复投递由 fencing 拒绝，不能重复触发前置副作用。

共享宿主目前保留 Fastify 模块生命周期及路由装配；Worker 调用 ready/close 而不监听产品 HTTP 端口。主动集成的周期同步只由 API 启动，Worker 保留按需调用工具；MCP handler 启动时及执行前从持久注册表恢复。两进程的用户提问通过持久事件唤醒，审批继续使用共同账本。关闭顺序为取消执行、排空任务、释放宿主与数据库。

这一步接受 Worker 加载完整产品依赖的成本，避免两套装配产生权限和工具差异；不把所有模块再次拆成独立服务。恢复仍遵循上节的本机已知结果限制，不自动重跑插件、工具或未决副作用。关闭 dispatch 开关只影响后续接单；已有 Worker 事件需排空或按既有恢复规则中断，不转交 API 抢跑。上线需先更新 Worker 再开启 dispatch，不能让旧通用 Outbox 消费器吞掉委托事件。

## Consequences

轻量消费者无需启动 Fastify 或 SQLite 即可使用多步工具循环；产品与宽松许可内核分离。代价是维护包公开面、许可与宿主 Port，不能把内存实现的独立性当作生产持久化、撤权或进程管理已完成。

## Verification and rollback

验证公开入口和 headless 多步调用，覆盖审批、取消/丢租约、父子控制、截断、真实请求快照、工具配对、事件高水位和慢源。API/SQLite 适配须验证实际副作用与恢复，性能基准记录首段可见、取消、缓冲上限及 SQLite 写竞争；组件基准不作为用户环境性能承诺。实现测试与 PR 负责交付证据，本 ADR 不推定 Released。

代码回退须同时回退包出口和下游引用，保留许可边界与未知副作用拒绝策略。关闭恢复开关回到既有 Worker 中断收敛；没有数据转换，不需换库。新恢复模型、工具执行或部署边界须重新评审决定。
