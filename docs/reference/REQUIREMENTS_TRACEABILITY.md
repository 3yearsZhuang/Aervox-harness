# Aervox｜思隅 需求追踪与交付质量基线

- 提出人：3yearszhuang · 2026-08-26
- 修改人：kikoyida · 2026-08-27

> 文档编号：AVX-TRC-001  
> 类型：Reference  
> 文档版本：v0.6
> 文档状态：评审候选（Review Candidate）  
> 更新日期：2026-08-27
> 产品需求来源：[PRD.md](PRD.md)
> 适用范围：原型、MVP、MVP+、P1、桌面阶段、P2、P3 及后续维护版本

## 1. 目的与使用方式

本文档为 [PRD.md](PRD.md) 提供稳定的需求编号、覆盖状态、交付准入、测试追踪、发布门禁、风险登记和变更控制规则。PRD 负责说明产品价值、用户场景、生命周期范围和功能优先级；本文档负责证明每项需求是否已经被完整定义、实现、验证并发布。

本文件遵循以下原则：

1. 能力 ID 一经建立不得因名称、优先级或交付版本调整而改变。
2. P0/P1/P2/P3 是可变的产品优先级，不写入稳定 ID。
3. “出现在功能地图中”只代表 `Mapped`，不代表可以进入开发。
4. 每条发布范围内的需求必须能够正向追踪到设计和测试，也必须能从测试反向追踪到原始需求。
5. 已发布需求不得从追踪记录中物理删除；取消或替代时标记为 `Deprecated`，并记录替代关系。
6. 需求使用“必须”“应当”“可以”分别表达强制、推荐和可选约束，避免使用“尽量”“合适”“智能”等不可验证措辞。

`P0～P3` 仅表示优先级；`R0`、`R1`、`R1.5`、`R2`、`R3`、`R4`、`R5` 表示发布阶段。两者不得混用，调整发布阶段不能删除能力或改变 `CAP-*` ID。

## 2. 需求状态模型

| 状态 | 定义 | 进入条件 |
|---|---|---|
| `Proposed` | 新想法，尚未进入正式产品范围 | 有来源、提出人和初步价值说明 |
| `Mapped` | 已进入能力地图并确定优先级/生命周期位置 | 已关联一个 `CAP-*`，但详细行为或验收仍不完整 |
| `Specified` | 主要范围、流程、规则、异常和可测试验收条件已形成可评审草案 | PRD 或 SRS 已有独立详细说明，且剩余缺口已列出；尚未通过 DoR |
| `Ready` | 已满足 Definition of Ready，可进入开发 | DoR 全部通过，阻塞问题已关闭或获批准豁免 |
| `Implemented` | 实现完成，尚未完成全部验证 | 代码、配置和迁移已合并，构建通过 |
| `Verified` | 已通过规定测试和产品验收 | 测试结果与验收证据已回填 |
| `Released` | 已在目标环境完成发布并验证 | 灰度、监控和发布后检查通过 |
| `Deprecated` | 已取消、替换或进入下线期 | 记录原因、替代 ID、兼容和下线日期 |

`Blocked`、`At Risk` 不作为主状态，而作为附加标记；必须同时记录阻塞原因、阻塞条件和解除条件。

## 3. 稳定 ID 体系

### 3.1 ID 类型

| 前缀 | 对象 | 示例 |
|---|---|---|
| `CAP` | 生命周期能力；当前固定为 `CAP-001`～`CAP-032` | `CAP-005` 四段式记忆与记忆树 |
| `US` | 用户故事 | `US-LRN-001` 创建学习目标 |
| `FR` | 功能需求 | `FR-REV-001` 生成到期复习项 |
| `BR` | 业务规则或状态转换规则 | `BR-MEM-003` 禁止临时记忆直接晋升系统记忆 |
| `NFR` | 性能、可靠性、可用性、兼容性等非功能要求 | `NFR-PERF-001` 首个安全持久化可见分段 P95 |
| `DATA` | 数据结构、完整性、保留和迁移要求 | `DATA-MEM-001` 记忆来源链完整性 |
| `AIQ` | AI 正确性、评估、提示和模型行为要求 | `AIQ-DIA-001` 日记事实可追溯率 |
| `SEC` | 身份、权限、供应链和攻击面要求 | `SEC-PLG-001` 插件最小权限 |
| `PRIV` | 同意、数据最小化、导出、更正和删除要求 | `PRIV-RET-001` 召回、保留与备份期限分离 |
| `OPS` | 部署、监控、告警、恢复和运维要求 | `OPS-REL-001` 模型服务降级 |
| `AC` | 单条、可验证的验收条件 | `AC-FR-REV-001-01` |
| `TC` | 测试用例或评估用例 | `TC-E2E-STREAM-001`、`TC-INTEG-MEM-001` |
| `EXP` | 待验证假设和实验 | `EXP-001` 桌宠入口价值实验 |
| `RISK` | 风险记录 | `RISK-003` 记忆失真 |
| `DEC` | 产品或跨团队决策 | `DEC-001` 首发仅支持成人用户 |
| `ADR` | 架构决策 | `ADR-001` 模块化单体 + Worker |
| `CR` | 基线后的需求变更请求 | `CR-001` 调整日记默认视角 |

### 3.2 领域代码

| 代码 | 领域 | 代码 | 领域 |
|---|---|---|---|
| `UX` | 桌宠、工作台与交互体验 | `LRN` | 学习目标、问答与资料 |
| `PRC` | 练习、错题与报告 | `REV` | 复习与调度 |
| `MEM` | 四段记忆与记忆树 | `DIA` | AI 日记 |
| `PER` | 人格与偏好 | `CONV` | 消息、分支与会话地图 |
| `KNO` | 思维宇宙与知识关系 | `PLAN` | 学习路线与考试计划 |
| `DESK` | 桌面端、Live2D 与通知 | `PLG` | 技能与插件 |
| `EXT` | 外部题库、文献、图片和扫描 | `KB` | 收藏空间与知识库 |
| `LOCAL` | 本地优先、工作区与同步 | `ECO` | 社区、公开内容和市场 |
| `ORG` | 机构、监护和组织权限 | `DATA` | 跨域数据治理 |
| `AIQ` | 跨域 AI 质量与安全 | `OPS` | 跨域运行质量 |

### 3.3 编号规则

- `CAP-001`～`CAP-032` 与 PRD 功能地图一一对应，禁止复用或重新排序。
- 其他 ID 在各领域内单调递增；标题变化不改变 ID。
- 需求拆分时，原 ID 标为 `Deprecated`，通过 `replacedBy` 指向新 ID。
- 需求合并时，保留全部旧 ID，并通过 `supersededBy` 指向合并后的 ID。
- 优先级、目标版本和状态属于字段，不是 ID 的组成部分。

## 4. CAP-001～CAP-032 覆盖矩阵（全部能力状态唯一速览）

本矩阵是全部 32 个 CAP 的**唯一一眼速览**（DoR 细分原 §4.1 已并入本表；批次顺序见[能力拆分路线](../explanation/roadmap.md)）。当前状态依据 PRD 中是否已有独立、可测试的详细行为和验收条件判定。

- `当前状态`：`Mapped`＝未完整规格；`Specified`＝已规格未过 DoR。`Specified` 仍不等于 `Ready`，进入开发前必须继续拆分原子需求并通过 DoR；
- `DoR 就绪`：按 [§6 Definition of Ready](#6-definition-of-ready) 评估；未规格 CAP 为 `—`，进入 `Specified` 后回填；
- `落地`：✔＝该 CAP 在 [§4.2 落地实现登记](#42-落地实现登记) 已有代码/运行时实现条目（纯文档治理条目不计）；`—`＝尚无；
- TC 覆盖占位 ID 不再在此重复，测试追踪见 [§8.2](#82-当前基线需求覆盖) 与[测试策略](TEST_STRATEGY.md)。

| 能力 ID | 能力 | 优先级 · 交付阶段 | 当前状态 | DoR 就绪 | 落地 | PRD 依据 | 达到下一状态所需工作 |
|---|---|---|---|---|---|---|---|
| `CAP-001` | 桌宠入口 | `P0 · R1` | `Specified` | Not Ready | ✔ | [首页工作台](PRD.md#prd-home)、[视觉小说式对话形态](PRD.md#prd-conversation-ui)、[CR-005](changes/CR-005-shared-workbench-web-without-pet.md)、[CR-007](changes/CR-007-live2d-sekai-viewer-pet.md) | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready`；Web/Desktop 表现层边界按 CR-005/CR-007 验证 |
| `CAP-002` | 学习目标与对话 | `P0 · R1` | `Specified` | Not Ready | — | [学习目标](PRD.md#prd-cap-002)、[引导式学习对话](PRD.md#prd-cap-007) | 拆分 `FR/BR/AC`，明确会话状态、并发修改、归档和恢复规则 |
| `CAP-003` | 互动刷题 | `P0 · R1` | `Specified` | Not Ready | — | [互动练习与错题本](PRD.md#prd-cap-003-004) | 已由 [CR-008](changes/CR-008-practice-session-contract.md) 补齐题目选择、快照、幂等和完成边界；仍需 UX、API 错误语义、E2E 与评审证据后推进 Ready |
| `CAP-004` | 错题本 | `P0 · R1` | `Specified` | Not Ready | — | [互动练习与错题本](PRD.md#prd-cap-003-004)、[CR-009](changes/CR-009-mistake-book-dismissal.md) | 已明确忽略/恢复不删除学习事实；仍需补错因变更、重复题合并的产品决策，以及 API、UI 与测试证据 |
| `CAP-005` | 四段式记忆与记忆树 | `P0 · R1–R2` | `Specified` | Not Ready | ✔ | [四段式记忆与记忆树](PRD.md#prd-cap-005) | 拆分各层状态转换、TTL、压缩、冲突、删除、重建和迁移测试 |
| `CAP-006` | 间隔重复 | `P0 · R1` | `Specified` | Not Ready | — | [间隔复习](PRD.md#prd-cap-006)、[CR-010](changes/CR-010-review-completion-idempotency.md) | 已明确完成幂等与结果重放；仍需错过日期、夏令时、算法升级和历史重算策略 |
| `CAP-007` | 文本与代码答疑 | `P0 · R1` | `Specified` | Not Ready | — | [引导式学习对话](PRD.md#prd-cap-007) | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready`（讲解触发复用 `FR-CONV-001`） |
| `CAP-008` | 情绪价值与安全陪伴 | `P0 · R1` | `Specified` | Not Ready | — | [关系与情绪边界](PRD.md#prd-safety-boundary)、[轻量陪伴](PRD.md#prd-cap-008) | 固定风险分级、地区化求助入口、审计、误报处置和安全回归集 |
| `CAP-009` | AI 每日日记 | `P0 · R1.5` | `Specified` | Not Ready | ✔ | [AI 每日日记](PRD.md#prd-cap-009)、[日记与记忆层的关系](PRD.md#prd-diary-memory) | 补定时任务幂等、重试、版本冲突、来源快照、通知和时区边界测试 |
| `CAP-010` | 人格问卷与基础偏好 | `P0 · R1.5` | `Specified` | Not Ready | — | [全生命周期功能地图](PRD.md#prd-cap-map)、[P0 最低验收](PRD.md#prd-cap-001-010-013) | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready` |
| `CAP-011` | 学习资料整理 | `P0 · R1.5` | `Specified` | Not Ready | — | [全生命周期功能地图](PRD.md#prd-cap-map)、[P0 最低验收](PRD.md#prd-cap-001-010-013) | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready` |
| `CAP-012` | 多模态答疑 | `P0 · R1.5` | `Specified` | Not Ready | — | [全生命周期功能地图](PRD.md#prd-cap-map)、[P0 最低验收](PRD.md#prd-cap-001-010-013) | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready` |
| `CAP-013` | 消息编辑、删除与引用 | `P0 · R1.5` | `Specified` | Not Ready | ✔ | [学习记录与数据控制](PRD.md#prd-cap-013)、[P0 最低验收](PRD.md#prd-cap-001-010-013) | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready` |
| `CAP-014` | 层级对话与会话地图 | `P1 · R2` | `Mapped` | — | — | [P1 验收原则](PRD.md#prd-cap-014-019) | 补分支生命周期、归属、合并、删除、布局恢复和大图性能 |
| `CAP-015` | 思维宇宙 | `P1 · R2` | `Mapped` | — | — | [P1 验收原则](PRD.md#prd-cap-014-019) | 补节点/边类型、证据、纠错传播、版本和可视化交互验收 |
| `CAP-016` | 自适应刷题与报告 | `P1 · R2` | `Mapped` | — | — | [P1 验收原则](PRD.md#prd-cap-014-019) | 补适应算法输入、冷启动、解释、偏差评估和报告口径 |
| `CAP-017` | 考试日计划 | `P1 · R2` | `Mapped` | — | — | [P1 验收原则](PRD.md#prd-cap-014-019) | 补计划生成约束、滚动调整、冲突、跳过、过期和完成定义 |
| `CAP-018` | 桌面化与 Live2D | `P1 · R3` | `Specified` | —（待评估） | ✔ | [P1 验收原则](PRD.md#prd-cap-014-019)、[CR-002](changes/CR-002-fairy-desktop-module.md)、[ADR-009](adr/ADR-009-electron-plugin-sandbox.md) | 已移植 `apps/desktop` Electron/Vue UI 与 Turn/SSE 边界；仍需补平台矩阵、签名更新、资源预算、崩溃恢复、后台行为及可执行 TC 证据后进入 Ready |
| `CAP-019` | 多人格模板 | `P1 · R2` | `Mapped` | — | ✔ | [P1 验收原则](PRD.md#prd-cap-014-019) | 补模板审核、切换、记忆隔离/共享、回滚和人格回归评估 |
| `CAP-020` | 技能与插件系统 | `P2 · R4` | `Mapped` | — | ✔ | [P2 验收原则](PRD.md#prd-cap-020-027) | 补清单格式、权限模型、沙箱、签名、版本兼容、撤权和卸载残留；插件配置规格见 [AVX-PLUG-001](plugin-config-and-pages.md) 与 [CR-006](changes/CR-006-plugin-config-and-pages.md) |
| `CAP-021` | 学习路线与视频推荐 | `P2 · R4` | `Mapped` | — | — | [P2 验收原则](PRD.md#prd-cap-020-027) | 补来源、排序、失效链接、用户反馈、商业内容标识和推荐评估 |
| `CAP-022` | 兴趣分析与跨域推荐 | `P2 · R4` | `Mapped` | — | — | [P2 验收原则](PRD.md#prd-cap-020-027) | 补授权信号、解释、关闭/重置、敏感属性禁用和偏差评估 |
| `CAP-023` | 第三方刷题接入 | `P2 · R4` | `Mapped` | — | — | [P2 验收原则](PRD.md#prd-cap-020-027) | 补 OAuth、字段映射、增量同步、冲突、限流、撤权和删除 |
| `CAP-024` | 文献阅读与发散 | `P2 · R4` | `Mapped` | — | — | [P2 验收原则](PRD.md#prd-cap-020-027) | 补解析格式、引用定位、长文分段、版权、模型上下文和失败恢复 |
| `CAP-025` | 线下试卷扫描 | `P2 · R4` | `Mapped` | — | — | [P2 验收原则](PRD.md#prd-cap-020-027) | 补图像质量、分题/批改识别、人工校正、置信度和附件删除 |
| `CAP-026` | 收藏空间与知识库 | `P2 · R4` | `Mapped` | — | ✔ | [P2 验收原则](PRD.md#prd-cap-020-027) | 补收藏状态、去重、检索、标签、来源失效、导入导出和容量限制 |
| `CAP-027` | 本地优先与多工作区 | `P2 · R4` | `Mapped` | — | ✔ | [P2 验收原则](PRD.md#prd-cap-020-027) | 补存储格式、工作区隔离、同步冲突、加密、备份恢复和版本迁移 |
| `CAP-028` | 社区互助 | `P3 · R5` | `Mapped` | — | — | [P3 验收原则](PRD.md#prd-cap-028-032) | 补角色、发布/回答状态机、信誉、举报申诉、审核 SLA 和未成年保护 |
| `CAP-029` | 名词解释网页 | `P3 · R5` | `Mapped` | — | — | [P3 验收原则](PRD.md#prd-cap-028-032) | 补发布、更新、撤回、来源失效、SEO/分享、隐私预览和版权规则 |
| `CAP-030` | 主动提醒深化 | `P3 · R5` | `Mapped` | — | — | [P3 验收原则](PRD.md#prd-cap-028-032) | 补触发优先级、频控、去重、解释、免打扰、跨端和退订验收 |
| `CAP-031` | 内容与技能市场 | `P3 · R5` | `Mapped` | — | — | [P3 验收原则](PRD.md#prd-cap-028-032) | 补商品、版本、审核、结算、退款、下架、许可证和供应链治理 |
| `CAP-032` | 机构与监护模式 | `P3 · R5` | `Mapped` | — | — | [P3 验收原则](PRD.md#prd-cap-028-032) | 补组织角色、邀请/移除、授权报表、最小可见、审计和监护同意 |

矩阵状态按 §12 维护规则更新：`Verified` 证据核实与 `Released` 状态确认留痕；任何状态变化必须在变更记录中留下日期与修改人。

**DoR 清单逐项结论（[§6](#6-definition-of-ready) 12 项）**：当前 13 个 `Specified` CAP 均未全部满足（`CAP-018` 尚未完成 DoR 评估，进入开发批次前补齐）。共性未满足项：

- `TC-*` 为稳定占位 ID，无关联代码/CI/人工证据（见[测试策略 §6](TEST_STRATEGY.md#6-当前阻断)）；
- API/数据实体/状态转换/UX 原型评审未完成；
- 埋点与指标事件未定义；
- 阻塞型 `EXP/RISK/DEC/ADR` 未全部关闭。

满足 DoR 的路径：按[工程与发布流程 §1](../how-to/engineering-process.md#1-新增与修改需求)补齐字段与证据，在对应批次启动时逐 CAP 关闭上述阻断项并推进 `Ready`。

### 4.2 落地实现登记

本节是**整个项目**代码落地完成情况的追踪事实源（约束见 [AGENTS.md](../../AGENTS.md)）。凡已合并的实现，无论是否完成 DoR/DoD 门禁，均须在此登记；门禁状态（§4 矩阵的 `当前状态` 列）仍按 §6/§7 单独推进，两者不互相替代。未登记的落地视为未闭环、提交打回。

登记规则：`关联 CAP` 表实现所属能力；`验证` 表已通过的自动化验证（测试/typecheck）；`来源` 标注参考设计（`T-*`/`AST-*`/`PET-*`，细则见 [参考设计迁移文档 §6.1](../explanation/reference-design-transfer.md#61-落地登记唯一真源)）或原生实现。

| 落地实现 | 关联 CAP | 实现位置 | 日期 | 验证 | 来源 |
|---|---|---|---|---|---|
| 错题本聚合、掌握标记与错题重练 | CAP-003/004 | `apps/api/src/modules/learning/routes.ts`、`packages/database/src/repositories/{types,sqlite/learning-repository}.ts`、`packages/api-client/src/useAervoxApi.ts`、`packages/ui/src/components/AervoxWorkbench.vue` | 2026-08-26 | `mistake-book.test.ts` 集成测试；API/API Client/UI 类型检查 | 原生 |
| 练习会话与结果报告 | CAP-003/004/006 | `apps/api/src/modules/learning/routes.ts`、`packages/database/src/schema/learning.ts`、`packages/database/src/repositories/sqlite/learning-repository.ts`、`packages/api-client/src/useAervoxApi.ts`、`packages/ui/src/components/AervoxWorkbench.vue` | 2026-08-26 | `practice-session.test.ts` 集成测试；学习路由类型检查 | 原生 |
| 练习作答 OpenAPI 幂等契约对齐 | CAP-003/004 | `packages/contracts/src/{practice-schemas,openapi}.ts`、`packages/contracts/openapi.json`、`apps/api/test/openapi-contract.test.ts` | 2026-08-27 | `@aervox/contracts` build 生成 OpenAPI；`openapi-contract.test.ts` 契约测试 | 原生 |
| 错题忽略/恢复处置 | CAP-004 | `apps/api/src/modules/learning/routes.ts`、`packages/database/src/schema/{learning,init}.ts`、`packages/database/src/repositories/sqlite/learning-repository.ts`、`packages/api-client/src/useAervoxApi.ts` | 2026-08-27 | `mistake-book.test.ts` 集成测试；Database/API/UI 类型检查 | 原生 |
| 复习完成幂等重放与工作台操作 | CAP-006 | `apps/api/src/modules/learning/routes.ts`、`packages/database/src/{schema,repositories}/`、`packages/contracts/src/`、`packages/api-client/src/useAervoxApi.ts`、`packages/ui/src/components/AervoxWorkbench.vue` | 2026-08-27 | API 集成测试；Database/API/UI 类型检查 | 原生 |
| SQLite 写路径 busy 重试 | CAP-005/009/013 | `packages/database/src/write-retry.ts`、`client.ts` | 2026-08-26 | 单测 | `T-01` |
| 会话级写锁 | CAP-005/009/013 | `packages/database/src/session-lock.ts` | 2026-08-26 | 单测 | `AST-01` |
| 混合检索（FTS + 向量 RRF） | CAP-005/026 | `packages/database/src/search/`（`fts.ts`/`hybrid-search.ts`/`vector-port.ts`） | 2026-08-26 | 单测 | `T-02` + 原生 |
| 上下文压缩标记表与仓储 | CAP-005 | `packages/database/src/schema/memory-compaction.ts`、`repositories/sqlite/memory-compaction-repository.ts` | 2026-08-26 | 单测 | `T-03` |
| 压缩标记异步消费 | CAP-005 | `apps/worker/src/compaction-marker.ts` | 2026-08-26 | typecheck | `T-03` |
| Embedding 独立表与仓储 | CAP-005 | `packages/database/src/schema/embeddings.ts`、`repositories/sqlite/memory-embedding-repository.ts` | 2026-08-26 | 单测 | `T-05` + `AST-02` |
| Embedding 迁移 Worker | CAP-005 | `apps/worker/src/embedding-migration.ts` | 2026-08-26 | typecheck | `T-05` |
| 工具注册表（契约 + 表 + 仓储） | CAP-020 | `packages/contracts/src/schemas.ts`、`packages/database/src/schema/tool-registry.ts`、`repositories/sqlite/tool-registry-repository.ts` | 2026-08-26 | 单测 | `T-04` + `AST-04` |
| 工具运行时与 API 路由（`/v1/tools`） | CAP-020 | `apps/api/src/modules/tools/` | 2026-08-26 | API 集成测试 + typecheck | `T-04` + `PET-05` |
| 插件运行时（生命周期/权限/工具联动） | CAP-020 | `apps/api/src/modules/plugins/` | 2026-08-26 | API 集成测试 + typecheck | `AST-04` |
| 插件 Config/Page 契约（Zod + OpenAPI） | CAP-020 | `packages/contracts/src/plugin-config-schemas.ts`、`packages/contracts/src/openapi.ts` | 2026-08-26 | contracts typecheck + 生成 `openapi.json` | `AST-08` + `AST-09` |
| 插件 Config/Page 存储（三表 + 仓储） | CAP-020 | `packages/database/src/schema/plugin-config.ts`、`repositories/sqlite/plugin-config-repository.ts` | 2026-08-26 | 单测（plugin-config.test.ts） | `AST-08` + `AST-09` |
| 插件配置/Page 服务与 API（CR-006） | CAP-020 | `apps/api/src/modules/plugins/`（`config-schema.ts`/`config-service.ts`/`config-routes.ts`/`bundle-store.ts`/`bridge-sdk.ts`） | 2026-08-26 | API 集成测试 + typecheck | `AST-08` + `AST-09` |
| 插件配置/Page UI（设置弹窗 + 表单 + iframe Bridge） | CAP-020 | `packages/api-client/src/useAervoxPlugins.ts`、`packages/ui/src/components/plugin/`、`packages/ui/src/components/AervoxWorkbench.vue` | 2026-08-26 | UI/Web/Desktop typecheck + build | `AST-08` + `AST-09` |
| 插件 Config/Page 规范文档化 | CAP-020 | `docs/reference/plugin-config-and-pages.md`（AVX-PLUG-001）、`docs/reference/changes/CR-006-plugin-config-and-pages.md` | 2026-08-26 | ci-docs | `AST-08` + `AST-09` |
| 可替换 Live2D 桌宠渲染层（model3.json 兼容解析 + 固定运行时资源 + PetHero 回退） | CAP-001/018 | `packages/ui/src/live2d/{model,controller,layout}.ts`、`packages/ui/src/components/Live2DPet.vue`、`packages/ui/src/components/AervoxWorkbench.vue`、`apps/web/src/App.vue`、`apps/web/index.html`、`apps/desktop/src/renderer/src/live2d/{model,controller}.ts`、`apps/desktop/src/renderer/src/components/PetWindow.vue`、`apps/desktop/src/renderer/pet.html`；mizuki 模型资产经子仓库 [3yearszhuang/live2d-mizuki](https://github.com/3yearszhuang/live2d-mizuki) 挂载于 `apps/web/public/live2d/mizuki` 与 `apps/desktop/src/renderer/public/live2d/mizuki` | 2026-08-26 | UI/Web/Desktop typecheck + build；固定资产完整性检查；Electron/Web/Pet 浏览器冒烟（无白屏、`ready`、非透明像素布局居中） | `CR-007`；Aervox 自有控制层，运行库 MIT；模型来源与再分发许可待确认 |
| 数据库迁移服务（journal + 旧库补齐 + 完成标记） | 基础设施 | `packages/database/src/migration/`、`apps/worker/src/pipeline.ts` | 2026-08-26 | 单测 | `T-06` + `AST-05` |
| 数据版本快照（快照导出/恢复） | CAP-027 | `packages/database/src/sync/git-snapshot.ts` | 2026-08-26 | 单测 | `T-09` |
| Token 用量分账 | 基础设施/埋点 | `packages/database/src/token-usage.ts` | 2026-08-26 | 单测 | `T-10` |
| 桌宠表现指令契约（emote/gesture） | CAP-001/018 | `packages/contracts/src/schemas.ts` | 2026-08-26 | typecheck | `PET-01` |
| 桌宠 emote 前端消费（PetHero） | CAP-001/018 | `packages/api-client/`、`packages/ui/src/components/PetHero.vue` | 2026-08-26 | typecheck | `PET-01` |
| 结构化记忆条目字段 | CAP-005 | `packages/database/src/schema/memories.ts`、`repositories/types.ts` | 2026-08-26 | 单测 | `PET-02` |
| 工具安全级别（read_only 白名单） | CAP-020 | `packages/contracts/src/schemas.ts`、`apps/api/src/modules/tools/runtime.ts` | 2026-08-26 | API 集成测试 | `PET-05` |
| 桌宠角色设定文档化 | CAP-019 | `docs/explanation/persona-organization.md`（AVX-EXPL-003） | 2026-08-26 | ci-docs | `T-08` |
| 桌面 preload 按域 IPC 拆分 | CAP-018 | `apps/desktop/src/preload/domains/` | 2026-08-26 | typecheck | `T-07` |
| Persona 系统级重构（去模块化 + 结合系统级 Skills/Tools/MCP + 独立 Voice 模块） | CAP-019/020 | `apps/api/src/modules/{persona,voice}/`、`packages/database/src/schema/persona.ts`、`repositories/sqlite/persona-repository.ts`、`packages/contracts/src/persona-schemas.ts` | 2026-08-27 | 单测 + API 集成测试 + ci-code | 原生 |
| Persona 设定 UI（工作台设置 + 角色列表 + 创建/编辑弹窗 + 导入导出 + 技能/工具联动） | CAP-019 | `packages/api-client/src/useAervoxPersonas.ts`、`packages/ui/src/components/persona/`、`packages/ui/src/components/AervoxWorkbench.vue` | 2026-08-27 | UI/Web/Desktop typecheck + build | `AST-03` + 原生 |
| Codex Pets 兼容：9 状态 spritesheet 协议（manifest + 8×9 atlas 渲染 + 工具状态驱动） | CAP-001/018 | `packages/contracts/src/schemas.ts`（`petSheet*`/`petManifest`）、`packages/ui/src/components/SpritePet.vue`、`apps/api/src/modules/tools/mcp.ts`（`derivePetSheetState`） | 2026-08-26 | typecheck + API 集成测试 + ci-code | 原生（外部协议兼容） |
| Skill 契约与存储（注册表 + Neo 生命周期表 + 幂等仓储） | CAP-020 | `packages/contracts/src/schemas.ts`（Skill 契约）、`packages/database/src/schema/skills.ts`、`repositories/sqlite/skill-registry-repository.ts`、`skill-lifecycle-repository.ts` | 2026-08-26 | 单测 | `Skill`（借鉴 AstrBot） |
| Skill 管理模块与 API（zip 安装 + 渐进式披露 prompt） | CAP-020 | `apps/api/src/modules/skills/`（`zip.ts`/`skill-manager.ts`/`skill-prompt.ts`/`routes.ts`） | 2026-08-26 | API 集成测试 | `Skill`（借鉴 AstrBot） |
| Skill Neo 生命周期 + `aervox_skill_*` 工具 | CAP-020 | `apps/api/src/modules/skills/`（`lifecycle.ts`/`skill-tools.ts`） | 2026-08-26 | API 集成测试 | `Skill`（借鉴 AstrBot，PET-05 安全级别） |
| 插件技能联动（只读注册 / 启停 / 卸载） | CAP-020 | `apps/api/src/modules/plugins/service.ts` | 2026-08-26 | API 集成测试 | `Skill`（借鉴 AstrBot） |
| CI 增量缓存（pnpm store + Turbo 本地缓存，只验证变更包） | 基础设施 | `.github/workflows/ci.yml` | 2026-08-26 | YAML 结构校验 + CI 实测通过（1m20s→32s） | 原生 |
| `aervox dev` 命令入口修复（`pnpm exec turbo`，修复 PATH 缺 `.bin`） | 基础设施 | `aervox` | 2026-08-26 | 启动验证（`./aervox dev web`） | 原生 |
| 全能力可选组合目标规范文档化 | CAP-020/027/031 + 基础设施 | `docs/reference/capability-composition.md`（AVX-CAP-001） | 2026-08-26 | ci-docs | `DSH-01` + `PI-01` + 原生 |
| 已集成能力迁移与 DSH/pi 接入教程文档化 | CAP-020/027 | `docs/tutorials/migrate-integrated-capabilities.md`（AVX-TUT-002） | 2026-08-26 | ci-docs | `DSH-01` + `PI-01` + 原生 |
| 文档登记强度分级（L1 编辑性 / L2 内容更新 / L3 结构性） | 基础设施（文档治理） | [doc-standards §3.1](standards/doc-standards.md#31-改动等级与同步要求)、`docs/DOC_REGISTRY.md` 维护规则、`AGENTS.md` 硬约束 | 2026-08-26 | ci-docs | 原生 |
| 文档去重：落地登记合并单源 + 导航文档精简 | 基础设施（文档治理） | [reference-design-transfer §6.1](../explanation/reference-design-transfer.md#61-落地登记唯一真源) 改为唯一真源指引（明细移入本节）、`docs/getting-started.md` §3 硬性规则改链接、`AGENTS.md` 硬约束同步 | 2026-08-26 | ci-docs | 原生 |
| 产品上限增强候选需求规格化（A/B 档） | CAP-005/009/014/015/018/019/020/027/030 | 评估成果原落于 [SRS §7]，该节随后被 main 的『SRS §7 插件配置与页面（CR-006）』取代（FR-MEM-001 等候选不再作为可引用需求源，插件规范化独立为 [AVX-PLUG-001](plugin-config-and-pages.md)）；本行保留以追溯产品评估结论 | 2026-08-26 | ci-docs | 原生（产品评估采纳） |
| 文档结构合并与速览精简（运维×3合一、工程流程×3合一、覆盖矩阵立为唯一速览、AGENTS 硬纪律内联、模板目录上移 `docs/templates`） | 基础设施（文档治理） | `docs/reference/operations.md`（AVX-OPS-001）、`docs/how-to/engineering-process.md`（AVX-GUIDE-001/003/004 合一，原 add-requirement/release-gates/run-drill 删除）、模板从 `reference/standards/templates` 迁至 `docs/templates`、`REQUIREMENTS_TRACEABILITY.md` §4 精简、`docs/DOC_REGISTRY.md`、`docs/README.md`、`docs/getting-started.md`、`AGENTS.md` 硬约束同步 | 2026-08-26 | ci-docs | 原生 |
| 新功能开发流程文档化（根级贡献指南 CONTRIBUTING，双语，替代暂存 AVX-GUIDE-004 how-to） | 基础设施（工程流程/文档治理） | [CONTRIBUTING.md](../../CONTRIBUTING.md)（融合参考项目贡献指南骨架 + 三阶段流程 + 本仓库门禁；feature-development.md 已删除并入） | 2026-08-26 | ci-docs | 原生 |

## 5. 原子需求字段模板

每条 `US/FR/BR/NFR/DATA/AIQ/SEC/PRIV/OPS` 应使用以下字段。没有影响的字段填写“不适用”并说明原因，不得留空。

| 字段 | 要求 |
|---|---|
| ID / 标题 | 唯一稳定 ID 和单一行为标题 |
| Parent CAP | 所属 `CAP-*`；允许多能力关联，但必须指定一个主能力 |
| 类型 / 状态 | 需求类型及当前生命周期状态 |
| 来源 / 理由 | 用户研究、产品目标、法规、风险或技术约束 |
| 用户 / 权限角色 | 谁能触发、查看、修改或删除 |
| 需求陈述 | 使用“当……时，系统必须……”表达一个可验证行为 |
| 前置条件 / 触发 | 状态、权限、输入和外部依赖 |
| 主流程 | 从触发到可观察结果的最短完整流程 |
| 异常与恢复 | 超时、失败、重复、取消、撤销、并发和部分成功 |
| 业务规则 | 状态转换、优先级、频率、幂等、默认值和禁止条件 |
| 输入 / 输出 | 类型、格式、大小、范围、错误信息和可访问性 |
| 数据影响 | 实体、来源、分类、保留期、索引、导出和删除传播 |
| AI 影响 | 模型任务、允许/禁止输出、评估集、阈值、失败降级和版本记录 |
| 安全与隐私 | 权限、同意、敏感数据、审计和威胁控制 |
| 非功能要求 | 性能、容量、可用性、兼容性、成本和可观测性 |
| 验收条件 | 一个或多个原子 `AC-*`，包含正常、边界和失败场景 |
| 测试与证据 | `TC-*`、自动化层级、人工验收人和证据位置 |
| 埋点与指标 | 事件名、必要字段、成功/失败定义和隐私级别 |
| 交付信息 | 优先级、目标版本、依赖、Feature Flag 和回滚方案 |
| 变更记录 | 创建/修改日期、CR、修改人及替代关系 |

推荐模板：

```markdown
### FR-LRN-001 创建学习目标

- Parent CAP：CAP-002
- 状态：Specified
- 优先级 / 目标版本：P0 / MVP
- 来源：PRD 6.1
- 前置条件：用户已完成登录并拥有可写工作区
- 需求：当用户提交合法的主题、水平和可用时间时，系统必须创建一个活动学习目标并显示其状态。
- 异常：重复提交、请求超时、写入失败、权限失效。
- 数据影响：LearningGoal；说明保留、导出和删除规则。
- 依赖：API、数据库、埋点。
- Feature Flag / 回滚：learning_goal_v1 / 关闭新建但保留已有数据读取。

#### 验收条件

- AC-FR-LRN-001-01：Given 必填字段为空，When 用户提交，Then 不创建目标并定位到具体错误字段。
- AC-FR-LRN-001-02：Given 字段合法，When 用户提交，Then 只创建一个目标并展示主题、水平、预计时长和状态。

#### 测试

- TC-E2E-LRN-001
- TC-API-LRN-001
```

## 6. Definition of Ready

需求只有在以下条件全部满足后才能从 `Specified` 进入 `Ready`：

- ID、Parent CAP、标题、优先级和目标版本已经确定。
- 用户价值、范围内和范围外行为明确，并与 PRD 一致。
- 主流程、空态、错误态、取消、重试、重复提交和并发行为明确。
- 验收条件已原子化，能够由非作者独立判断通过或失败。
- UX 流程和关键文案已评审；无障碍和响应式影响已说明。
- API、数据实体、状态转换、保留、导出、更正和删除传播已评审。
- AI 任务已定义输入、输出、禁止行为、评估集、门槛和失败降级。
- 身份、权限、隐私、安全和合规影响已完成分级；高风险项已有评审结论。
- 性能、容量、可用性、兼容性、成本和观测要求可测量。
- 外部依赖、许可证、迁移和向后兼容方案明确。
- 测试策略、埋点、Feature Flag、灰度和回滚方案已关联。
- 阻塞型 `EXP/RISK/DEC/ADR` 已关闭；豁免项有批准记录和截止日期。
- 产品、设计、工程和 QA 评审已完成并留痕；涉及数据、安全或未成年人时增加相应专业评审。

DoR 不允许以“开发中再确定”代替。确需并行探索的内容应建立 `EXP-*`，不得将实验假设伪装为 `Ready` 需求。

## 7. Definition of Done

需求只有在以下条件全部满足后才能从 `Implemented` 进入 `Verified`，并在完成发布检查后进入 `Released`：

- 实现、配置、数据库迁移和 Feature Flag 已合并并通过代码评审。
- 单元、集成、API/事件契约、E2E 和回归测试按风险级别通过。
- 涉及 AI 时，固定评估集、对抗样本和人工抽检通过，模型/提示版本可回滚。
- 涉及用户数据时，查看、导出、更正、删除、索引清理和备份处理经过验证。
- 涉及权限或外部集成时，授权、撤销、过期、越权和依赖故障测试通过。
- 性能、容量、可访问性、弱网、跨时区和兼容性达到需求阈值。
- 监控、结构化日志、指标、告警和审计记录已上线，且不泄露敏感内容。
- 发布说明、迁移说明、客服说明和必要运行手册已完成。
- 每条验收条件都有测试结果或经批准的人工证据，追踪矩阵无孤立项。
- 无未关闭的阻断/严重缺陷；接受的残余风险已有期限和批准记录。
- 灰度、回滚和数据恢复已演练；回滚不会破坏已写入数据或已发布权限承诺。
- 用户结果、测试证据与生产验证均已确认。

## 8. 测试双向追踪

### 8.1 追踪关系

```text
产品目标/场景
    -> CAP-* 生命周期能力
        -> US-* 用户故事
            -> FR/BR/NFR/DATA/AIQ/SEC/PRIV/OPS
                -> AC-* 验收条件
                    -> TC-* 测试或评估用例
                        -> CI/人工验收/生产验证证据
```

### 8.2 当前基线需求覆盖

下表把 PRD、架构、数据和 AI 专项规范中已经写成基线的跨能力要求纳入同一追踪入口。它们仍需在目标版本进入 `Ready` 前补充具体测试证据和批准记录；没有证据时不得把 `Specified` 视为已发布。

| 需求 ID | 类别 | Parent CAP | 当前状态 | 规范/来源 | AC | 测试/证据 |
|---|---|---|---|---|---|---|
| `NFR-AVAIL-001` | 可用性 | CAP-001～032 | `Specified` | [PRD NFR](PRD.md#prd-nfr) | `AC-NFR-AVAIL-001` | `TC-PERF-AVAIL-001` |
| `NFR-PERF-001` | 性能 | CAP-001～032 | `Specified` | [PRD NFR](PRD.md#prd-nfr)、[流式协议](STREAMING_PROTOCOL.md) | `AC-NFR-PERF-001` | `TC-PERF-API-001`、`TC-CONTRACT-STREAM-001` |
| `NFR-SCALE-001` | 容量 | CAP-001～032 | `Specified` | [PRD NFR](PRD.md#prd-nfr) | `AC-NFR-SCALE-001` | `TC-PERF-SCALE-001` |
| `NFR-REL-001` | 可靠性/幂等 | CAP-002/003/005/009/013 | `Specified` | [PRD NFR](PRD.md#prd-nfr) | `AC-NFR-REL-001` | `TC-RES-RETRY-001` |
| `NFR-JOB-001` | 后台任务 SLA | CAP-006/009/030 | `Specified` | [SRS](SRS.md#srs-nfr) | `AC-NFR-JOB-001` | `TC-INTEG-JOB-001` |
| `NFR-DR-001` | 灾备 | CAP-001～032 | `Specified` | [SRS](SRS.md#srs-nfr)、[架构灾备](ARCHITECTURE.md#arch-nfr) | `AC-NFR-DR-001` | `TC-RES-DR-001`、`TC-RES-LEDGER-001` |
| `NFR-A11Y-001` | 无障碍 | CAP-001/002/003/009 | `Specified` | [PRD NFR](PRD.md#prd-nfr) | `AC-NFR-A11Y-001` | `TC-A11Y-CORE-001` |
| `NFR-COMPAT-001` | 兼容性 | CAP-001/018/027 | `Mapped` | [PRD NFR](PRD.md#prd-nfr) | `AC-NFR-COMPAT-001` | `TC-E2E-COMPAT-001` |
| `NFR-I18N-001` | 国际化/时区 | CAP-006/009/030 | `Specified` | [PRD NFR](PRD.md#prd-nfr) | `AC-NFR-I18N-001` | `TC-INTEG-TZ-001` |
| `NFR-SEC-001` | 安全 | CAP-001～032 | `Specified` | [SRS](SRS.md#srs-nfr)、[数据隐私](DATA_PRIVACY.md#privacy-security) | `AC-NFR-SEC-001` | `TC-SEC-BASELINE-001` |
| `NFR-PRIV-001` | 隐私 | CAP-005/009/013/027 | `Specified` | [数据隐私](DATA_PRIVACY.md#privacy-gates) | `AC-NFR-PRIV-001` | `TC-PRIV-DEL-001` |
| `NFR-OBS-001` | 可观测性 | CAP-001～032 | `Mapped` | [架构告警](ARCHITECTURE.md#arch-nfr) | `AC-NFR-OBS-001` | `TC-OPS-OBS-001` |
| `AIQ-TEACH-001` | 教学正确性与提示层级 | CAP-002/003/007 | `Specified` | [AI 质量](AI_QUALITY_SAFETY.md#ai-teach) | `AC-AIQ-TEACH-001` | `TC-AIEVAL-LRN-001` |
| `AIQ-MEM-001` | 记忆压缩/晋升/来源 | CAP-005/015 | `Specified` | [AI 记忆](AI_QUALITY_SAFETY.md#ai-memory) | `AC-AIQ-MEM-001` | `TC-AIEVAL-MEM-001` |
| `AIQ-DIA-001` | 日记事实与时间窗口 | CAP-009 | `Specified` | [AI 日记](AI_QUALITY_SAFETY.md#ai-diary) | `AC-AIQ-DIA-001` | `TC-AIEVAL-DIA-001` |
| `AIQ-SAFE-001` | 安全分类与响应 | CAP-008/019/030 | `Specified` | [AI 安全响应](AI_QUALITY_SAFETY.md#ai-safety) | `AC-AIQ-SAFE-001` | `TC-AIEVAL-SAFE-001` |
| `DATA-MEM-001` | 记忆来源链与投影 | CAP-005 | `Specified` | [PRD 数据规则](PRD.md#prd-data) | `AC-DATA-MEM-001` | `TC-INTEG-MEM-001` |
| `DATA-DIA-001` | 日记版本/来源/缓冲 | CAP-009 | `Specified` | [PRD 数据模型](PRD.md#prd-data) | `AC-DATA-DIA-001` | `TC-INTEG-DIA-001` |
| `FR-STREAM-001` | Turn 流式响应、恢复与取消 | CAP-002/007/008 | `Specified` | [SRS 流式需求](SRS.md#srs-fr-stream)、[流式协议](STREAMING_PROTOCOL.md) | `AC-FR-STREAM-001-01～05` | `TC-CONTRACT-STREAM-001`、`TC-RES-STREAM-001`、`TC-SEC-STREAM-001`、`TC-E2E-STREAM-001` |
| `FR-PRC-001` | 练习题组、作答判定与错题派生 | CAP-003/004 | `Specified` | [SRS 练习需求](SRS.md#fr-prc-001-练习判定与错题)、[CR-008](changes/CR-008-practice-session-contract.md) | `AC-FR-PRC-001-01～07` | `TC-UNIT-PRC-001`、`TC-API-PRC-001`、`TC-INTEG-PRC-001`、`TC-E2E-PRC-001` |
| `DATA-STREAM-001` | Turn 事件保留、撤回与删除 | CAP-002/007/008/013 | `Specified` | [SRS 跨域规则](SRS.md#srs-data-stream)、[流式协议](STREAMING_PROTOCOL.md#5-重连保留与断点恢复) | `AC-DATA-STREAM-001-01～02` | `TC-PRIV-STREAM-001`、`TC-INTEG-STREAM-RET-001` |
| `DATA-DEL-001` | 删除传播与账本 | CAP-005/009/013/026/027 | `Specified` | [删除 SLA](DATA_PRIVACY.md#privacy-deletion-sla) | `AC-DATA-DEL-001` | `TC-PRIV-DEL-001` |
| `BR-CTRL-001` | 独立恢复控制账本一致性 | CAP-001～032 | `Specified` | [SRS 控制规则](SRS.md#srs-br-ctrl) | `AC-BR-CTRL-001-01～03` | `TC-RES-LEDGER-001`、`TC-SEC-REVOKE-001` |
| `SEC-PLG-001` | 插件最小权限/沙箱 | CAP-020/031 | `Mapped` | [架构插件边界](ARCHITECTURE.md#arch-ai-security) | `AC-SEC-PLG-001` | `TC-SEC-PLUG-001` |
| `SEC-TEN-001` | 工作区/数据主体/组织隔离 | CAP-001～032 | `Specified` | [SRS 租户隔离](SRS.md#srs-sec-ten)、[数据安全控制](DATA_PRIVACY.md#privacy-security) | `AC-SEC-TEN-001-01～03` | `TC-SEC-TENANT-001`、`TC-INTEG-RLS-001` |
| `PRIV-CONS-001` | 分 purpose 同意与撤销 | CAP-009/020/023/027 | `Specified` | [同意与偏好](DATA_PRIVACY.md#privacy-consent) | `AC-PRIV-CONS-001` | `TC-PRIV-CONSENT-001` |
| `PRIV-RET-001` | 召回/历史/备份期限分离 | CAP-005/009/013 | `Specified` | [召回与保留](DATA_PRIVACY.md#privacy-retention) | `AC-PRIV-RET-001` | `TC-PRIV-RET-001` |
| `OPS-QUEUE-001` | 至少一次队列与 DLQ | CAP-005/009/012/020 | `Mapped` | [架构运行约束](ARCHITECTURE.md#arch-consistency) | `AC-OPS-QUEUE-001` | `TC-RES-QUEUE-001` |
| `OPS-REL-001` | 模型/队列/存储降级与回滚 | CAP-002/005/009 | `Mapped` | [AI 回滚](AI_QUALITY_SAFETY.md#ai-rollback) | `AC-OPS-REL-001` | `TC-RES-DEGRADE-001` |

占位的 `AC-*` 和 `TC-*` 是稳定追踪 ID，不代表测试已经实现；目标版本的 G1 门禁必须把它们替换为可点击的用例、CI 任务或人工证据。若需求被取消，保留 ID 并标记 `Deprecated`，不能删除行。

反向必须能够从任一失败测试定位到 `AC-*`、原子需求、`CAP-*` 和对应产品目标。测试不得只引用需求标题或自然语言章节名。

### 8.3 测试类型

| 测试前缀 | 用途 | 典型对象 |
|---|---|---|
| `TC-UNIT` | 纯函数、状态转换和算法边界 | 调度器、TTL、评分和压缩规则 |
| `TC-API` | API、鉴权、幂等和错误契约 | 目标、消息、日记、导入导出 |
| `TC-CONTRACT` | 服务、事件和外部集成契约 | 模型适配、队列、插件和第三方题库 |
| `TC-INTEG` | 数据库、队列、索引和后台任务 | 日记任务、记忆晋升、删除传播 |
| `TC-E2E` | 用户关键路径 | 学习闭环、复习、日记纠错 |
| `TC-AIEVAL` | AI 正确性、来源、安全和压缩质量 | 教学、危机、记忆、日记、OCR |
| `TC-SEC` | 权限、攻击面和供应链 | 越权、提示注入、插件沙箱 |
| `TC-PRIV` | 同意、最小化、导出和删除 | 账户删除、撤权、来源失效 |
| `TC-PERF` | 延迟、吞吐、容量和资源使用 | 流式首字、地图规模、桌面资源 |
| `TC-RES` | 超时、重试、恢复和降级 | 模型不可用、队列积压、同步冲突 |
| `TC-A11Y` | 键盘、读屏、对比度和减少动画 | 首页、对话、练习和图谱 |
| `TC-MIG` | 模式、算法和版本迁移 | 记忆、调度、插件和本地工作区 |

### 8.4 覆盖规则

- 目标版本内的 `FR/BR/NFR/DATA/AIQ/SEC/PRIV/OPS` 必须 100% 关联至少一个 `AC-*`。
- 每个 `AC-*` 必须至少关联一个 `TC-*`；高风险验收不得只依赖人工测试。
- 每个 `TC-*` 必须反向关联至少一个需求；无需求来源的测试应补充需求或标记为探索性测试。
- P0 关键路径必须具备自动化 E2E；数据删除、权限和迁移必须具备集成测试。
- AI 指标必须记录评估集版本、样本量、领域/语言分布、标注规则、评估器版本、结果和置信区间。
- 概率型 AI 指标不得以单次手工体验代替评估；安全门槛还需要对抗测试和生产监控。
- 验收证据至少包含构建号、代码版本、环境、执行时间、结果、执行人或 CI 任务链接。

### 8.5 测试追踪记录模板

| TC ID | AC ID | Requirement ID | CAP ID | 类型 | 自动化 | 环境 | 最近结果 | 证据 |
|---|---|---|---|---|---|---|---|---|
| `TC-E2E-LRN-001` | `AC-FR-LRN-001-02` | `FR-LRN-001` | `CAP-002` | E2E | 是 | Staging | 待执行 | 待补充 |

## 9. 发布门禁

| Gate | 阶段 | 强制退出条件 | 最低证据 |
|---|---|---|---|
| `G0` | 范围立项 | 用户问题、目标指标、CAP、优先级、范围外和风险假设明确 | PRD、`EXP/RISK/DEC` |
| `G1` | 需求基线 | 版本内需求全部 `Ready`，追踪完整，无未处理阻塞决策 | DoR 清单、需求基线版本 |
| `G2` | 架构与数据 | 架构、威胁模型、数据生命周期、迁移、成本和回滚通过评审 | SAD、ADR、数据图、威胁模型 |
| `G3` | 构建完成 | 代码、迁移、静态检查和规定自动化测试通过 | CI、覆盖报告、迁移结果 |
| `G4` | Release Candidate | 产品验收、AI 评估、安全、隐私、性能、无障碍和恢复测试通过 | 验收报告、评估报告、缺陷清单 |
| `G5` | 生产发布 | 监控告警、灰度、值班、回滚、备份恢复和支持方案就绪 | 发布计划、运行手册、回滚演练 |
| `G6` | 发布后验证 | 关键路径、数据写入、指标、告警和错误预算正常 | 生产冒烟、仪表板、发布复盘 |

以下任一情况均为发布阻断项，不允许仅以“已知问题”放行：

- 记忆或日记中的用户事实无法回溯到有效来源。
- 删除未覆盖摘要、日记、记忆树、全文/向量索引或外部缓存。
- 批准的高风险安全评估集中出现危机漏判或诱导依赖输出。
- 存在严重越权、密钥泄露、远程代码执行或未修复供应链高危漏洞。
- 数据迁移不可回滚，或恢复演练无法达到已批准目标。
- 发布范围中的 P0 验收条件存在未测试或失败项。
- 模型/提示/算法版本未记录或无法回滚。
- 参考代码、模型、内容或插件的许可证和使用权未确认。
- 核心指标、错误率和安全事件没有可用埋点、监控或告警联系通道。

## 10. 风险登记

### 10.1 风险字段与评分

每项风险必须记录：`RISK-ID`、原因、风险事件、业务/用户影响、关联需求、发生概率、影响等级、评分、缓解措施、应急方案、触发条件、截止日期和状态。

- 概率 `P`：1 极低，2 低，3 中，4 高，5 极高。
- 影响 `I`：1 可忽略，2 轻微，3 中等，4 严重，5 灾难性。
- 分数 `P × I`：1～4 低，5～9 中，10～14 高，15～25 严重。
- 严重风险必须有专项评审、明确应急方案和发布门禁；不能只记录“持续关注”。

### 10.2 初始风险基线

以下评分为立项初值，应在阶段启动时复核。

| 风险 ID | 风险 | 关联能力 | P | I | 分数 | 初始缓解措施 | 状态 |
|---|---|---|---:|---:|---:|---|---|---|
| `RISK-001` | 教学幻觉、错误答案或不可验证题目进入掌握数据 | `CAP-002/003/007/011/012` | 4 | 5 | 20 | 标准题评估集、来源标注、不可验证结果禁止入库、模型回滚 | Open |
| `RISK-002` | 高风险情绪漏判、错误响应或人格覆盖安全规则 | `CAP-008/019` | 3 | 5 | 15 | 固定安全响应、独立分类、对抗集、地区化求助和审计 | Open |
| `RISK-003` | 记忆过度压缩、错误晋升、冲突合并或虚假关系 | `CAP-005/015` | 4 | 5 | 20 | 分层版本、来源链、关键约束评估、用户确认和回滚 | Open |
| `RISK-004` | 删除未传播到摘要、日记、记忆树、索引或缓存 | `CAP-005/009/013/026/027` | 3 | 5 | 15 | 删除依赖图、异步补偿、审计任务和端到端删除测试 | Open |
| `RISK-005` | 日记虚构用户经历、言论或敏感情绪并形成错误记忆 | `CAP-009` | 3 | 4 | 12 | 段落级来源、禁止无来源生成、纠错阻断晋升 | Open |
| `RISK-006` | 插件越权、恶意依赖、升级破坏或供应链攻击 | `CAP-020/031` | 3 | 5 | 15 | 沙箱、签名、最小权限、版本锁定、SBOM 和一键撤权 | Open |
| `RISK-007` | 本地与云端同步冲突造成数据丢失或权限泄露 | `CAP-023/027` | 3 | 4 | 12 | 冲突模型、不可变事件、备份恢复、加密和迁移演练 | Open |
| `RISK-008` | 未成年人、情绪/健康内容和监护可见范围不合规 | `CAP-008/028/032` | 3 | 5 | 15 | 成人首发边界、独立年龄方案、最小可见和法务评审 | Open |
| `RISK-009` | 参考代码、生成内容、题库、论文或市场内容侵权 | `CAP-011/020/021/023/024/029/031` | 3 | 4 | 12 | 许可证清单、来源记录、版权审核、下架和申诉流程 | Open |
| `RISK-010` | 模型延迟、调用成本或供应商故障破坏核心体验 | `CAP-002/003/005/009/012` | 4 | 4 | 16 | 模型路由、预算、缓存、超时降级、限流和供应商替换 | Open |
| `RISK-011` | P0-P3 范围持续扩张，导致核心闭环和安全基础延期 | `CAP-001`～`CAP-032` | 5 | 4 | 20 | 阶段基线、DoR、变更控制、容量预算和退出条件 | Open |

风险关闭必须提供风险已经消失或降低到可接受级别的证据。接受风险必须记录接受理由、有效期限和重新评估触发条件。

## 11. 变更控制

### 11.1 基线与版本

- `G1` 通过时形成版本需求基线，记录 PRD、追踪矩阵、需求和验收条件的版本。
- 文档主版本变更表示范围、权限、数据承诺或兼容性发生重大变化；次版本表示新增或实质调整需求；修订版本仅用于不改变语义的文字和链接修正。
- 优先级或目标版本变化不修改需求 ID，只更新属性并建立 `CR-*`。
- 已发布行为、数据格式、权限或删除承诺不得静默改变。

### 11.2 变更分类与决策

| 类型 | 示例 |
|---|---|
| 编辑性 | 拼写、格式、无语义变化的链接 |
| 轻微 | 文案、默认值或不改变数据/API 的局部行为 |
| 重大 | 范围、验收、数据、API、权限、指标或版本调整 |
| 紧急 | 生产安全、隐私、数据损坏或严重事故处置；先止损，一个工作日内补齐 CR 和追认 |

### 11.3 变更流程

1. 创建 `CR-*`，说明来源、原因、预期价值和不变更的后果。
2. 列出受影响的 `CAP/FR/BR/NFR/DATA/AIQ/SEC/PRIV/OPS/AC/TC`。
3. 评估 UX、API、数据迁移、权限、安全、隐私、许可证、成本、排期、指标和向后兼容。
4. 更新风险登记，并说明灰度、回滚、数据修复和用户通知方案。
5. 记录 `Approved / Rejected / Deferred / More Evidence Required` 决策。
6. 批准后同步更新需求、追踪矩阵、设计、测试、ADR、发布计划和变更日志。
7. 发布后核对实际结果；未达到预期时回滚、重新评审或建立后续 CR。

### 11.4 CR 模板

```markdown
## CR-001 变更标题

- 状态：Proposed
- 提出人 / 日期：
- 目标版本：
- 变更原因与证据：
- 关联能力与需求：
- 当前行为 / 目标行为：
- 范围外：
- UX/API/数据/AI/安全/隐私影响：
- 迁移与向后兼容：
- 测试、埋点和验收影响：
- 风险与成本：
- 灰度、回滚和用户通知：
- 决策：Approved / Rejected / Deferred / More Evidence Required
- 修改人 / 日期：
- 更新的文档和测试：
- 发布后结果：
```

## 12. 维护规则与审计

至少在每次版本立项、`G1` 基线、Release Candidate 和生产发布后复核一次矩阵。审计时重点检查：孤立需求、孤立测试、无归属风险、过期豁免、已发布但未验证的状态，以及 PRD、实现和用户实际行为之间的偏差。对矩阵内所有改动，在变更记录中更新修改人与日期。
