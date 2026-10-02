---
id: AVX-EXPL-002
type: explanation
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.10.0
updated_at: 2026-09-29
reviewed_at: 2026-09-29
review_interval_days: 90
---

# 参考项目能力迁移与借鉴评估

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-09-29

关联：[参考项目与借鉴边界](../reference/PRD.md#15-参考项目与借鉴边界)、[SQLite 本地单用户数据库契约](../reference/DATABASE.md)、[能力注册表](../reference/capability-registry.md)、[Agent Harness Loop 规范](../reference/agent-harness-loop.md)、[AI 质量与安全规范](../reference/AI_QUALITY_SAFETY.md)

> [!NOTE] 调研生命周期状态：已落地 (Adopted)
> 本文梳理的外部参考项目（DSH、pi、AstrBot 等）能力借鉴与上游版本固定已在 ITER-030 落地并完成准入固定。

当前迭代建议与实施排序统一见根 [plan.md](../../plan.md)（AVX-PLAN-001），规划边界见[文档治理规范 §3.1](../reference/document-governance.md#31-当前迭代计划的唯一入口)。本文保留参考设计的判定理由、来源编号、许可证边界及历史映射；A/B/C 判定与旧批次不表示当前排期或最新实现状态。

## 1. 评估范围与判定框架

本评估回答：`reference/` 内参考项目中哪些设计适合在本项目落地，哪些仅作为设计参考。当前覆盖 BaiShou-Next、AstrBot、Petra、dsh-synapse、DeepSeek Harness（DSH）与 pi 六个固定版本。DSH 与 pi 的 Agent Loop 设计来源分别登记为 `DSH-01` 与 `PI-01`；它们只用于验证目标控制流和接口边界，不改变 Aervox 的数据所有权或安全模型。评估结论与 [PRD §15](../reference/PRD.md#15-参考项目与借鉴边界) 的参考项目策略保持一致。

判定框架有三条边界：

1. **许可证边界**：BaiShou-Next 与 AstrBot 均采用 AGPLv3，按 [PRD §15.1](../reference/PRD.md#151-参考实现要求)，除非完成许可证评审，只借鉴公开设计和数据模型，不直接复制其代码或形成链接依赖；Petra 采用 MIT，可作为较低风险的表现与交互实现参考，但复制代码仍需按 PRD §15.1 记录文件来源、版权声明与许可证影响。因此下文"建议落地"一律指在 Aervox 内**自研重写其设计**，不拷贝源码。
2. **架构契合度**：BaiShou-Next 是 Electron/Expo 本地优先应用，AstrBot 是 Python 异步 IM 机器人框架，Petra 是 Tauri 2 桌宠（Windows 优先）；Aervox 是 Fastify 服务端 + Web/Desktop 客户端。仅评估与 Aervox 模块化单体、Port 存储、Worker 异步链路兼容的设计。
3. **落地成本与优先级**：以 P0/P1 能力为优先，避免为远期功能引入当前不需要的复杂度。

判定结果分为三类：**A 建议落地**（符合 Aervox 规划、可在现有架构内自研实现）、**B 值得借鉴**（设计有价值但在本阶段不落地）、**C 暂不采用**（与目标架构冲突或依赖不匹配）。

### 1.1 Agent Loop 参考来源登记

`DSH-01` 与 `PI-01` 是 Agent Harness Loop 相关参考设计的唯一来源编号。实现登记中的 `来源` 列只能使用这两个编号指向下表，不能把外部仓库当作 Aervox 的运行时依赖或事实源。

历史来源说明：2026-09-28 的 CR-056（Build to Delete 与类 pi 分层架构规划，已归档至 Aervox-docs-archive）继续使用 `PI-01`：在同一固定版本上补充模型注册的代际控制、扩展上下文失效、协议 DTO 映射和客户端快照设计参考，具体源码见 CR §2.2。当时首先交付规划，后续接受与部分实施状态见 CR 本身；该次旧 SHA 的设计证据保留，本次最新源码复评见[§8](#upstream-20260929)。不复制参考运行时代码，实现证据仍只登记 §4.2。

| 来源编号 | 固定参考 | 重点证据 | 可借鉴设计 | Aervox 明确不迁移 |
|---|---|---|---|---|
| `DSH-01` | `reference/deepseek-harness`，commit `639ed015397290b3745d163aafe02ffee4aa3f84`，MIT | `packages/core/agent-loop/src/agent.ts`、`docs/architecture.md`、`packages/core/agent-loop/README.md` | Turn/Step 双层循环、模型流与工具请求交替、typed event、`followup`/`steer`/`inject`、可逆 effect/disposer | DSH Session log、Cordis Context、DSH 权限系统、直接连接 Aervox SQLite |
| `PI-01` | `reference/pi`，commit `5257d0d5f3ab7d42550804f32c67a77b49f485d4`，MIT | `packages/agent/src/agent-loop.ts`、`packages/agent/src/harness/`、`packages/agent/docs/harness.md` | outer follow-up loop、inner tool/steer loop、工具参数准备与结果回填、append-only/reducer、Session 串行提交、operation/invocation 失效校验 | pi Session/存储格式、Extension 宿主权限、直接加载到 API/Worker/Renderer；当前有 CLI、lane Harness 与新 durable 三条路线；成熟度分别见 §8.3，不能视为思隅已接入 |

固定版本的终止语义并不相同：DSH 在一个已结算工具批次中任一成功结果声明 `concludesTurn` 即可结束，pi 低层 loop 则要求非空批次的所有结果 `terminate=true`。Aervox 统一采用后者的严格策略；`adapter-dsh` 必须显式收紧或拒绝不兼容的混合批次，不能把上游 any 语义静默暴露给业务。pi 的低层 `agent-loop.ts` 仍可作为控制流参考；本次固定版本的 lane Harness 已实现 `prompt`/`resume`/`abort`，但尚有未完成接口，新 durable 路线也不能视为完整聊天内核，详见 §8.3。

采用方式固定为“自研重写 + Adapter 翻译”：Aervox 先以 [AVX-HAR-001](../reference/agent-harness-loop.md) 的 Definition、Port、事件和状态机为准，再为 DSH/pi 生成可替换 Loop Driver、Model Provider 或受限 Contribution。外部参考的示例名称、Session ID、工具参数和事件序列都必须经过 Aervox schema、Consent、ToolPolicy、租约和审计检查。

## 2. 结论摘要

| 编号 | 设计 | 判定 | 落点 | 关联需求 |
|---|---|---|---|---|
| T-01 | SQLite 写路径 busy 重试（指数退避） | A | `packages/repositories` 写路径 | WAL 多进程并发（DATABASE.md） |
| T-02 | FTS + 向量 RRF 混合检索 + JS 余弦降级 | A | `packages/repositories/src/search` | 记忆召回窗口 |
| T-03 | 上下文压缩标记（snapshotId 写回会话） | A | 临时→短期整理链路 | PRD §7.5 记忆验收标准 |
| T-04 | 工具注册表 + 主动记忆工具 | A | AI 运行时工具系统 | CAP-020、记忆晋升候选 |
| T-05 | Embedding 独立存储 + 可中止的迁移控制 | A | `memory_embeddings` 独立表 | SQLite Vector Port（ADR-003） |
| T-06 | 数据库迁移服务（journal + 旧库补齐） | B | 存储层演进 | DATABASE.md 迁移三阶段 |
| T-07 | 桌面 preload 按域划分 IPC API | B | `apps/desktop` | 桌面端功能扩展 |
| T-08 | 桌宠角色设定文档化 | B | 文档组织 | 桌宠 IP、CAP-019 |
| T-09 | Git 作为数据版本/同步层 | B | 本地优先与导出 | PRD §15.2 决策 4 |
| T-10 | Token 用量分账（缓存/非缓存） | B | `ModelRun` 埋点 | AI 质量与安全规范 |
| T-11 | 多工作区 vault 双库模型 | C | — | 与 CR-030 本地单用户边界冲突 |
| T-12 | Expo 移动端与 WebView 日记编辑器 | C | — | 与 ADR-015（Capacitor）冲突 |
| T-13 | 云同步/局域网快传/定价/更新器 | C | — | 商业化能力不在当前路线 |
| AST-01 | 会话级写锁（引用计数回收、按事件循环隔离） | A | 会话写路径进程内锁 | 与 T-01 互补 |
| AST-02 | 向量库 Port 批量/重试/进度回调接口形态 | A | T-05 落地时对齐 Port 语义 | SQLite Vector Port（ADR-003） |
| AST-03 | 人设字段化 + 逐级解析 + 默认兜底 | B | 随 CAP-019 立项 | 桌宠 IP、CAP-019、T-08 |
| AST-04 | 插件元数据模型 + 工具配置条件门控 | B | CAP-020 插件权限模型 | T-04 |
| AST-05 | Pipeline Stage 显式顺序 + 迁移完成标记 | B | Worker/中间件管线演进 | T-06 |
| AST-06 | IM 平台适配/群聊白名单/内容安全链路 | C | — | 与伴学 1v1 场景冲突 |
| AST-07 | Dashboard 面板形态与 zip 更新器 | C | — | 与 T-13 同理由 |
| AST-08 | 声明式插件配置（`_conf_schema.json` 模式） | B | CAP-020 插件配置解析与可视化 | 自研 Aervox Config Schema v1 |
| AST-09 | 插件页面 + 受限 iframe Bridge | B | CAP-020 插件 Page | 自研 Aervox Page Bridge，仅本地 Bundle 资源 |
| PET-01 | 桌宠表现命令通道（speak/emote/gesture/move/react） | A | 消息/SSE 契约预留表现指令 | 桌宠 IP、表现层与大脑解耦 |
| PET-02 | 结构化记忆条目字段（source 区分用户自述/AI 推断） | A | 记忆 schema 字段对照 | PRD §7.5 记忆验收标准、T-03/T-04 |
| PET-03 | 自主行为引擎参数化（活动频率三档/躲避/待机） | B | 桌面端角色行为 | T-07、桌宠 IP |
| PET-04 | 表现驱动数据对象 + 视图接口分离 | B | 桌宠表现层抽象 | 桌宠 IP、CAP-019 |
| PET-05 | AI 工具只读白名单与提示词使用原则 | B | 工具链安全规范 | AI 质量与安全规范 |
| Skill | Skill 能力（Anthropic Skills 渐进式披露 + Neo 生命周期） | B→已落地 | `apps/api/src/modules/ecosystem/skills/`、`packages/repositories` 技能表 | CAP-020 |

## 3. A 类：建议落地

### 3.1 T-01 SQLite 写路径 busy 重试

BaiShou-Next 对 `database is locked` / `sqlite_busy` 错误做指数退避重试（参考 `reference/baishou-next/packages/repositories/src/sqlite-busy.util.ts`）。Aervox 的 API、Worker、Desktop 共用同一 `data/aervox.db`（WAL 模式），多进程写竞争是既有风险点。

落点：在 `packages/repositories` 封装统一的写入重试工具，对所有事务性写操作包一层；重试参数（初始退避、最大次数）可配置。此为纯函数级自研，风险低，可在任意批次排期。

### 3.2 T-02 混合检索（FTS + 向量 RRF）

BaiShou-Next 并行执行 FTS 粗筛与向量细筛，用 RRF（Reciprocal Rank Fusion）融合排序，支持 `ftsWeight/vectorWeight` 权重；任一通道不可用时降级返回另一通道结果；在无原生向量库时用 JS 遍历余弦相似度兜底（参考 `reference/baishou-next/packages/ai/src/rag/hybrid-search.ts` 及其 service）。

Aervox 已具备两块输入：FTS5 虚表（`memory_records_fts` 等）与内存向量 Port（`packages/repositories/src/search/vector-port.ts` 的 `InMemoryVectorSearchAdapter`），目前尚未融合。

落点：在 `packages/repositories/src/search` 新增混合检索服务，复用现有 `IVectorSearchPort` 与 FTS5，输出统一召回结果。这是记忆召回窗口期检索的第一步，也是后续更换向量检索实现（如 `sqlite-vec` 扩展）时仅替换 Port 实现的边界。

### 3.3 T-03 上下文压缩标记

BaiShou-Next 在上下文压缩时生成 compaction 标记并写回会话：压缩摘要与时间轴锚点落库，按 `snapshotId` 可恢复被压缩内容与耗时信息（参考 `reference/baishou-next/packages/ai/src/agent/compaction-marker.ts`）。

Aervox 的 PRD §7.5 要求"短期记忆必须能查看由哪些临时记忆整理而来"，且任何模型更新不得改变已锁定记忆。compaction 标记与 `snapshotId` 正是满足该验收的溯源载体。

落点：临时→短期异步整理链路（Worker）写入 `MemoryEvent`/revision 溯源；`snapshotId` 关联源 `Turn/MessageVersion` 区间。需与[数据流总览](data-flow-overview.md)的"先写后投递"顺序一致，仅在完整响应持久化后生成标记。

### 3.4 T-04 工具注册表与主动记忆工具

BaiShou-Next 以 `ToolRegistry` 统一注册/过滤/导出工具（`disabledToolIds`、能力开关），并实现 `MemoryStoreTool` 让 Agent 主动存储长期记忆：调用 embedding、去重（外部服务或向量 fallback）、写入长期记忆索引；内部工具通过 MCP server 以 `baishou_*` 名称暴露（参考 `reference/baishou-next/packages/ai/src/tools/` 与 `packages/ai/src/mcp/baishou-mcp-server.ts`）。

Aervox 的 CAP-020 技能插件系统尚未落地，记忆生成链路也未接线。此设计为两者提供一个收敛的落地形态：

- `ToolRegistry` 的开关注册模型可作 CAP-020 插件权限模型的雏形（安装前展示权限、逐项撤销）；
- `MemoryStoreTool` 的"主动记忆 + 推断标记"模式与"模型推断只能作为候选"约束天然匹配：候选写入默认 `verificationStatus=unverified`，用户确认后才晋升。

### 3.5 T-05 Embedding 独立存储与可中止迁移

BaiShou-Next 将 embedding 存独立表 `memory_embeddings`（含 `dimension/modelId/sourceCreatedAt`），不塞进业务表；模型升级走独立迁移（快照备份 → 重新 embedding），并用全局 abort 控制支持中途取消（参考 `reference/baishou-next/packages/schema/src/vectors.ts` 与 `packages/ai/src/rag/embedding-migration.ts`、`migration-control.ts`）。

Aervox 已经采用 `memory_embeddings` 独立表与 SQLite Vector Port；换 embedding 模型不修改业务事实表。后续改动仍需保留“可中止 + 断点续跑”约束，避免长迁移阻塞 Worker，并遵循 CR-030 的备份和 staging 原则。

### 3.6 AST-01 会话级写锁

AstrBot 以 `SessionLockManager` 实现按会话粒度的写串行化：`asyncio.Lock` 引用计数、计数归零即回收、按事件循环隔离实例（weakref 持有，不跨循环共享锁）（参考 `reference/AstrBot/astrbot/core/utils/session_lock.py`）。

Aervox 的 API 与 Worker 都会写同一会话的 Outbox/MemoryEvent：T-01 的 busy 重试解决进程间竞争，进程内同一会话的并发写尚无串行化约束。会话锁与 busy 重试互补：锁降低冲突发生概率，重试兜底残留冲突。

落点：Worker/API 会话写路径的进程内工具；纯函数级自研，与 T-01 同批排期。

### 3.7 AST-02 向量库 Port 接口形态

AstrBot 以 `BaseVecDB` 抽象向量存储：`insert_batch`（批量、任务并发上限、重试次数、进度回调、独立 embedding 文本）与 `retrieve`（`top_k/fetch_k/rerank/metadata_filters`）（参考 `reference/AstrBot/astrbot/core/db/vec_db/base.py`）。

Aervox 已有 `IVectorSearchPort`，T-05 落地 `memory_embeddings` 独立表时可对照该接口补齐批量写入的进度回调与重试语义，避免长迁移任务不可观测。不涉及向量算法，仅参照接口形态。

落点：T-05 实现时对齐 Port 方法语义，属第二批。

### 3.8 PET-01 桌宠表现命令通道

Petra 以桥接模块把 AI 大脑与桌宠表现解耦：表现层只认 `speak/emote/gesture/move/react` 五类命令，外部进程/脚本经 `window.__ASTROBOT__` 或 DOM 自定义事件注入，内部以可退订 hook 分发（参考 `reference/Petra/src/bridges/astrobot.ts`）。

Aervox 的桌宠表情/动作同样应由 AI 响应驱动，而不应与聊天内容耦合。在消息/SSE 契约中预留表现指令字段（表情、动作、位移），表现层订阅执行，可避免"模型输出决定 UI 状态"的紧耦合。

落点：`packages/contracts` 预留 `emote/gesture` 指令字段，随第二批契约冻结；Web 陪伴头像与后续桌面桌宠共用同一指令集。

### 3.9 PET-02 结构化记忆条目字段

Petra 的 `MemoryEntry` 显式区分 `source: user_said | ai_inferred`，并以 `category`（identity/preference/habit/schedule/relationship/event/other）、`keywords`、`importance` 三级、`lastUsedAt` 组织条目（参考 `reference/Petra/src/assistant/AssistantClient.ts`）。

这与 Aervox "模型推断只能作为候选"约束同构：`user_said` 可直接置信，`ai_inferred` 默认降入候选（对照 T-04 的 `verificationStatus=unverified`）。`category` + `keywords` 便于记忆树投影与检索归类，`lastUsedAt` 支撑召回窗口淘汰。

落点：记忆 schema 演进时对照该字段集，属第二批；schema 已批准部分按[变更控制](../reference/REQUIREMENTS_TRACEABILITY.md#11-变更控制)处理。

## 4. B 类：值得借鉴（本阶段不落地）

### 4.1 T-06 数据库迁移服务

BaiShou-Next 用迁移 journal（`_journal.json`）+ 启动时旧库列补齐（`AGENT_DB_COLUMN_PATCHES`）管理 SQLite 演进（参考 `reference/baishou-next/packages/repositories/src/migration.service.ts`）。Aervox 目前仅 `CREATE TABLE IF NOT EXISTS`，表结构变更靠手动迁移，是已知痛点。

该思路已部分落地为迁移 journal；CR-030 的破坏性去租户化不复用原地补列模式，而是借鉴“显式状态 + 可重入”，在备份后构建 staging 新库并原子换库。

### 4.2 T-07 桌面 preload 按域划分 IPC

BaiShou-Next 在 preload 通过 contextBridge 暴露按域拆分的 `settings.api`/`diary.api`/`sync.api` 等 API，主进程统一 `ipcMain.handle('域:动作')` 模式，长任务用事件推送进度（参考 `reference/baishou-next/apps/desktop/src/preload/index.ts` 及 `ipc/` 目录）。Aervox 桌面端 preload 目前单文件入口，功能扩展时采用该模式即可，无需提前重构。

### 4.3 T-08 桌宠角色设定文档化

BaiShou-Next 将桌宠人设独立成文档（`Latte/角色設定.md` 与多语言 profile，含核心概念、外形、提示词边界）。Aervox 桌宠 IP 与多人格模板（CAP-019）可复用此组织方式，把角色提示词与识别边界文档化、版本化，并纳入评审与冻结流程维护。

### 4.4 T-09 Git 作为数据版本/同步层

BaiShou-Next 用 git 提交作为数据版本历史：`git log` 分页历史、按 commit 回滚文件、三向合并（参考 `reference/baishou-next/packages/core/src/sync/`）。PRD §15.2 决策 4 承认本地优先是后续选项；若进入该阶段，git 方案比自建版本表省一个数量级的工程量。

### 4.5 T-10 Token 用量分账

BaiShou-Next 将流式返回的 token usage 拆分为非缓存/缓存读/缓存写三类用于计费（参考 `reference/baishou-next/packages/ai/src/agent/token-usage.util.ts`）。Aervox 的 `ModelRun` 埋点可补充该分类，用于成本核算与 AI 质量回看。

### 4.6 AST-03 人设字段化与解析链

AstrBot 将人设字段化为 `Personality`（prompt/开场白/语气模仿对话/工具/技能/错误兜底语），`PersonaManager` 按"平台→会话→配置"逐级解析生效人设并始终有默认兜底（参考 `reference/AstrBot/astrbot/core/persona_mgr.py`）。

Aervox 桌宠 IP 与多人格模板（CAP-019）可借鉴"字段化人格 + 解析链 + 默认兜底"形态；文档化组织方式见 T-08，运行时接入随 CAP-019 立项。

### 4.7 AST-04 插件元数据与工具配置门控

AstrBot 的 `StarMetadata`（名称/作者/版本/仓库/激活态/平台声明/依赖版本范围/i18n 文案/注册页面元数据）与内置工具注册表按配置条件门控工具（`equals/in/truthy/custom` 等条件）（参考 `reference/AstrBot/astrbot/core/star/star.py`、`astrbot/core/tools/registry.py`）。

与 T-04 的 ToolRegistry 形成 TS/Python 双参照：安装态与激活态分离、按声明过滤可用性。可作 CAP-020 插件权限模型的第二参照，落地时以 Aervox 自身 contract 为准，不照搬元数据字段。

### 4.8 AST-05 Pipeline Stage 与迁移完成标记

AstrBot 以 `STAGES_ORDER` 显式声明消息处理阶段顺序（唤醒→白名单→会话→限流→安全→预处理→处理→装饰→发送），Stage 支持短路语义（返回 None 即中止）；数据库迁移以"旧库文件存在 + preference 标记"双条件判定幂等完成，迁移成功后才写入 `migration_done_v4` 标记（参考 `reference/AstrBot/astrbot/core/pipeline/stage.py`、`stage_order.py`、`astrbot/core/db/migration/helper.py`）。

前者对照 Aervox API 中间件/Worker Outbox 管线的后续演进（中间件重构期不动路由结构）；后者与 T-06 同领域，借鉴"旧库检测 + 完成标记"的幂等手法，避免重复迁移。

### 4.9 PET-03 自主行为引擎参数化

Petra 把漫游行为参数化为三档活动频率（`ACTIVITY_LEVELS`：休息时长/再歇概率/移动半径/闲逛速度），叠加鼠标躲避、逗猫棒、待机沉边等状态（参考 `reference/Petra/src/autonomous/BehaviorEngine.ts`）。

Aervox MVP 是 Web 工作台，不含系统级桌面宠物；进入桌面端角色行为阶段（随 T-07）时，可借鉴"活动频率分档 + 行为参数集中声明"的自研形态，不做原生 mover 线程。

### 4.10 PET-04 表现驱动数据对象与视图接口分离

Petra 把音频/行为/输入状态统一成 `PetDriver` 数据对象（低频/中频/高频能量、节拍、BPM、光标偏移、拖拽等标量），渲染视图只实现 `PetView` 接口（playAction/stopAction/setScale/attachTo/unmount 等），引擎不依赖具体渲染实现（参考 `reference/Petra/src/live2d/PetDriver.ts`）。

Aervox 桌宠表现层可借鉴"驱动数据对象 + 视图接口"的分离：表现状态由行为/音频/输入合成为纯数据，Vue 组件或后续 Canvas 渲染只消费该对象；不引入 pixi/Live2D 渲染栈。

### 4.11 PET-05 AI 工具只读白名单与使用原则

Petra 的系统工具 `run_shell` 声明只读命令白名单（ipconfig/dir/ping 等），打开软件用专用 `launch_application` 工具而非任意命令，提示词强制"失败如实转述、不要猜路径"（参考 `reference/Petra/src/assistant/AssistantClient.ts`）。

Aervox 工具链安全规范可对照该白名单粒度：把"查询类命令"与"应用启动"拆成不同工具、收紧模型自由发挥空间。具体规则以 [AI 质量与安全规范](../reference/AI_QUALITY_SAFETY.md) 为准。

### 4.12 Skill 能力（Anthropic Skills 渐进式披露 + Neo 生命周期）

AstrBot v4.13+ 支持 Anthropic Skills：技能以 `SKILL.md`（frontmatter `name/description`）+ `scripts/`/`assets/` 组织，系统提示词仅注入名称与描述（渐进式披露），模型决定使用某技能时才读取全文（参考 `reference/AstrBot/astrbot/core/skills/skill_manager.py`）；进阶形态是 AI 自主创作技能的生命周期 payload → candidate → evaluate → promote（canary/stable）→ release + sync（参考 `reference/AstrBot/astrbot/core/tools/computer_tools/shipyard_neo/neo_skills.py`）。

Aervox 自研落地（AGPLv3 仅借鉴设计，不复制源码）：

- **注册表 + 内容双轨**：`skill_registrations` 表为真源（source/active/readonly/gating），SKILL.md 内容落盘 `data/skills/<name>/`；
- **来源三态**：`local`（zip 安装，可管理）/ `plugin`（插件声明，只读、生命周期归插件）/ `ai_authored`（Neo 生命周期晋升后落盘）；
- **Neo 生命周期适配**：AstrBot 沙盒「执行证据」适配为 Aervox 业务对象（turns / memory_records / learning_goals），stable + syncToLocal 时把 `payload.skill_markdown` 落盘并注册；
- **安全边界**：技能为只读指令包，可执行内容不经技能自动运行，必须经 `tool_registrations` 白名单 + PET-05 授权。

> 统一说明：远端并入的 persona 模块曾自带租户级 `/v1/skills*` 路由（工作区技能 import/export），
> 与本节系统级实现同路径冲突。合并时以本节实现为准：`/v1/skills*` 由
> `apps/api/src/modules/ecosystem/skills/` 统一接管，persona 模块移除其 `/v1/skills*` 路由，
> 保留 Persona/MCP/Voice 路由；persona bundle 导入仍向其 `skills` 仓储写入工作区技能。

## 5. C 类：暂不采用

| 设计 | 原因 |
|---|---|
| 多工作区 vault 双库模型与 registry/影子索引 | 与 CR-030 本地单用户模型冲突，仅保留“注册表 + 可重建索引”的思想启示 |
| Expo 移动端、tab/设置路由、WebView 内嵌日记编辑器 | ADR-015 已定 Capacitor + Web 复用路线，栈不同不迁移 |
| 云同步、局域网快传、定价、更新器、Windows 安装器 | 商业化与桌面基建能力，不在当前 P0/P1 路线内 |
| 事件驱动的 agent-part 前端 UI（React 专属 hooks） | Aervox 前端为 Vue 单栈（ADR-015），不跨栈移植组件 |
| IM 多平台适配器、群聊白名单、限流与内容安全 stage | Aervox 是 1v1 伴学场景，无 IM 群聊治理需求，不引入该链路 |
| Dashboard Asgi 面板形态、zip 更新器与 FUNDING 商业组件 | 与 T-13 同：运维面板与商业化能力不在当前 P0/P1 路线 |
| Tauri 2 桌面栈与 Windows 原生层（mover 线程、WASAPI、回收站、开机自启） | Aervox 桌面端为 Electron（CR-002）且首发 Web，栈不同不迁移 |
| PSD/Live2D 渲染栈（pixi-live2d-display、ag-psd、Anime2.5DRig）与更新器 | 角色资产管线待桌面端阶段另行评估；更新器与 T-13 同理由 |

<a id="6-落地顺序建议"></a>

## 6. 历史批次与来源追溯

以下是原评估按“见效快、不改结构、先服务现有痛点”形成的四批快照，用于解释来源映射中的批次编号。保留当时的判断，不将其视为当前执行顺序；候选改动须核对现行契约和源码后进入根 [plan.md](../../plan.md)。

1. **第一批（低风险，独立可排）**：T-01 busy 重试 → AST-01 会话级写锁 → T-02 混合检索。三者都是 `packages/repositories`/写路径内收口改动，直接解除多进程锁风险并打通记忆召回首链路。
2. **第二批（需要契约与 Worker 配合）**：T-03 压缩标记 → T-05 embedding 独立表（对照 AST-02 对齐 Port 语义）→ PET-01 表现指令字段、PET-02 记忆条目字段（随契约冻结对照）。涉及记忆溯源与运行时代价，先冻结 `packages/contracts` 相关 schema 再实现。
3. **第三批（随 CAP 排期）**：T-04 工具系统随 CAP-020 立项（对照 AST-04 元数据模型，安全对照 PET-05 白名单）；AST-03 人设解析链随 CAP-019 立项（对照 T-08 文档化）；PET-03 自主行为、PET-04 表现驱动抽象随桌面端功能扩展引入；T-06～T-10、AST-05 按对应功能阶段引入。
4. **第四批（运行时接线）**：为第一批至第三批已落地的契约/存储接通真实调用链——T-04 tools 运行时与 `/v1/tools` 路由、T-03/T-05 Worker 异步消费、PET-01 前端 emote 消费、CAP-020 插件运行时、T-06 迁移服务与 AST-05 完成标记、T-09 快照与 T-10 分账（详见 §6.1）。

<a id="61-落地登记唯一真源"></a>

### 6.1 来源映射与历史证据

实现状态和验证结果只由[追踪基线 §4.2](../reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)维护；本表保留参考设计编号与历史实现记录的映射，供来源追溯，不另行推进完成状态。新增实现仍须在追踪基线注明 `T-*`、`AST-*`、`PET-*`、`DSH-01`、`PI-01` 等来源并遵循许可证要求。下表中的判定、批次、位置和说明均按原记录理解，`目标已文档化` 不等于 `运行时已接入`，历史测试也不等于当前发布证明。

| 编号 | 历史判定 | 历史批次 | 记录日期 | 历史实现位置 | 当时说明 |
|---|---|---|---|---|---|
| `DSH-01` | B（目标已文档化） | Agent Loop 阶段 0 前 | 2026-08-28 | `docs/reference/agent-harness-loop.md`（AVX-HAR-001）、`docs/reference/changes/CR-012-agent-harness-loop.md` | 已固化 Turn/Step、typed event、工具管线和 Adapter 边界；DSH 运行时尚未接入，不能标记为已实现 |
| `PI-01` | B（目标已文档化） | Agent Loop 阶段 0 前 | 2026-08-28 | `docs/reference/agent-harness-loop.md`（AVX-HAR-001）、`docs/reference/changes/CR-012-agent-harness-loop.md` | 已固化 outer/inner loop、Inbox、lease/fencing 和进程外 Host 约束；pi 运行时尚未接入，不能标记为已实现 |
| `GPH-01` | 设计借鉴，规则原型 | 当前复评第一步 | 2026-09-25 | `packages/repositories/src/temporal-fact-policy.ts` | 参考 Graphiti 的事实有效时间与来源时间分离；仅实现已确认事实的单步判定，未接入数据库或召回 |
| `GPH-02` | 设计借鉴，投影实验 | 当前复评第二步 | 2026-09-26 | `packages/schema/src/temporal-facts.ts`、`packages/repositories/src/schema/ddl/temporal-facts.ts`、`packages/repositories/src/temporal-fact-projection.ts` | 承接 GPH-01 的单步判定，落实 SQLite 侧时态事实投影：事务内新增事实、关闭旧有效区间或追加证据；支持按时点查询与证据追溯，来源删除、来源修订或记忆失效后查询即时屏蔽；实验性质，不接入生产写入与召回 |
| T-03 | A | 第二批 | 2026-08-26 | `packages/schema/src/memory-compaction.ts`、`repositories/sqlite/memory-compaction-repository.ts` | `memory_compaction_markers` 表 + 幂等仓储 |
| T-05 | A | 第二批 | 2026-08-26 | `packages/schema/src/embeddings.ts`、`repositories/sqlite/memory-embedding-repository.ts` | `memory_embeddings` 独立表 + 批量/重试/余弦检索（对照 AST-02） |
| PET-01 | A | 第二批 | 2026-08-26 | `packages/contracts/src/schemas.ts`（`petCommandSchema`/`emoteEventDataSchema`） | SSE 表现指令契约预留 |
| PET-02 | A | 第二批 | 2026-08-26 | `packages/schema/src/memories.ts`、`repositories/types.ts` | 记忆条目字段 `source`/`category`/`keywordsJson`/`lastUsedAt` |
| T-04 | A | 第三批 | 2026-08-26 | `packages/contracts/src/schemas.ts`（工具注册表契约）、`packages/schema/src/tool-registry.ts`、`repositories/sqlite/tool-registry-repository.ts` | 工具注册表 + 主动记忆契约 + 幂等/过滤/门控导出 |
| AST-04 | B→已落地雏形 | 第三批 | 2026-08-26 | `packages/contracts/src/schemas.ts`（`pluginMetadataSchema`、`toolGatingConditionSchema`）、`packages/schema/src/tool-registry.ts` | 插件元数据字段 + 工具条件门控（CAP-020 雏形） |
| PET-05 | B→已落地雏形 | 第三批 | 2026-08-26 | `packages/contracts/src/schemas.ts`（`toolSafetyLevelSchema`） | 工具安全级别（read_only 白名单）有线 |
| T-08 | B→已落地 | 第三批 | 2026-08-26 | `docs/explanation/persona-organization.md`（AVX-EXPL-003） | 桌宠角色设定独立成文档（核心概念/外形/提示词边界/识别边界），按人设目录版本化（CAP-019） |
| T-04 | A（运行时接线） | 第四批 | 2026-08-26 | `apps/api/src/modules/ecosystem/tools/`（`runtime.ts`/`memory-store-tool.ts`/`mcp.ts`/`routes.ts`） | MemoryStoreTool 运行时 + ToolRuntime + `/v1/tools` 路由 + MCP 形态 listTools/callTool；PET-05 在调用侧强制授权 |
| T-03 | A（消费接线） | 第四批 | 2026-08-26 | `apps/worker/src/compaction-marker.ts` | 消费 outbox `memory.compaction.requested` 事件异步落库压缩标记 + 审计（先写后投递） |
| T-05 | A（迁移接线） | 第四批 | 2026-08-26 | `apps/worker/src/embedding-migration.ts` | 扫描缺向量记忆 → 批量生成 → insertBatch；可中止 + 进度回调；provider 未注入诚实跳过 |
| T-06 | B→已落地 | 第四批 | 2026-08-26 | `packages/repositories/src/migration/migration-service.ts` | 迁移 journal（`_migration_journal`）+ 幂等重入 + 旧库列补齐纳入迁移步骤 |
| AST-05 | B→已落地 | 第四批 | 2026-08-26 | `packages/repositories/src/migration/migration-service.ts`（完成标记；Worker 任务执行已收敛为独立任务节拍器调度） | `isMigrationCompleted` 双条件幂等；流水线执行已由 Worker 独立节拍器调度接管 |
| T-09 | B→已落地 | 第四批 | 2026-08-26 | `packages/repositories/src/sync/git-snapshot.ts` | 行级快照导出/恢复 + 快照命名约定；git 提交/回滚由宿主（CLI/桌面）按需调用 |
| T-10 | B→已落地 | 第四批 | 2026-08-26 | `packages/repositories/src/token-usage.ts` | Token 用量分账（非缓存/缓存读/缓存写），兼容 OpenAI/旧形态 |
| PET-01 | A（前端消费） | 第四批 | 2026-08-26 | `packages/api-client/src/transport.ts`、`desktop-transport.ts`、`useAervoxTurn.ts`、`packages/ui/src/components/PetHero.vue` | emote 事件透传 + `PetHero` activeEmote/activeGesture 消费 |
| PET-01 | A（Live2D 表现接线） | 第四批 | 2026-08-26 | `packages/ui/src/live2d/{model,controller}.ts`、`packages/ui/src/components/Live2DPet.vue`、`apps/desktop/src/renderer/src/components/PetWindow.vue` | model3.json 兼容加载、动作/表情 Enum 与 API、SSE 表现命令映射；Web 工作台显示 Live2D，Electron 主工作台隐藏左侧区域，独立桌宠窗口保留 Live2D |
| AST-04 | B→已落地（运行时） | 第四批 | 2026-08-26 | `apps/api/src/modules/ecosystem/plugins/` | CAP-020 插件运行时：安装/启停/卸载 + 工具注册联动 + 权限授予/撤销/查询 |
| AST-08 | B→已落地 | 第六批 | 2026-08-26 | `packages/contracts/src/plugin-config-schemas.ts`、`packages/schema/src/plugin-config.ts`、`apps/api/src/modules/ecosystem/plugins/config-*.ts` | 插件 Config Schema v1：声明式解析/默认值/校验/secret 状态/租户持久化/CAS（CR-006） |
| AST-09 | B→已落地 | 第六批 | 2026-08-26 | `apps/api/src/modules/ecosystem/plugins/bundle-store.ts`、`bridge-sdk.ts`、`packages/ui/src/components/plugin/` | 插件 Page：本地 Bundle 静态资源 + 沙箱 iframe + Host Bridge（config.read/write、notify、close） |
| Skill | B→已落地（契约+存储） | 第五批 | 2026-08-26 | `packages/contracts/src/schemas.ts`（Skill 契约）、`packages/schema/src/skills.ts`、`repositories/sqlite/skill-registry-repository.ts`、`skill-lifecycle-repository.ts` | `skill_registrations` + `skill_payloads`/`skill_candidates`/`skill_releases` 四表 + 幂等/门控导出/生命周期仓储 |
| Skill | B→已落地（管理 + 生命周期运行时） | 第五批 | 2026-08-26 | `apps/api/src/modules/ecosystem/skills/`（`zip.ts`/`skill-manager.ts`/`skill-prompt.ts`/`lifecycle.ts`/`routes.ts`/`skill-tools.ts`） | zip 安装（安全校验）+ 渐进式披露 prompt + Neo 生命周期（payload→candidate→evaluate→promote→rollback/sync）+ `aervox_skill_*` 工具（PET-05 安全级别） |
| Skill | B→已落地（插件联动） | 第五批 | 2026-08-26 | `apps/api/src/modules/ecosystem/plugins/service.ts` | 插件声明技能只读注册（source=plugin/readonly/pluginId）+ 启停/卸载联动 |

<a id="62-待接线缺口现状如实记录"></a>

### 6.2 历史接线缺口

以下保留原第四批评估留下的接线缺口，不作为持续维护的待办或当前能力结论。后续实现可能已改变这些边界；采纳前须核对[追踪基线](../reference/REQUIREMENTS_TRACEABILITY.md)与当前源码，再由根 [plan.md](../../plan.md)记录仍需处理的工作。

| 缺口 | 关联设计 | 说明 |
|---|---|---|
| 真实向量库接入 | T-05 | 当前为 SQLite 行扫描 + JS 余弦兜底，未接原生向量扩展（如 `sqlite-vec`）；embedding provider（真实服务）需在生产注入 |
| 压缩摘要由模型生成 | T-03 | Worker 已消费事件落库；`summaryText` 的生成仍待接入摘要模型 |
| AST-03 人设解析链 | AST-03 | 文档组织已就绪（AVX-EXPL-003），运行时解析链随 CAP-019 立项 |
| PET-03 / PET-04 桌宠自主行为与表现驱动抽象 | PET-03/04 | 前端已消费 emote 指令，完整行为引擎与 PetDriver 抽象随桌面端功能扩展引入 |
| T-07 桌面 preload 分域迁移覆盖 | T-07 | 已提供按域 API 结构（`preload/domains/`）并兼容旧通道；桌面端全面迁移到新域通道待功能扩展时推进 |
| Skill 渐进式披露注入 AI 对话运行时 | Skill | `/v1/skills/prompt` 已提供清单；真实对话构建时注入系统提示词待 AI 运行时（Turn 链路）接线 |

## 7. 长期记忆、人格与主动行为参考项目复评（2026-09-25）

本节按当前源码重新评估 Letta / Letta Code、Graphiti 与 Generative Agents。三者都采用 Apache-2.0，但用途不同：Letta Code 是持续演进的状态化 Agent Harness，Graphiti 是需要独立图数据库与模型服务的时态知识图谱框架，Generative Agents 则是 2023 年论文配套的研究模拟器。许可证允许借鉴或复用不等于适合直接引入；若后续复制代码，仍须按 PRD §15.1 记录来源、许可证与修改。

### 7.1 当前基线与总判断

Aervox 已经越过“只把记忆写进库”的阶段：默认原生 Loop 的新 Turn 会加载同一会话历史，并尝试通过 FTS + 向量 RRF 召回普通长期记忆，以不可信事实上下文注入；激活人格的名称、提示词和技能白名单会进入执行上下文；主动画像只在有效授权下加载，并强制使用本机模型端点。记忆记录还具备修订、证据、事件、校验状态与独立 embedding 表。这意味着默认原生 Loop 的基础召回接线已闭合；DSH 驱动分支、召回失败或资格过滤并不保证每轮都有记忆进入模型。

当前更实质的缺口是：召回策略仍以当前查询为主，没有一套可由 Agent 维护、稳定占据上下文的身份/工作记忆；普通记忆没有事实有效区间与自动失效旧事实的语义；现有 `MemoryRevision`/`MemoryEvidence` 能追溯版本和证据，但尚未形成“事件 → 实体/关系事实 → 有效期 → 查询”的时态闭环；人格、记忆、计划和主动动作之间也没有可验证的“经历改变后续行为”反思闭环。

| 项目 | 是否继续学习 | 优先级 | 对 Aervox 最有价值的部分 | 不直接照搬 |
|---|---|---|---|---|
| Letta / Letta Code | 是，做 Harness 级对照实验 | P1 | 每轮编译进上下文的可编辑 memory blocks；不可变对话召回与可变身份/规则的分层；git 追踪的 MemFS；跨会话、跨机器保持同一 Agent 身份 | 不接管 Aervox 的 SQLite 真源、权限、人格审批或 Agent Loop；不把任意自改系统提示词直接用于生产人格 |
| Graphiti | 是，三者中最高优先级 | P0 设计验证 | 双时间事实、旧事实失效但保留历史、episode 证据链、增量入图、语义 + BM25 + 图遍历混合检索 | 当前不引入 Neo4j/FalkorDB/Python 服务；不把模型抽取结果绕过 `verificationStatus` 和用户确认直接当真 |
| Generative Agents | 是，只学习实验方法和闭环 | P2 | 记忆的相关性/新近性/重要性选择；重要度累计触发反思；日计划、反应与重规划；用消融验证记忆/反思/计划是否真的改变行为 | 不复制 Smallville 游戏循环、提示词和逐步模拟存储；不把“看起来像人”当成正确性或产品安全指标 |

### 7.2 Letta / Letta Code：从“召回记录”学习“编译 Agent 状态”

Letta Code 把同一 Agent 的上下文分成三层：消息历史自动进入不可变 recall memory；较旧消息由摘要和检索补回；可编辑的 memory blocks 作为系统提示词片段进入上下文，外部记忆则留在 MemFS 中按需发现。官方说明还明确指出，memory block 的修改只会在后续重新编译时影响行为，MemFS 通过 git 保存演化历史。由此可借鉴的不是另一个向量库，而是 **Context Compiler** 的明确契约：本轮必须知道哪些身份规则常驻、哪些历史按需召回、每个片段由谁修改、何时生效、如何回滚。[Letta Code 的上下文架构与 memory blocks](https://github.com/letta-ai/letta-code/blob/main/src/agent/prompts/letta.md)、[Letta memory block 官方文档](https://docs.letta.com/tutorials/attaching-detaching-blocks/)

对 Aervox 的下一步建议是做一个窄原型，而非引入 Letta 运行时：在现有 `ContextManifest` 上补 `contextSlot`（如 `identity`、`user_confirmed`、`active_goal`、`recalled`）、`owner`、`effectiveRevisionId`、`selectionReason` 和 token 预算；人格只能由已批准修订生成 `identity` 槽，用户确认的记忆才能进入 `user_confirmed` 槽，普通检索结果仍放 `recalled` 槽。以同一测试会话跨 20 个 Turn 验证身份稳定、用户纠正后的下一轮生效和修订回滚。Letta Code 已提供 CLI、桌面端、浏览器、消息渠道与跨机器 Agent state，适合作为活跃产品级 Harness 参照；但其自修改提示词和通用编码 Agent 权限模型与 Aervox 的受控陪伴/学习产品边界不同。[Letta Code 官方仓库与运行形态](https://github.com/letta-ai/letta-code)

### 7.3 Graphiti：重点补“事实何时成立”的语义

Graphiti 的基本对象是 episode、entity 和带有效窗口的 fact/relationship：原始输入保留为 episode，派生事实可追溯到 episode；新输入增量合并，发生冲突时旧事实被标记失效而非删除；检索同时使用语义、BM25 与图遍历，并可按图距离重排。官方将其描述为显式双时间模型，能区分数据进入系统的时间和事实在现实中成立的时间。[Graphiti 官方仓库：时态事实、来源与增量更新](https://github.com/getzep/graphiti)、[Graphiti quickstart：episode 与混合检索](https://github.com/getzep/graphiti/tree/main/examples/quickstart)

Aervox 已有 `SourceArtifact.occurredAt/ingestedAt`、`MemoryRevision`、`MemoryEvidence` 和记忆边证据，具备实现基础，但普通 `MemoryRecord`/revision 还没有 `validFrom`、`validTo`、`invalidatedByRevisionId` 与基于同一 subject/predicate 的冲突处理。建议先在 SQLite 内做小型的 **Temporal Fact Projection**：从已确认记忆投影出 `subject/predicate/object`，保留 `occurredAt` 与 `ingestedAt`，新事实只关闭旧事实有效区间；查询默认取当前有效事实，也能回看指定时间。用“以前住北京，现在住上海”“过去喜欢咖啡，现在戒咖啡”这类数据验证，而不是先部署图数据库。

Graphiti 当前是活跃的开源框架，支持 Neo4j、FalkorDB、Amazon Neptune，并要求 Python 3.10+ 和结构化输出能力较好的模型；其官方也明确区分了 Graphiti 自托管核心与具备规模化治理能力的商业 Zep。对 Aervox 而言，它适合作为数据语义和测试用例来源，不适合作为现阶段的直接运行时依赖：引入 Python 服务、图数据库和额外 embedding/LLM 调用会破坏当前 TypeScript 模块化单体与 SQLite 本地优先边界。[Graphiti 依赖、后端与产品边界](https://github.com/getzep/graphiti#installation)

### 7.4 Generative Agents：学习行为闭环与消融，不学习生产架构

Generative Agents 把完整经历写入 memory stream，再按相关性、新近性和重要性检索少量记录；重要度累积触发更高层反思，反思又作为新记忆参与后续检索；Agent 先形成日计划，再随观察结果反应和重规划。论文的关键价值还包括消融实验：移除观察、计划或反思都会降低人类评审中的行为可信度。[Generative Agents 原始论文](https://arxiv.org/abs/2304.03442)、[论文配套官方仓库](https://github.com/joonspk-research/generative_agents)

这套机制可用于验证 Aervox 的“人格经历会影响行为”是否成立。建议构造固定事件脚本和可重复模型桩，比较四组：无长期记忆、仅召回、召回 + 反思、召回 + 反思 + 计划；指标使用人格一致性、事实正确率、计划完成率、无依据推断率和主动打扰率，而非只评“像不像真人”。反思产物必须有源记忆 ID、提示词/模型版本、置信度和用户确认状态，不能自动覆盖批准人格。

该仓库是论文演示实现：README 指定 Python 3.9.12，运行时遇到 API 限流可能挂起并建议频繁保存，仓库的核心场景是 25 个角色的 Smallville 模拟。因此它适合读论文、看检索/反思/计划如何闭环和复现消融，不应作为 Aervox 的生产工程模板。[官方仓库的运行与限制说明](https://github.com/joonspk-research/generative_agents#setting-up-the-environment)

### 7.5 可验证的学习顺序

1. **先做 Graphiti 语义原型**：不用图数据库，在 SQLite 增加时态事实投影实验，验收“当前事实”“历史事实”“证据来源”“矛盾更新”四类查询。
2. **再做 Letta 上下文槽实验**：把人格、确认记忆、当前目标、按需召回拆成可审计槽位，使用 `ContextManifest` 比较每轮实际输入和 token 占用。
3. **最后做 Generative Agents 消融**：在已有主动智能和人格链路上增加受控反思候选与计划反馈，证明它确实改善后续行为，再决定是否产品化。

这三项先以测试夹具和窄原型验证；若需进入当前执行队列，再按治理规则更新 `plan.md`。落地后按 §6.1 登记参考来源编号与实现位置；不能仅因参考项目具备某功能，就把 Aervox 的同名表或 UI 视为已经获得相同行为。

第一笔窄切片已落实 `GPH-01`：纯判定模块只接受已确认事实，分别保存事实生效时间和来源入库时间；新事实关闭旧区间，同值只追加证据决策，同刻矛盾和迟到输入要求复核。它尚未持久化，也不改变当前召回资格；SQLite 投影、删除传播和时点查询仍需后续契约与实现。

<a id="upstream-20260929"></a>

## 8. DSH、pi、AstrBot 上游更新复评（2026-09-29）

### 8.1 更新范围与证据边界

本次按用户要求，将三个参考子模块更新到**抓取时上游默认分支的固定提交**，不是统一选择最大版本标签。思隅核验基线为 `21953cb`（PR #231 已合入）；本次只维护参考基线、DSH 准入常量与研究文档。下文建议不代表已实施，也不改变 CR-056、ADR-020 或 CAP 的交付状态。交付见[追踪基线 §4.2](../reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记)，队列见 [ITER-030](../../plan.md#iter-030)。

| 项目 | 旧固定版本 → 新固定版本 | 默认分支与本次提交日期 | 增量与版本含义 |
|---|---|---|---|
| DSH | `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` → `639ed015397290b3745d163aafe02ffee4aa3f84` | `master`；2026-09-29 17:21 +08 | 7,323 个提交；`0.1.1-rc.2` → `0.2.0-rc.2`，新 SHA 精确对应 `dsh-v0.2.0-rc.2`；MIT |
| pi | `c49906ec77788625aacbdc53ebca6fbe65bd20f5` → `5257d0d5f3ab7d42550804f32c67a77b49f485d4` | `main`；2026-09-29 14:10 +02 | 812 个提交；包版本 `0.84.2` → `0.87.1`，新 SHA 包含 `v0.87.1` 标签后的未发布变化；MIT |
| AstrBot | `4d877c9919e58008f6f2cf4b19e18f9c48e4338f` → `b53999e959cfc3b71d7b74713ddee837be843fcb` | `master`；2026-09-29 11:19 +08 | 154 个提交；版本文件 `4.27.4` → `4.28.1`，不是 `v4.28.2`；AGPL-3.0-or-later |

三个旧 SHA 均为新 SHA 的祖先，更新前后子模块工作树干净，旧版本另有本地备份引用。提交数由 `git rev-list --count old..new` 得出，包含合并分支历史，不能当作功能数量。完整区间：[DSH 差分](https://github.com/deepseek-ai/deepseek-harness/compare/b150a551b8d465e31e418e1b2eaf5e79bbb7d28e...639ed015397290b3745d163aafe02ffee4aa3f84)、[pi 差分](https://github.com/earendil-works/pi/compare/c49906ec77788625aacbdc53ebca6fbe65bd20f5...5257d0d5f3ab7d42550804f32c67a77b49f485d4)、[AstrBot 差分](https://github.com/AstrBotDevs/AstrBot/compare/4d877c9919e58008f6f2cf4b19e18f9c48e4338f...b53999e959cfc3b71d7b74713ddee837be843fcb)。

版本细节：pi 的 `v0.87.1` 指向 `f07218c4d4bbc12bef056a7058c3dd49dfe41abe`；AstrBot 的 `v4.28.2` 指向 `3c7adafa1397e182d60b1016bf88759265113c8a`，与本次 `master` 分叉，左右独有提交为 66/3。AstrBot 在 `master` 上升版后又撤回版本号。因此应以固定 SHA 描述本次更新，不能用标签大小推断稳定性或包含关系。DSH 的发布资产、三个项目的完整上游构建与测试、真实模型、各操作系统沙箱均未在本次运行；下文上游测试链接表示**已阅读的回归设计**。

整体判断：DSH 的主要价值是会话恢复、宿主交互和桌面承载；pi 的主要价值是副作用控制、模型上下文投影和扩展边界；AstrBot 的主要价值是插件运维、后台执行一致性及真实权限落实。思隅已具备 Port、ExecutionPipeline、审批 SPI、代际生命周期和轻量 Headless 内核，继续搭同名框架的收益低于补齐生产路径与故障验收。

### 8.2 DSH：从循环框架走向可恢复的宿主产品

**会话恢复的关键是承认“不知道有没有执行成功”。** 本次 Session writer 从格式 0 演进到 4，Inbox 成为可重放投影，格式迁移保留原文件；工具调度失败时，保留已提交成功结果，将未开始调用记为 `TOOL_NOT_STARTED`，已开始但结果不明记为 `TOOL_OUTCOME_UNKNOWN`，补齐调用/结果配对后关闭 Step/Turn。对思隅最有价值的是这套分类及崩溃夹具：重启后不能把“结果未知”当成“未执行”而重做文件修改或设备动作。沿用 SQLite、工具账本和 fencing，映射 ITER-010/011/029，不迁移到 DSH JSONL。

证据：[失败阶段与工具配对测试](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent-loop/tests/tool-calls.spec.ts#L635)、[迁移保留原文件测试](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/session/session-persistence-jsonl/tests/v3-restart-migration.spec.ts#L55)。

**动态工具变化也要成为请求证据。** 旧版已有工具注册与投影；本次强化工具增删、系统提示变化、请求冻结和恢复重建，支持相应模型路由的 in-history 更新并保留历史。思隅已有 ContextManifest 和动态 ToolProvider，但当前[执行器](../../packages/core/src/executor.ts)只在首 Step 保存一份消息清单，不能证明后续每次请求用了哪版工具、权限或模型。值得在 ITER-007 中记录每次最终请求的模型、工具 Schema、提示版本及授权修订；展示给模型与真正执行时分别验证，撤权不能只从界面移除。

证据：[动态工具与历史测试](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent-loop/tests/tool-updates.spec.ts#L49)。

**限时提问能让陪伴更自然。** 新增可选的限时问题路径，前台等待窗口结束后返回 `pending`，原问题仍可回答，迟到答案按 `callId` 接回后续输入；旧阻塞工具保留。思隅可以表现为“你先选明天的复习时段，我先整理今天错题”，避免桌宠一直停在等待状态。已有 UserQuestionPort 与审批 SPI，新增价值是待答问题的持久关联、重连和晚答语义；应作为 ITER-010/013 的契约差量评审。问题超时不是用户回答，更不是写操作授权。

证据：[限时等待与客户端接管](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/interaction/user-questions/src/timed-wait.ts#L4)、[保留旧路径与新路径 opt-in 测试](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/interaction/tool-ask-user/tests/tool-ask-user.spec.ts#L102)。

**提醒从活跃 Agent 定时器转为 Host 任务。** Goal/Schedule、显式时区和 Every 只补最新并非本次新增；本次将任务移至 Host 存储、支持冷会话唤醒，扩展 daily/weekly/cron 及其 DST 规则，并新增投递历史和 CAS 更新。适合思隅复习提醒的“离线回来合并通知”和“解释为何此刻提醒”。但 DSH 明确不保证 exactly-once：Inbox flush 与任务写入非原子，崩溃可重复，失败没有自动重试定时器，旧提醒也不自动迁移。投递到 Inbox 不等于模型完成任务。思隅应保留 SQLite/Outbox，用业务发生次序键、幂等和通知预算实现自己的语义。

证据：[Schedule 语义与限制](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/schedule/schedule/README.md#L59)、[投递不等于执行测试](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/schedule/schedule/tests/delivery.spec.ts#L10)。

**更强的 PTC 和生命周期屏障值得借鉴，整套宿主不必搬入。** PTC/code-mode 旧版已有；本次受限 Node 进程为每次执行设置取消、截止、控制帧与输出上限，创建 Agent 也改为等待所有初始化监听器完成再接单。思隅可用这些测试补 ITER-029 的注册/释放竞态与 ITER-013 的停机收敛。新 Electron 应用复用共享 Web，与思隅双形态方向相近；应学习临时流帧关联持久提交、旧代际失效与共享数据模型，而非更换 Vue/Electron 架构。Team/Schedule 仍是可选实验能力，PTC 沙箱也有平台及网络/内存保证限制。

证据：[受限 PTC Provider](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/ptc-runtime/ptc-runtime-node/src/index.ts#L51)、[PTC 限制](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/ptc-runtime/ptc-runtime-node/README.md#L133)、[创建屏障测试](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/packages/core/agent-loop/tests/serial-listener-review.spec.ts#L82)、[桌面架构](https://github.com/deepseek-ai/deepseek-harness/blob/639ed015397290b3745d163aafe02ffee4aa3f84/apps/desktop/README.md#L7)。

### 8.3 pi：最值得学习的是控制边界和上下文保真

**先修正旧结论：当前有三条不同成熟度的路线。** CLI/SDK 仍由 `Agent + AgentSession + SessionManager` 装配；旧 AgentHarness 已真实实现 `prompt/resume/abort`，不能再笼统称 scaffold，但 `watchSession` 仍抛 `SliceNotImplemented`；新 `packages/durable` 的 Pico5 在收尾新增的 Package 15 中已实现首个无工具聊天回合：输入去重、生成响应、答案持久化及 SQLite 重开，并有重试、轮询和取消路径。但工具执行链、忙时 steer/follow-up Inbox 与完整产品 UI 仍未完成；当前 toolUse 直接作为答案结算。不能把这些路线拼成“pi 已经提供完整可替换持久内核”。CR-056 中旧 SHA 的历史判断保留，新复评以本节为准。

证据：[实际 lane 操作](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/agent/src/harness/runtime/lane.ts#L1133)、[未完成的 watchSession](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/agent/src/harness/runtime/harness.ts#L305)、[durable 阶段交接](https://github.com/earendil-works/pi/blob/5257d0d5f3ab7d42550804f32c67a77b49f485d4/packages/durable/docs/pico-v5-handoff.md#L10)。

收尾增量说明：首次抓取 `4df157433` 后，上游新增三笔提交，本次最终固定为 `5257d0d5`（共 812 笔）。除 Package 15 外，还增加 `defaultTools` 的 `+name/-name` 继承覆写和 MCP 工具参数显示。工具选择不等于权限，参数显示仍需思隅的脱敏投影。本节其余 `4df157433` 固定链接保留为本次区间中已审阅的证据，相关设计未被这三笔提交修改。

证据：[无工具回合与真实 SQLite 重开测试](https://github.com/earendil-works/pi/blob/5257d0d5f3ab7d42550804f32c67a77b49f485d4/packages/durable/test/harness-generation-recovery.test.ts#L269)、[尚未执行 toolUse 的明确分支](https://github.com/earendil-works/pi/blob/5257d0d5f3ab7d42550804f32c67a77b49f485d4/packages/durable/src/harness/generation.ts#L260)。

**取消必须先关闭新副作用准入。** 新 effect gate 把“同步拒绝新工具动作”和“取消记录持久化后向在途任务发信号”分开；不是在各处零散检查 `signal`。思隅已有 ControlContext、CAS/fencing、取消与账本，应把 ITER-029 的心跳失效窗口、提前 settled、装饰器信号遗漏收敛为同一组时序验收：关闭准入 → 取消持久化 → 结果/终态持久化 → 对外通知。内存 gate 不能替代跨进程租约；该 pi Harness 的 SQLite 后端不提供 lease/fence/heartbeat，写者所有权仍依赖受信 Host。

证据：[effect gate 实现](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/agent/src/harness/execution/effect-gate.ts#L31)、[取消提交前后测试](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/agent/test/harness/execution-primitives.test.ts#L25)。

**回合钩子需要明确哪些只是通知，哪些可以继续调度。** 本次新增 `prepareRequest`，用 `finishTurn` 替代 `shouldStopAfterTurn`；异常/取消仍通知钩子，但其返回值不能让失败回合继续运行。思隅已实现 ExecutionPipeline 和插件生命周期中间件，下一步是把失败、危机、取消、skipped 路径上的 before/after 语义写清并测试，正对应 ITER-029。工具参数被流式截断或缺终止事件时，pi 还拒绝将半成品升级为可执行工具调用，适合补 Provider 边界的坏响应夹具。

证据：[finishTurn 顺序与硬退出](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/agent/test/agent-loop.test.ts#L1067)、[不完整工具参数拒绝测试](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/ai/test/openai-responses-terminal-event.test.ts#L264)。

**模型上下文是历史的投影，压缩不该伪造摘要。** `context_edit` 通过追加记录控制模型可见内容，保留原聊天、计费与 UI 历史；每次请求从权威投影重建。压缩按工具调用/结果组选择边界，超窗口只允许一次压缩重试。思隅当前[规则压缩](../../packages/core/src/context-builder.ts)仅在 `AERVOX_LOOP_COMPACTION=rule` 时启用，默认关闭；启用后在超过 50 条消息时保留首尾各两条，中间只留“已总结若干消息”的说明，并没有实际摘要。这是比继续增加 Agent 类型更直接的质量差量：长期伴学必须保留当前学习目标、未解决错误、用户偏好、承诺与来源，不能凭占位文本声称仍记得中间事实。

建议沿 ITER-007/017 验证最终输入、工具 Schema 与预留输出的总窗口，先定义必须保真的事实再选择窗口/摘要/检索策略。上游模型投影不等于用户删除；思隅的删除仍须覆盖原文、摘要与索引。

证据：[context edit 回归](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/coding-agent/test/session-context-edit.test.ts#L37)、[超大工具结果压缩](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/coding-agent/test/compaction.test.ts#L378)、[一次压缩重试限制](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/coding-agent/test/agent-session-auto-compaction-queue.test.ts#L135)。

**按需工具与多模型路由应先守住授权和预算。** 新 `codemode` 用 Worker 内的 QuickJS/WASM 执行组合脚本，MCP 可用工具搜索按需披露，减少全量 Schema 和中间结果；关键是每个嵌套调用仍走 `ctx.executeTool` 的 hooks。Virtual Models 则在实际请求时路由，再按物理模型窗口判断压缩。思隅可探索“本地小模型提取材料、较强模型解释难题”，或脚本内汇总多份资料后返回证据；但先满足 local-only、逐调用授权、取消、账本和总预算。pi 的脚本默认截止可为 Infinity，不适合直接沿用。

证据：[嵌套工具拒绝与结果脱敏测试](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/coding-agent/test/suite/agent-session-codemode.test.ts#L178)、[模型路由与较小窗口测试](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/coding-agent/test/suite/virtual-models.test.ts#L228)。

**扩展注册要么完整提交，要么丢弃；恢复依然需要业务幂等。** 旧版已有失效上下文和订阅清理，本次增量是 factory 失败时丢弃暂存注册、幂等 unsubscribe、内置扩展也有可配置身份。新 durable scheduler 则持久化各阶段，缺少实现保持 pending，拒绝旧 invocation 的迟到提交。SQLite 恢复测试中外部调用可能执行两次，依靠稳定幂等键只应用一次，不能宣称任意副作用 exactly-once。直接借鉴到 ITER-005/010/029 的失败矩阵即可，不引入第二套 pi Session 真源。

证据：[注册提交/丢弃](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/coding-agent/src/core/extensions/loader.ts#L248)、[真实 SQLite 重开与幂等测试](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/durable/test/harness-tasks-recovery.test.ts#L110)。

**慢观察者可从增量切回快照。** durable watch 的未交付帧超过上限时折叠成当前根快照，避免 UI 拖垮生产者。可用于思隅 ITER-013 的运行进度与可重建页面状态；审批决定、工具账本和审计不能这样丢弃后继续假装事件连续。数值 100 是上游选择，思隅须测实际字节与延迟。

Package 15 又补充了“观察者只看已提交 partial”的实现：按 100ms 合并、最多一笔写在途，收尾先停计时并等待已启动写入；崩溃恢复保留可见内容，并沿用已准备的请求快照。思隅可用它补流式持久化与终态先后关系的测试，不能据此声称每个原始 Token 都落盘，恢复快照也不能绕过当前撤权/删除门禁。证据：[partial 持久化与恢复测试](https://github.com/earendil-works/pi/blob/5257d0d5f3ab7d42550804f32c67a77b49f485d4/packages/durable/test/harness-generation-recovery.test.ts#L123)。

证据：[慢观察者与旧实例退役测试](https://github.com/earendil-works/pi/blob/4df1574339bfbd1a9750ff485bb618da397ba135/packages/durable/test/session-watches.test.ts#L142)。

### 8.4 AstrBot：让已有能力可靠地进入日常使用

**插件升级失败不应让旧能力一起消失。** 本次 URL/ZIP 安装统一 staging、旧代码备份、失败回装，并保留禁用状态、配置与数据；最新提交修复 Windows ZIP 长路径。思隅[插件包安装](../../apps/api/src/modules/ecosystem/plugins/package-bundle.ts)的 overwrite 仍先卸载再安装，部分配置/Page 写入异常只警告，正命中 ITER-005/004。应学习失败矩阵：第 N 个入口验证失败、新版启动失败、用户取消、恢复失败和中途进程退出。AstrBot 的 copy/remove/move 与依赖安装不能提供完整崩溃原子性，思隅仍需自己的激活日志和恢复契约。

证据：[统一安装与恢复实现](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/astrbot/core/star/star_manager.py#L1998)、[备份及恢复失败测试](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/tests/test_plugin_manager.py#L740)。

**后台行为应继承用户当前会话的限制。** Cron/后台唤醒本次补齐模型 fallback、压缩、计算机运行时与历史处理；Cron 另补插件白名单、Runner 返回 ERROR 时记失败及无效排期编辑保留原任务。后台回调没有同等 ERROR 检查，不能把两条入口视为完全一致。思隅已有主动动作授权，不需再建 Cron 系统；应在聊天、计划触发、后台回调、恢复续跑四个入口比较 local-only、根预算、取消、授权修订与插件可用性。排队时授权有效，不代表真正执行时仍有效；对应 ITER-007/010/013。

证据：[后台执行上下文](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/astrbot/core/cron/manager.py#L463)、[正常聊天与后台压缩一致测试](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/tests/unit/test_cron_context_compression.py#L105)、[坏排期不破坏原任务](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/tests/unit/test_cron_edit_validation.py#L30)。

**操作系统强制隔离是审批之后的另一层责任。** 新 Local 权限区分代码执行、网络和文件范围，Linux 用 Bubblewrap、macOS 用 Seatbelt；受限文件操作用目录 fd、`O_NOFOLLOW`、`fstat` 防止路径检查后被调换，权限变化可回收旧 shell。思隅已有审批和输入检查，新增价值是约束已获准子进程后续究竟能访问什么。应在 ADR-009/ITER-019 的明确用例下验证真实 OS 后端、撤权与旧进程终止，不能把命令字符串过滤当作完整沙箱，也不照搬社交 Bot 的多用户管理员模型。

证据：[文件访问强制边界](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/astrbot/core/computer/local_file_security.py#L39)、[关闭网络后的实际连接测试](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/tests/test_local_sandbox_access.py#L261)。

**让模型知道预算快用完，比单纯提高步数更有用。** 本次在 80%/90%/95% 处提醒收束，计数存消息之外避免压缩重置；关闭 SDK 内置重试以减少与上层叠乘。思隅已有硬预算，值得补模型可见的剩余资源以及“已完成/未完成/下一步”交付。不要照搬默认 128 步或这些比例。同时学习在拿到会话锁后重新加载历史、重验删除/配置，上游只将附件下载移到锁前，图片准备仍在锁内。思隅可进一步评估转码等耗时工作移出临界区，但锁变短不能以使用旧授权快照为代价。

证据：[预算收束提示测试](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/tests/test_tool_loop_agent_runner.py#L2282)、[锁前附件与锁后重验](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/astrbot/core/pipeline/process_stage/method/agent_sub_stages/internal.py#L236)。

**多模态输入要保留原件和转换语义。** 新图片准备统一方向、透明度、尺寸及编码预算，动画抽帧并说明语义，保留原件与未送达模型的状态。拍题、教材和桌面观察可采用“原件 → 模型派生件 → 转换元数据”；中文小字/公式与操作坐标分别验收，不能直接照搬小于 512 KiB 的阈值。先用手写数学、长截图、透明图和动画固定集测正确率、延迟与内存，再决定压缩参数，沿 ITER-007/008/017 研究。

证据：[图片准备实现](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/astrbot/core/utils/image_input.py#L18)、[原件、透明度、方向与动画测试](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/tests/test_model_image_preparation.py#L29)。

**产品完善应围绕“找得到、读得完、收得到结果”。** 本次增加技能搜索、批量管理，并在批删路径沿用只读来源保护，修复 `skills_like` 重询丢上下文/多模态及流式结果交付；Neo 候选→评估→晋升并非新功能，思隅[技能生命周期](../../apps/api/src/modules/ecosystem/skills/lifecycle.ts)也已借鉴。聊天新增历史分页、会话草稿、阅读锚点和自动滚动意图处理。思隅可优先验证“向上读错题时不被新 Token 抢滚动”“切桌宠/工作台保留草稿”。Runner 配置迁移保护自由字典与共享旧参数也值得用作 Config 回归，避免把用户数据当废弃键清除；不复制面向多平台 Bot 运维的整套导航。

证据：[技能参数重询与流式交付测试](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/tests/test_tool_loop_agent_runner.py#L1659)、[阅读锚点](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/dashboard/src/components/chat/Chat.vue#L1732)、[配置自由字典保留测试](https://github.com/AstrBotDevs/AstrBot/blob/b53999e959cfc3b71d7b74713ddee837be843fcb/tests/unit/test_config.py#L1188)。

### 8.5 思隅值得吸收的最小切片与验收

下表是研究建议和验收输入，执行状态与跨专题排序只由根计划维护。本次未实施这些切片；涉及新持久语义、隔离或对外契约时先评审 CR。相关现有队列增加本节证据链接，不把参考更新等同产品改造授权。

| 借鉴方向 | 思隅现有基础与实际差量 | 建议的最小证明 | 归属 |
|---|---|---|---|
| 取消、恢复与副作用 | 已有控制上下文/租约/账本；生产派发窗口、终态和恢复仍有差量 | 在准入/取消提交/工具完成/终态提交处逐点崩溃；未知结果不盲重放，晚结果不能覆盖新代际 | ITER-029、010、007 |
| 最终请求与保真压缩 | 已有 ContextBuilder/Manifest；可选规则压缩（默认关闭）没有真实摘要，动态工具和实际模型窗口待验收 | 固定长伴学对话检查学习目标、错因、承诺与来源；超大 Tool Result 不断配对，撤权工具不可执行，总输入不超窗口 | ITER-007、017 |
| 插件可恢复升级 | 已有数据权利与代际句柄；overwrite/部分入口失败尚未闭环 | 新版第 N 个注册失败后无幽灵工具/订阅；旧代码、Config/Secret/授权/开关可恢复；重启中断逐点测 | ITER-005、004、029 |
| 进度和阅读连续性 | 已有单调投影与旧流隔离；慢客户端/长历史/草稿仍应实测 | 洪泛下内存有界，可重建进度明确切快照；审批证据完整；阅读点不跳、草稿不丢 | ITER-013 |
| 主动提醒与晚答 | 已有 Worker/Outbox、动作授权、UserQuestionPort | 离线多次到期合并；修改坏排期不破坏原提醒；晚答关联原问题；撤权后后台入口也拒绝 | ITER-010、013、007 |
| 进程工具和多模态 | 已有 HostToolRuntime/模型 Driver；真实 OS 强制边界与输入质量待测 | 每 OS 测目录逃逸、关闭网络、撤权后进程；固定图片集评测原件保持、识别率及坐标映射 | ITER-019、008、017 |

建议先把前三行用于已存在问题的修复设计和回归，再验证面向用户的提醒、阅读及拍题体验。多模型路由、`codemode`、多 Agent 只在明确场景和对照收益成立后投入。没有证据支持为了本轮上游变化更换 SQLite、引入 JSONL 第二真源、复制 Cordis 全插件结构，或立即开放第三方可执行插件。

### 8.6 本次更新的兼容性与验证记录

DSH 的 `packages/core/agent`、`packages/core/agent-loop` 路径与 `./lib/index.js` 入口仍在；runner 关注的 `AgentRegistry`、`assembleContextFor`、`emitAgentEvent`、`installModelSelection` 仍在源码导出面。成功结果的 `concludesTurn` 仍采用 any 语义，思隅保留 Adapter 对混合批次的严格收紧。同步修改 DSH 固定 SHA、runner 的版本/握手 SHA 与既有测试断言，没有引入上游代码依赖。

[参考探测](../../packages/host-agent/src/dsh-reference.ts)读取父仓已提交的 gitlink，因此提交前代码门禁在与待提交 DSH 代码/gitlink 一致的临时 Git 对象视图中验证，保留正常 SHA 检查。该视图不移动分支 HEAD、不更改产品探测规则；使用 `TURBO_ENV_MODE=loose` 将临时 Git 视图传到测试子进程，显式关闭外部 DSH 模型调用，完成后删除临时替换引用。首轮严格环境过滤掉该视图，导致旧 HEAD 与新常量不匹配；这次环境问题不计作代码通过。

本地 `mise tasks run ci-code` 全量通过：构建 18/18、类型检查 29/29、测试 27/27 任务，Host Agent 为 94 通过、1 条件跳过；`mise tasks run ci-docs` 全量通过：治理 33/33、队列 9/9、81 文件 Markdownlint/Vale 与严格治理通过，保留原有 ITER-005 的 S5 依赖次序提示。三份最终子模块工作树均干净，SHA 与清单一致；pi 收尾三笔增量为参考源码，不参与思隅构建。最终状态回填再经文档增量门禁。上游仅完成源码/测试阅读；未运行新的 DSH 库内构建、完整 Cordis 回合、pi durable 聊天或 AstrBot 跨平台沙箱。本地保留此前已有的 `node_modules/lib`，条件库加载烟测不计作新 SHA 的构建证明。Aervox runner 的本地兼容端点测试只证明自身协议骨架，不能视为真实 DSH 工具循环、审批、恢复均兼容。

如需回退，恢复本节表中的旧 gitlink，同时恢复 DSH 常量、runner manifest 和参考登记；无需改动业务数据库。历史 CR/教程中的旧 SHA 保留为当时的设计证据，并明确链接当前复评。

## 9. 参照

- [PRD §15 参考项目与借鉴边界](../reference/PRD.md#15-参考项目与借鉴边界)、[§15.1 参考实现要求](../reference/PRD.md#151-参考实现要求)
- [文档索引 §6 参考项目](../README.md#6-参考项目)
- [SQLite 本地单用户数据库契约](../reference/DATABASE.md)
- [能力注册表](../reference/capability-registry.md)（AVX-CAP-REG-001）
- [Agent Harness Loop 设计与落地规范](../reference/agent-harness-loop.md)（AVX-HAR-001）
- DeepSeek Harness 固定 commit `639ed015397290b3745d163aafe02ffee4aa3f84`（MIT，仅以 `DSH-01` 借鉴 Agent Loop 设计，不作为运行时依赖）
- pi 固定 commit `5257d0d5f3ab7d42550804f32c67a77b49f485d4`（MIT，仅以 `PI-01` 借鉴 Agent Harness 设计，不作为运行时依赖）
- BaiShou-Next 固定 commit `d95bae0f6f3184a94bbc3a77eb71ca987bfcadba`（AGPLv3，仅参考设计，不复制源码）
- AstrBot 固定 commit `b53999e959cfc3b71d7b74713ddee837be843fcb`（AGPLv3，仅参考设计，不复制源码）
- Petra 固定 commit `b629b295b5ae535d80e09cd59bd3d515bcd8150f`（MIT，复制代码需记录来源与版权声明）
- [Letta Code 官方仓库](https://github.com/letta-ai/letta-code)与[上下文架构说明](https://github.com/letta-ai/letta-code/blob/main/src/agent/prompts/letta.md)（Apache-2.0；品牌资产除外；本次只作 Harness 设计参照）
- [Graphiti 官方仓库](https://github.com/getzep/graphiti)与[quickstart](https://github.com/getzep/graphiti/tree/main/examples/quickstart)（Apache-2.0；本次只作时态事实与检索设计参照）
- [Generative Agents 原始论文](https://arxiv.org/abs/2304.03442)与[官方配套仓库](https://github.com/joonspk-research/generative_agents)（Apache-2.0；本次只作行为闭环与消融设计参照）
