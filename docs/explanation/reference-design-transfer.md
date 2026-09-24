---
id: AVX-EXPL-002
type: explanation
scope: baseline
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 0.9.1
updated_at: 2026-09-25
reviewed_at: 2026-09-25
review_interval_days: 90
---

# 参考项目能力迁移与借鉴评估

- 提出人：3yearszhuang · 2026-08-26
- 修改人：kikoyida · 2026-09-25

关联：[参考项目与借鉴边界](../reference/PRD.md#15-参考项目与借鉴边界)、[SQLite 本地单用户数据库契约](../reference/DATABASE.md)、[能力注册表](../reference/capability-registry.md)、[Agent Harness Loop 规范](../reference/agent-harness-loop.md)、[AI 质量与安全规范](../reference/AI_QUALITY_SAFETY.md)

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

| 来源编号 | 固定参考 | 重点证据 | 可借鉴设计 | Aervox 明确不迁移 |
|---|---|---|---|---|
| `DSH-01` | `reference/deepseek-harness`，commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`，MIT | `packages/core/agent-loop/src/agent.ts`、`docs/architecture.md`、`packages/core/agent-loop/README.md` | Turn/Step 双层循环、模型流与工具请求交替、typed event、`followup`/`steer`/`inject`、可逆 effect/disposer | DSH Session log、Cordis Context、DSH 权限系统、直接连接 Aervox SQLite |
| `PI-01` | `reference/pi`，commit `c49906ec77788625aacbdc53ebca6fbe65bd20f5`，MIT | `packages/agent/src/agent-loop.ts`、`packages/agent/src/harness/`、`packages/agent/docs/harness.md` | outer follow-up loop、inner tool/steer loop、工具参数准备与结果回填、append-only/reducer、writer lease/fencing | pi Session/存储格式、Extension 宿主权限、直接加载到 API/Worker/Renderer；该版本 Harness v2 仍有 scaffold，不能视为已接入实现 |

固定版本的终止语义并不相同：DSH 在一个已结算工具批次中任一成功结果声明 `concludesTurn` 即可结束，pi 低层 loop 则要求非空批次的所有结果 `terminate=true`。Aervox 统一采用后者的严格策略；`adapter-dsh` 必须显式收紧或拒绝不兼容的混合批次，不能把上游 any 语义静默暴露给业务。pi 的低层 `agent-loop.ts` 可作为控制流参考，但固定版本 `AgentHarness` v2 的公开 `prompt`/`resume`/`abort` 等能力仍是 scaffold。

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

## 8. 参照

- [PRD §15 参考项目与借鉴边界](../reference/PRD.md#15-参考项目与借鉴边界)、[§15.1 参考实现要求](../reference/PRD.md#151-参考实现要求)
- [文档索引 §6 参考项目](../README.md#6-参考项目)
- [SQLite 本地单用户数据库契约](../reference/DATABASE.md)
- [能力注册表](../reference/capability-registry.md)（AVX-CAP-REG-001）
- [Agent Harness Loop 设计与落地规范](../reference/agent-harness-loop.md)（AVX-HAR-001）
- DeepSeek Harness 固定 commit `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e`（MIT，仅以 `DSH-01` 借鉴 Agent Loop 设计，不作为运行时依赖）
- pi 固定 commit `c49906ec77788625aacbdc53ebca6fbe65bd20f5`（MIT，仅以 `PI-01` 借鉴 Agent Harness 设计，不作为运行时依赖）
- BaiShou-Next 固定 commit `d95bae0f6f3184a94bbc3a77eb71ca987bfcadba`（AGPLv3，仅参考设计，不复制源码）
- AstrBot 固定 commit `4d877c9919e58008f6f2cf4b19e18f9c48e4338f`（AGPLv3，仅参考设计，不复制源码）
- Petra 固定 commit `b629b295b5ae535d80e09cd59bd3d515bcd8150f`（MIT，复制代码需记录来源与版权声明）
- [Letta Code 官方仓库](https://github.com/letta-ai/letta-code)与[上下文架构说明](https://github.com/letta-ai/letta-code/blob/main/src/agent/prompts/letta.md)（Apache-2.0；品牌资产除外；本次只作 Harness 设计参照）
- [Graphiti 官方仓库](https://github.com/getzep/graphiti)与[quickstart](https://github.com/getzep/graphiti/tree/main/examples/quickstart)（Apache-2.0；本次只作时态事实与检索设计参照）
- [Generative Agents 原始论文](https://arxiv.org/abs/2304.03442)与[官方配套仓库](https://github.com/joonspk-research/generative_agents)（Apache-2.0；本次只作行为闭环与消融设计参照）
