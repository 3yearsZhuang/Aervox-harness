# 术语表（唯一含义与规范写法）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-28

> 文档编号：AVX-TERM-001
> 类型：Reference
> 版本：v0.3
> 更新日期：2026-08-28
> 状态：Review Candidate
> 关联：[文档写作规范](doc-standards.md)

本表是项目术语的唯一事实源。正文一律使用「规范写法」列；「禁写」列由 Vale 的 [`Project/Terms.yml`](../../../.vale/styles/Project/Terms.yml) 自动校验（规则见 [文档写作规范 §5](doc-standards.md#5-vale-术语门禁)），应为其它拼写变体时在提交前修正。

## 产品与代号

| 术语 | 唯一含义 | 规范写法 / 禁写 |
|---|---|---|
| Aervox（思隅） | 产品名 | `Aervox`；禁 `aervox`（命令与仓库路径除外） |
| `CAP-###` | 用户可感知的能力条目 | `CAP-010`；禁裸写 `cap` |
| `CR-###` | 变更请求，记录已批准文档的修订 | `CR-003`；禁裸写 `cr`/`变更单` |
| `ADR-###` | 架构决策记录 | `ADR-014`；禁裸写 `adr` |
| `EXP-###` | 待验证假设（实验） | `EXP-001`；禁裸写 `exp` |
| `RISK-###` | 风险登记项 | `RISK-001`；禁裸写 `risk` |
| `AVX-###-###` | 文档/契约编号前缀 | `AVX-DB-001`；禁裸写 `avx` |

## 领域概念

| 术语 | 唯一含义 | 规范写法 / 禁写 |
|---|---|---|
| 会话 / Session | 用户与 Aervox 之间的一次持续对话上下文 | `Session`（英文语境）/ `会话`（中文语境）；不指代 Turn 对象 |
| Turn | 一次完整的请求-响应轮次，含 SSE 事件流 | `Turn`；禁 `轮询`/`轮次` 指代 Turn 对象 |
| Agent Harness Loop | 驱动一个 Turn 内 Context、模型、工具、多 Step 与终止的执行循环 | `Agent Harness Loop` / `Agent Loop` / `智能体执行循环`；不指 Worker 定时轮询或 SSE 读取循环 |
| TurnAttempt | Turn 的一次带 lease/fencing 的内部执行尝试 | `TurnAttempt`；客户端不依赖该身份 |
| AgentStep | TurnAttempt 内一次模型请求及工具结果闭环 | `AgentStep` / `Step`；不等同于 Turn |
| AgentInboxItem | 提交给 Agent Loop 的 follow-up、steer 或 context injection | `AgentInboxItem` / `Agent Inbox` |
| 模块化单体 | ADR-014 定的 API 组织方式，自包含模块 | `模块化单体`；禁 `微服务` |
| 仓储 Port | 数据库访问的接口抽象（Repository Port） | `Port` / `仓储 Port` |
| Capability | 由 Profile 选择的语义能力，不等同于包或插件文件 | `Capability` / `能力` |
| Definition | Capability 的稳定 Port、事件、错误与数据语义 | `Definition` / `能力定义` |
| Provider | 对某个 Definition 的可替换实现 | `Provider` / `能力提供方` |
| Consumer | 调用或展示 Definition 的能力、API、Worker 或 Shell | `Consumer` / `能力消费方` |
| Adapter | 外部运行时与 Aervox Contract 之间的翻译边界 | `Adapter` / `适配器` |
| Capability Host | 执行解析、生命周期、权限和隔离的宿主进程 | `Host` / `Capability Host` |
| Kernel Substrate | 不可由 Profile 关闭的生命周期、权限、数据权利与审计不变量 | `Kernel Substrate` / `Kernel` |
| Manifest | 描述能力身份、依赖、权限、数据和入口的机器可读声明 | `Manifest` |
| Profile / Bundle / Overlay | 运行组合 / 分发集合 / 配置覆盖层 | `Profile` / `Bundle` / `Overlay` |
| Contribution | Plugin/Extension 向 Host 提交的受限 Tool、Provider、Event 或 UI 能力 | `Contribution` |
| 双引擎 | SQLite 与 PostgreSQL 互为切换的数据真源模式 | `双引擎`；禁 `双主`/`多主` |
| 迁移三阶段 | Expand → Migrate → Contract 的表结构演进 | `Expand/Contract 迁移` |
| 删除传播 | 删除实体时按引用关系级联清理 | `删除传播` |
| Outbox | 事务内落表、后台投递的事件模式 | `outbox`（小写英文） |
| 幂等 | 重复投递/重试不产生重复副作用 | `幂等` |

## 阶段、优先级与门禁

| 术语 | 唯一含义 | 规范写法 / 禁写 |
|---|---|---|
| P0～P3 | 能力优先级，不是发布阶段 | `P0`/`P1`/`P2`/`P3` |
| R0～R5 | 发布阶段，不是能力优先级 | `R1`/`R1.5`；禁与 P 混用 |
| MVP / MVP+ | 最小可行产品 / P0 增量批次 | `MVP`；禁 `mvp` |
| `DoR` / `DoD` | 就绪定义 / 完成定义 | `DoR`/`DoD` |
| G0～G6 | 发布门禁节点（G6=发布后验证） | `G2 评审`；禁裸写 `gate` |
| FR / BR / NFR | 功能 / 业务 / 非功能需求 | `FR-###`、`NFR-###` |

## 技术栈与产品名

| 术语 | 规范写法 | 禁写 |
|---|---|---|
| 数据库 | `SQLite`、`PostgreSQL` | `sqlite`、`postgres` |
| 模式工具 | `Drizzle` | `drizzle` |
| 契约工具 | `OpenAPI`、`Zod` | `openapi`、`zod` |
| 服务框架 | `Fastify`、`Koa` | `fastify`、`koa` |
| 客户端 | `Electron`、`Capacitor`、`Vue` | `electron`、`capacitor`、`vue` |
| 构建测试 | `TypeScript`、`Vite`、`Vitest`、`Node.js` | `typescript`、`vite`、`vitest`、`nodejs` |
| 工具链 | `pnpm`、`mise`、`npx` | 保持小写（产品官方拼写） |
| 外部运行时 | `DSH`（DeepSeek Harness）、`pi` | `DSH` 专指 `reference/deepseek-harness`；`dsh-synapse` 是独立插件，不是 DSH 本体 |

## 维护规则

- 新增或更改术语含义时，本表与 [文档写作规范 §5](doc-standards.md#5-vale-术语门禁) 一并更新，必要时登记 `CR-*`；
- 正文使用被禁止的拼写且未在本表登记豁免时，Vale 会在文档 CI 中报错。
