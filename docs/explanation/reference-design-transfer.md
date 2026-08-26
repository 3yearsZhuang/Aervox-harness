# 参考项目能力迁移与借鉴评估

> 文档编号：AVX-EXPL-002
> 类型：Explanation
> 版本：v0.3
> 更新日期：2026-08-26
> 状态：Draft
> 责任角色：技术负责人
> 关联：[参考项目与借鉴边界](../reference/PRD.md#15-参考项目与借鉴边界)、[数据库设计与双引擎契约](../reference/DATABASE.md)、[可选功能模块化方案](optional_modules.md)、[AI 质量与安全规范](../reference/AI_QUALITY_SAFETY.md)

## 1. 评估范围与判定框架

本评估回答：`reference/` 内参考项目中哪些设计适合在本项目落地，哪些仅作为设计参考。当前覆盖三个已评审项目：BaiShou-Next（固定 commit `d95bae0f`）、AstrBot（固定 commit `4d877c99`）与 Petra（固定 commit `b629b295`，v0.2.1）。前两者采用 AGPLv3，适用同一借鉴边界；Petra 采用 MIT，风险评级参照 dsh-synapse。其余子模块（dsh-synapse、deepseek-harness、pi）的评估另行补充。评估结论与 [PRD §15](../reference/PRD.md#15-参考项目与借鉴边界) 的参考项目策略保持一致。

判定框架有三条边界：

1. **许可证边界**：BaiShou-Next 与 AstrBot 均采用 AGPLv3，按 [PRD §15.1](../reference/PRD.md#151-参考实现要求)，除非完成许可证评审，只借鉴公开设计和数据模型，不直接复制其代码或形成链接依赖；Petra 采用 MIT，可作为较低风险的表现与交互实现参考，但复制代码仍需按 PRD §15.1 记录文件来源、版权声明与许可证影响。因此下文"建议落地"一律指在 Aervox 内**自研重写其设计**，不拷贝源码。
2. **架构契合度**：BaiShou-Next 是 Electron/Expo 本地优先应用，AstrBot 是 Python 异步 IM 机器人框架，Petra 是 Tauri 2 桌宠（Windows 优先）；Aervox 是 Fastify 服务端 + Web/Desktop 客户端。仅评估与 Aervox 模块化单体、Port 存储、Worker 异步链路兼容的设计。
3. **落地成本与优先级**：以 P0/P1 能力为优先，避免为远期功能引入当前不需要的复杂度。

判定结果分为三类：**A 建议落地**（符合 Aervox 规划、可在现有架构内自研实现）、**B 值得借鉴**（设计有价值但在本阶段不落地）、**C 暂不采用**（与目标架构冲突或依赖不匹配）。

## 2. 结论摘要

| 编号 | 设计 | 判定 | 落点 | 关联需求 |
|---|---|---|---|---|
| T-01 | SQLite 写路径 busy 重试（指数退避） | A | `packages/database` 写路径 | WAL 多进程并发（DATABASE.md） |
| T-02 | FTS + 向量 RRF 混合检索 + JS 余弦降级 | A | `packages/database/src/search` | 记忆召回窗口 |
| T-03 | 上下文压缩标记（snapshotId 写回会话） | A | 临时→短期整理链路 | PRD §7.5 记忆验收标准 |
| T-04 | 工具注册表 + 主动记忆工具 | A | AI 运行时工具系统 | CAP-020、记忆晋升候选 |
| T-05 | Embedding 独立存储 + 可中止的迁移控制 | A | `memory_embeddings` 独立表 | 双引擎向量规划（ADR-003） |
| T-06 | 数据库迁移服务（journal + 旧库补齐） | B | 存储层演进 | DATABASE.md 迁移三阶段 |
| T-07 | 桌面 preload 按域划分 IPC API | B | `apps/desktop` | 桌面端功能扩展 |
| T-08 | 桌宠角色设定文档化 | B | 文档组织 | 桌宠 IP、CAP-019 |
| T-09 | Git 作为数据版本/同步层 | B | 本地优先与导出 | PRD §15.2 决策 4 |
| T-10 | Token 用量分账（缓存/非缓存） | B | `ModelRun` 埋点 | AI 质量与安全规范 |
| T-11 | 多工作区 vault 双库模型 | C | — | 与单库多租户冲突 |
| T-12 | Expo 移动端与 WebView 日记编辑器 | C | — | 与 ADR-015（Capacitor）冲突 |
| T-13 | 云同步/局域网快传/定价/更新器 | C | — | 商业化能力不在当前路线 |
| AST-01 | 会话级写锁（引用计数回收、按事件循环隔离） | A | 会话写路径进程内锁 | 与 T-01 互补 |
| AST-02 | 向量库 Port 批量/重试/进度回调接口形态 | A | T-05 落地时对齐 Port 语义 | 双引擎向量规划（ADR-003） |
| AST-03 | 人设字段化 + 逐级解析 + 默认兜底 | B | 随 CAP-019 立项 | 桌宠 IP、CAP-019、T-08 |
| AST-04 | 插件元数据模型 + 工具配置条件门控 | B | CAP-020 插件权限模型 | T-04 |
| AST-05 | Pipeline Stage 显式顺序 + 迁移完成标记 | B | Worker/中间件管线演进 | T-06 |
| AST-06 | IM 平台适配/群聊白名单/内容安全链路 | C | — | 与伴学 1v1 场景冲突 |
| AST-07 | Dashboard 面板形态与 zip 更新器 | C | — | 与 T-13 同理由 |
| PET-01 | 桌宠表现命令通道（speak/emote/gesture/move/react） | A | 消息/SSE 契约预留表现指令 | 桌宠 IP、表现层与大脑解耦 |
| PET-02 | 结构化记忆条目字段（source 区分用户自述/AI 推断） | A | 记忆 schema 字段对照 | PRD §7.5 记忆验收标准、T-03/T-04 |
| PET-03 | 自主行为引擎参数化（活动频率三档/躲避/待机） | B | 桌面端角色行为 | T-07、桌宠 IP |
| PET-04 | 表现驱动数据对象 + 视图接口分离 | B | 桌宠表现层抽象 | 桌宠 IP、CAP-019 |
| PET-05 | AI 工具只读白名单与提示词使用原则 | B | 工具链安全规范 | AI 质量与安全规范 |

## 3. A 类：建议落地

### 3.1 T-01 SQLite 写路径 busy 重试

BaiShou-Next 对 `database is locked` / `sqlite_busy` 错误做指数退避重试（参考 `reference/baishou-next/packages/database/src/sqlite-busy.util.ts`）。Aervox 的 API、Worker、Desktop 共用同一 `data/aervox.db`（WAL 模式），多进程写竞争是既有风险点。

落点：在 `packages/database` 封装统一的写入重试工具，对所有事务性写操作包一层；重试参数（初始退避、最大次数）可配置。此为纯函数级自研，风险低，可在任意批次排期。

### 3.2 T-02 混合检索（FTS + 向量 RRF）

BaiShou-Next 并行执行 FTS 粗筛与向量细筛，用 RRF（Reciprocal Rank Fusion）融合排序，支持 `ftsWeight/vectorWeight` 权重；任一通道不可用时降级返回另一通道结果；在无原生向量库时用 JS 遍历余弦相似度兜底（参考 `reference/baishou-next/packages/ai/src/rag/hybrid-search.ts` 及其 service）。

Aervox 已具备两块输入：FTS5 虚表（`memory_records_fts` 等）与内存向量 Port（`packages/database/src/search/vector-port.ts` 的 `InMemoryVectorSearchAdapter`），目前尚未融合。

落点：在 `packages/database/src/search` 新增混合检索服务，复用现有 `IVectorSearchPort` 与 FTS5，输出统一召回结果。这是记忆召回窗口期检索的第一步，也是后续 pgvector 切换时仅替换 Port 实现的边界。

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

BaiShou-Next 将 embedding 存独立表 `memory_embeddings`（含 `dimension/modelId/sourceCreatedAt`），不塞进业务表；模型升级走独立迁移（快照备份 → 重新 embedding），并用全局 abort 控制支持中途取消（参考 `reference/baishou-next/packages/database/src/schema/vectors.ts` 与 `packages/ai/src/rag/embedding-migration.ts`、`migration-control.ts`）。

Aervox 双引擎规划（ADR-003/CR-003）当前方案是 `memory_records.embedding` 可空列。独立表方案更优：换 embedding 模型不动业务表、SQLite 侧即可先行落地而非等 PG。此改动涉及已批准文档（DATABASE.md/ADR-003），落地时需按[变更控制](../reference/REQUIREMENTS_TRACEABILITY.md#11-变更控制)建立变更请求，并保留"可中止 + 断点续跑"约束，避免长迁移阻塞 Worker。

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

BaiShou-Next 用迁移 journal（`_journal.json`）+ 启动时旧库列补齐（`AGENT_DB_COLUMN_PATCHES`）管理 SQLite 演进（参考 `reference/baishou-next/packages/database/src/migration.service.ts`）。Aervox 目前仅 `CREATE TABLE IF NOT EXISTS`，表结构变更靠手动迁移，是已知痛点。

暂不落地原因：Aervox 的 DATABASE.md 已规划 Expand/Contract 三阶段迁移，属结构性改造，需与 PG 双引擎切换一并设计，不宜单独插入。借鉴其迁移 journal 与"旧库兼容回填"两处的处理手法。

### 4.2 T-07 桌面 preload 按域划分 IPC

BaiShou-Next 在 preload 通过 contextBridge 暴露按域拆分的 `settings.api`/`diary.api`/`sync.api` 等 API，主进程统一 `ipcMain.handle('域:动作')` 模式，长任务用事件推送进度（参考 `reference/baishou-next/apps/desktop/src/preload/index.ts` 及 `ipc/` 目录）。Aervox 桌面端 preload 目前单文件入口，功能扩展时采用该模式即可，无需提前重构。

### 4.3 T-08 桌宠角色设定文档化

BaiShou-Next 将桌宠人设独立成文档（`Latte/角色設定.md` 与多语言 profile，含核心概念、外形、提示词边界）。Aervox 桌宠 IP 与多人格模板（CAP-019）可复用此组织方式，把角色提示词与识别边界文档化、版本化，交由产品负责人维护。

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

## 5. C 类：暂不采用

| 设计 | 原因 |
|---|---|
| 多工作区 vault 双库模型与 registry/影子索引 | 与 Aervox 单库多租户行级模型冲突，仅保留"注册表 + 可重建索引"的思想启示 |
| Expo 移动端、tab/设置路由、WebView 内嵌日记编辑器 | ADR-015 已定 Capacitor + Web 复用路线，栈不同不迁移 |
| 云同步、局域网快传、定价、更新器、Windows 安装器 | 商业化与桌面基建能力，不在当前 P0/P1 路线内 |
| 事件驱动的 agent-part 前端 UI（React 专属 hooks） | Aervox 前端为 Vue 单栈（ADR-015），不跨栈移植组件 |
| IM 多平台适配器、群聊白名单、限流与内容安全 stage | Aervox 是 1v1 伴学场景，无 IM 群聊治理需求，不引入该链路 |
| Dashboard Asgi 面板形态、zip 更新器与 FUNDING 商业组件 | 与 T-13 同：运维面板与商业化能力不在当前 P0/P1 路线 |
| Tauri 2 桌面栈与 Windows 原生层（mover 线程、WASAPI、回收站、开机自启） | Aervox 桌面端为 Electron（CR-002）且首发 Web，栈不同不迁移 |
| PSD/Live2D 渲染栈（pixi-live2d-display、ag-psd、Anime2.5DRig）与更新器 | 角色资产管线待桌面端阶段另行评估；更新器与 T-13 同理由 |

## 6. 落地顺序建议

以"见效快、不改结构、先服务现有痛点"为原则分三批：

1. **第一批（低风险，独立可排）**：T-01 busy 重试 → AST-01 会话级写锁 → T-02 混合检索。三者都是 `packages/database`/写路径内收口改动，直接解除多进程锁风险并打通记忆召回首链路。
2. **第二批（需要契约与 Worker 配合）**：T-03 压缩标记 → T-05 embedding 独立表（对照 AST-02 对齐 Port 语义）→ PET-01 表现指令字段、PET-02 记忆条目字段（随契约冻结对照）。涉及记忆溯源与运行时代价，先冻结 `packages/contracts` 相关 schema 再实现。
3. **第三批（随 CAP 排期）**：T-04 工具系统随 CAP-020 立项（对照 AST-04 元数据模型，安全对照 PET-05 白名单）；AST-03 人设解析链随 CAP-019 立项（对照 T-08 文档化）；PET-03 自主行为、PET-04 表现驱动抽象随桌面端功能扩展引入；T-06～T-10、AST-05 按对应功能阶段引入。

## 7. 参照

- [PRD §15 参考项目与借鉴边界](../reference/PRD.md#15-参考项目与借鉴边界)、[§15.1 参考实现要求](../reference/PRD.md#151-参考实现要求)
- [文档索引 §7 参考项目](../README.md#7-参考项目)
- [数据库设计与双引擎契约](../reference/DATABASE.md)
- [可选功能模块化方案](optional_modules.md)
- BaiShou-Next 固定 commit `d95bae0f6f3184a94bbc3a77eb71ca987bfcadba`（AGPLv3，仅参考设计，不复制源码）
- AstrBot 固定 commit `4d877c9919e58008f6f2cf4b19e18f9c48e4338f`（AGPLv3，仅参考设计，不复制源码）
- Petra 固定 commit `b629b295b5ae535d80e09cd59bd3d515bcd8150f`（MIT，复制代码需记录来源与版权声明）
