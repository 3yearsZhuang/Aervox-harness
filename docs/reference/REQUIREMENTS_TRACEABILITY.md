# Aervox｜思隅 需求追踪与交付质量基线

- 提出人：3yearszhuang · 2026-08-26
- 修改人：MoeJiyun233 · 2026-08-29

> 文档编号：AVX-TRC-001  
> 类型：Reference  
> 文档版本：v1.9
> 文档状态：评审候选（Review Candidate）  
> 更新日期：2026-08-29
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
| `CAP` | 生命周期能力；当前固定为 `CAP-001`～`CAP-035` | `CAP-005` 四段式记忆与记忆树 |
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
| `PRO` | 全域感知、个人画像与主动智能模式 |  |  |

### 3.3 编号规则

- `CAP-001`～`CAP-035` 与 PRD 功能地图一一对应，禁止复用或重新排序。
- 其他 ID 在各领域内单调递增；标题变化不改变 ID。
- 需求拆分时，原 ID 标为 `Deprecated`，通过 `replacedBy` 指向新 ID。
- 需求合并时，保留全部旧 ID，并通过 `supersededBy` 指向合并后的 ID。
- 优先级、目标版本和状态属于字段，不是 ID 的组成部分。

## 4. CAP-001～CAP-035 覆盖矩阵（全部能力状态唯一速览）

本矩阵是全部 35 个 CAP 的**唯一一眼速览**（DoR 细分原 §4.1 已并入本表；批次顺序见[能力拆分路线](../explanation/roadmap.md)）。当前状态依据 PRD 中是否已有独立、可测试的详细行为和验收条件判定。

- `当前状态`：`Mapped`＝未完整规格；`Specified`＝已规格未过 DoR。`Specified` 仍不等于 `Ready`，进入开发前必须继续拆分原子需求并通过 DoR；
- `DoR 就绪`：按 [§6 Definition of Ready](#6-definition-of-ready) 评估；未规格 CAP 为 `—`，进入 `Specified` 后回填；
- `落地`：✔＝该 CAP 在 [§4.2 落地实现登记](#42-落地实现登记) 已有代码/运行时实现条目（纯文档治理条目不计）；`—`＝尚无；
- TC 覆盖占位 ID 不再在此重复，测试追踪见 [§8.2](#82-当前基线需求覆盖) 与[测试策略](TEST_STRATEGY.md)。

| 能力 ID | 能力 | 优先级 · 交付阶段 | 当前状态 | DoR 就绪 | 落地 | PRD 依据 | 达到下一状态所需工作 |
|---|---|---|---|---|---|---|---|
| `CAP-001` | 桌宠入口 | `P0 · R1` | `Specified` | Not Ready | ✔ | [首页工作台](PRD.md#prd-home)、[视觉小说式对话形态](PRD.md#prd-conversation-ui)、[CR-005](changes/CR-005-shared-workbench-web-without-pet.md)、[CR-007](changes/CR-007-live2d-sekai-viewer-pet.md) | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready`；Web/Desktop 表现层边界按 CR-005/CR-007 验证 |
| `CAP-002` | 学习目标与对话 | `P0 · R1` | `Specified` | Not Ready | ✔ | [学习目标](PRD.md#prd-cap-002)、[引导式学习对话](PRD.md#prd-cap-007) | 拆分 `FR/BR/AC`，明确会话状态、并发修改、归档和恢复规则 |
| `CAP-003` | 互动刷题 | `P0 · R1` | `Specified` | Not Ready | — | [互动练习与错题本](PRD.md#prd-cap-003-004) | 已由 [CR-008](changes/CR-008-practice-session-contract.md) 与 [CR-013](changes/CR-013-practice-session-recovery.md) 补齐题目选择、快照、恢复、幂等和完成边界；新增 CR-020 guidance E2E + 错因筛选 E2E + 刷题闭环 E2E；仍需评审证据后推进 Ready |
| `CAP-004` | 错题本 | `P0 · R1` | `Specified` | Not Ready | — | [互动练习与错题本](PRD.md#prd-cap-003-004)、[CR-009](changes/CR-009-mistake-book-dismissal.md)、[CR-018](changes/CR-018-mistake-insight-workflow.md) | 错因记录与筛选已进入实现；仍需补重复题合并的产品决策，以及 E2E 与评审证据 |
| `CAP-005` | 四段式记忆与记忆树 | `P0 · R1–R2` | `Specified` | Not Ready | ✔ | [四段式记忆与记忆树](PRD.md#prd-cap-005) | 拆分各层状态转换、TTL、压缩、冲突、删除、重建和迁移测试 |
| `CAP-006` | 间隔重复 | `P0 · R1` | `Specified` | Not Ready | — | [间隔复习](PRD.md#prd-cap-006)、[CR-010](changes/CR-010-review-completion-idempotency.md)、[CR-011](changes/CR-011-timezone-safe-review-scheduling.md) | AC-FR-REV-001-03 已闭环（DST·跨时区·逾期汇总全覆盖）；仍需长期算法升级和批量历史重算策略 |
| `CAP-007` | 文本与代码答疑 | `P0 · R1` | `Specified` | Not Ready | ✔ | [引导式学习对话](PRD.md#prd-cap-007) | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready`（讲解触发复用 `FR-CONV-001`） |
| `CAP-008` | 情绪价值与安全陪伴 | `P0 · R1` | `Specified` | Not Ready | — | [关系与情绪边界](PRD.md#prd-safety-boundary)、[轻量陪伴](PRD.md#prd-cap-008) | 固定风险分级、地区化求助入口、审计、误报处置和安全回归集 |
| `CAP-009` | AI 每日日记 | `P0 · R1.5` | `Specified` | Not Ready | ✔ | [AI 每日日记](PRD.md#prd-cap-009)、[日记与记忆层的关系](PRD.md#prd-diary-memory)、[CR-026](changes/CR-026-on-demand-diary.md) | 对话触发路径已落地（CR-026 §4.2）；定时任务幂等、重试、版本冲突、来源快照、通知和时区边界测试仍待阶段 2 |
| `CAP-010` | 人格问卷与基础偏好 | `P0 · R1.5` | `Specified` | Not Ready | ✔ | [全生命周期功能地图](PRD.md#prd-cap-map)、[P0 最低验收](PRD.md#prd-cap-001-010-013) | 实现已落地（PR #64 §4.2）；进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready` |
| `CAP-011` | 学习资料整理 | `P0 · R1.5` | `Specified` | Not Ready | ✔ | [全生命周期功能地图](PRD.md#prd-cap-map)、[P0 最低验收](PRD.md#prd-cap-001-010-013) | 实现已落地（PR #64 §4.2）；进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready` |
| `CAP-012` | 多模态答疑 | `P0 · R1.5` | `Specified` | Not Ready | ✔ | [全生命周期功能地图](PRD.md#prd-cap-map)、[P0 最低验收](PRD.md#prd-cap-001-010-013) | 实现已落地（PR #64 §4.2）；进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready` |
| `CAP-013` | 消息编辑、删除与引用 | `P0 · R1.5` | `Specified` | Not Ready | ✔ | [学习记录与数据控制](PRD.md#prd-cap-013)、[P0 最低验收](PRD.md#prd-cap-001-010-013) | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready` |
| `CAP-014` | 层级对话与会话地图 | `P1 · R2` | `Mapped` | — | ✔ | [P1 验收原则](PRD.md#prd-cap-014-019) | 实现已落地（PR #64 §4.2）；仍补分支归属、删除决策、布局恢复和大图性能验收并推进 `Specified` |
| `CAP-015` | 思维宇宙 | `P1 · R2` | `Mapped` | — | ✔ | [P1 验收原则](PRD.md#prd-cap-014-019) | 实现已落地（PR #64 §4.2）；仍补节点/边类型、证据、纠错传播、版本和可视化交互验收并推进 `Specified` |
| `CAP-016` | 自适应刷题与报告 | `P1 · R2` | `Mapped` | — | ✔ | [P1 验收原则](PRD.md#prd-cap-014-019)、[CR-020](changes/CR-020-deterministic-practice-guidance.md) | CR-020 已落地确定性练习反馈与下一轮建议（用时/提示数观测 + guidance 规则 + 报告展示）；仍补算法升级、冷启动策略和偏差评估并推进 `Specified` |
| `CAP-017` | 考试日计划 | `P1 · R2` | `Mapped` | — | ✔ | [P1 验收原则](PRD.md#prd-cap-014-019) | 实现已落地（PR #64 §4.2）；仍补计划生成约束、滚动调整、冲突、跳过、过期和完成定义并推进 `Specified` |
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
| `CAP-028` | 社区互助 | `P3 · R5` | `Mapped` | — | — | [P3 验收原则](PRD.md#prd-cap-028-033) | 补角色、发布/回答状态机、信誉、举报申诉、审核 SLA 和未成年保护 |
| `CAP-029` | 名词解释网页 | `P3 · R5` | `Mapped` | — | — | [P3 验收原则](PRD.md#prd-cap-028-033) | 补发布、更新、撤回、来源失效、SEO/分享、隐私预览和版权规则 |
| `CAP-030` | 主动提醒深化 | `P3 · R5` | `Mapped` | — | — | [P3 验收原则](PRD.md#prd-cap-028-033) | 补触发优先级、频控、去重、解释、免打扰、跨端和退订验收 |
| `CAP-031` | 内容与技能市场 | `P3 · R5` | `Mapped` | — | — | [P3 验收原则](PRD.md#prd-cap-028-033) | 补商品、版本、审核、结算、退款、下架、许可证和供应链治理 |
| `CAP-032` | 机构与监护模式 | `P3 · R5` | `Mapped` | — | — | [P3 验收原则](PRD.md#prd-cap-028-033) | 补组织角色、邀请/移除、授权报表、最小可见、审计和监护同意 |
| `CAP-033` | 全域感知与个人画像（主动智能模式） | `P3 · R5` | `Specified` | Not Ready | ✔（本地 Vault、十二项派生、授权动作、部分来源、导出） | [PRD CAP-033](PRD.md#prd-cap-033)、[CR-023](changes/CR-023-proactive-local-intelligence-mode.md)、[CR-024](changes/CR-024-proactive-intelligence-suite-integrations.md)、[ADR-018](adr/ADR-018-proactive-local-privacy-host.md) | 十二项本地派生、日/周回顾和仪表盘已验证；应用活动正文、通信、音视频、位置等平台 Provider、生产 OS Broker 和全链本地证明仍未闭合，保持 `Not Ready` |
| `CAP-034` | Home Assistant 家庭环境连接 | `P3 · R5` | `Specified` | Not Ready | ✔ | [PRD CAP-034](PRD.md#prd-cap-034)、[CR-024](changes/CR-024-proactive-intelligence-suite-integrations.md)、[ADR-019](adr/ADR-019-proactive-integrations-local-gateway.md) | REST/WS Client、私网校验、实体/service 白名单、Agent 工具、动作审计与撤销删除已验证；生产重连、OAuth 和 HA 版本矩阵仍待门禁 |
| `CAP-035` | 运动健康信号连接 | `P3 · R5` | `Specified` | Not Ready | ✔ | [PRD CAP-035](PRD.md#prd-cap-035)、[CR-024](changes/CR-024-proactive-intelligence-suite-integrations.md)、[ADR-019](adr/ADR-019-proactive-integrations-local-gateway.md) | 小米官方开放平台通用适配、Token 刷新、每日指标、只读工具与撤销删除已验证；厂商账号审批、真实沙箱契约和长期兼容测试仍待完成 |

矩阵状态按 §12 维护规则更新：`Verified` 证据核实与 `Released` 状态确认留痕；任何状态变化必须在变更记录中留下日期与修改人。

**DoR 清单逐项结论（[§6](#6-definition-of-ready) 12 项）**：当前 16 个 `Specified` CAP 均未全部满足（`CAP-018`、`CAP-033`～`CAP-035` 尚未完成 DoR 评估，进入发布批次前补齐）。共性未满足项：

- `TC-*` 为稳定占位 ID，无关联代码/CI/人工证据（见[测试策略 §6](TEST_STRATEGY.md#6-当前阻断)）；
- API/数据实体/状态转换/UX 原型评审未完成；
- 埋点与指标事件未定义；
- 阻塞型 `EXP/RISK/DEC/ADR` 未全部关闭。

满足 DoR 的路径：按[工程与发布流程 §1](../how-to/engineering-process.md#1-新增与修改需求)补齐字段与证据，在对应批次启动时逐 CAP 关闭上述阻断项并推进 `Ready`。

### 4.2 落地实现登记

本节是**整个项目**代码落地完成情况的追踪事实源（约束见 [AGENTS.md](../../AGENTS.md)）。凡已合并的实现，无论是否完成 DoR/DoD 门禁，均须在此登记；门禁状态（§4 矩阵的 `当前状态` 列）仍按 §6/§7 单独推进，两者不互相替代。未登记的落地视为未闭环、提交打回。

登记规则：`关联 CAP` 表实现所属能力；`验证` 表已通过的自动化验证（测试/typecheck）；`来源` 标注参考设计（`T-*`/`AST-*`/`PET-*`/`DSH-01`/`PI-01`，细则见 [参考设计迁移文档 §6.1](../explanation/reference-design-transfer.md#61-落地登记唯一真源)）或原生实现。

| 落地实现 | 关联 CAP | 实现位置 | 日期 | 验证 | 来源 |
|---|---|---|---|---|---|
| 桌面端首次启动引导（四步序章、Live2D、模型测试/保存、快速开始与版本化完成标记） | CAP-001/018 | `apps/desktop/src/renderer/src/{App.vue,onboarding-model.ts,onboarding-state.ts,components/OnboardingFlow.vue}`、`apps/desktop/test/{onboarding-model,onboarding-state}.test.ts` | 2026-08-29 | Desktop 单元测试（首次启动、严格完成标记、完成写入、提供商预设、模型配置校验）；Desktop build/typecheck | 原生（视觉结论见 `CR-024` 与原型提交 `050f1f0`） |
| 错题本聚合、掌握标记与错题重练 | CAP-003/004 | `apps/api/src/modules/learning/routes.ts`、`packages/database/src/repositories/{types,sqlite/learning-repository}.ts`、`packages/api-client/src/useAervoxApi.ts`、`packages/ui/src/components/AervoxWorkbench.vue` | 2026-08-26 | `mistake-book.test.ts` 集成测试；API/API Client/UI 类型检查 | 原生 |
| 练习会话与结果报告 | CAP-003/004/006 | `apps/api/src/modules/learning/routes.ts`、`packages/database/src/schema/learning.ts`、`packages/database/src/repositories/sqlite/learning-repository.ts`、`packages/api-client/src/useAervoxApi.ts`、`packages/ui/src/components/AervoxWorkbench.vue` | 2026-08-26 | `practice-session.test.ts` 集成测试；学习路由类型检查 | 原生 |
| 活跃练习会话恢复与续答 | CAP-003 | `packages/practice-review/src/session.ts`、`apps/api/src/modules/learning/routes.ts`、`packages/database/src/repositories/{types,sqlite/learning-repository}.ts`、`packages/contracts/src/{practice-schemas,openapi}.ts`、`packages/api-client/src/{transport,desktop-transport,useAervoxApi}.ts`、`apps/desktop/src/{main,preload}/`、`packages/ui/src/components/AervoxWorkbench.vue` | 2026-08-28 | `session.test.ts` 单元测试（去重、未答索引、全答与空题组）；`transport.test.ts` 单元测试（幂等键透传）；`practice-session.test.ts` 集成测试（快照、续答进度、重试复用、租户隔离、结束后不可恢复）；Contracts/Database/API Client/Desktop/UI 类型检查 | 原生 |
| 练习作答 OpenAPI 幂等契约对齐 | CAP-003/004 | `packages/contracts/src/{practice-schemas,openapi}.ts`、`packages/contracts/openapi.json`、`apps/api/test/openapi-contract.test.ts` | 2026-08-27 | `@aervox/contracts` build 生成 OpenAPI；`openapi-contract.test.ts` 契约测试 | 原生 |
| 互动刷题端到端测试覆盖 | CAP-003/004/016 | `e2e/practice-guidance-and-insights.spec.ts` | 2026-08-28 | CR-020 guidance 三分支 E2E（increase/ease/maintain + 用时未知不升级 + GET 报告一致性）；CR-018 错因标注与筛选 E2E（reasonCode 筛选/非法值校验/frequent 排序/latestAttemptAt/清除错因）；刷题完整闭环 E2E（练习→错题→标注→筛选→重练→报告） | 原生 |
| 错题忽略/恢复处置 | CAP-004 | `apps/api/src/modules/learning/routes.ts`、`packages/database/src/schema/{learning,init}.ts`、`packages/database/src/repositories/sqlite/learning-repository.ts`、`packages/api-client/src/useAervoxApi.ts` | 2026-08-27 | `mistake-book.test.ts` 集成测试；Database/API/UI 类型检查 | 原生 |
| 错题错因记录、筛选与工作台编辑 | CAP-004 | `packages/practice-review/src/mistake-insight.ts`、`packages/database/src/schema/{learning,init}.ts`、`packages/database/src/repositories/{types,sqlite/learning-repository}.ts`、`packages/contracts/src/{practice-schemas,openapi}.ts`、`apps/api/src/modules/learning/routes.ts`、`packages/api-client/src/useAervoxApi.ts`、`packages/ui/src/components/AervoxWorkbench.vue` | 2026-08-28 | `mistake-insight.test.ts` 单元测试；`mistake-book.test.ts` 集成测试（保存、筛选、清空、隔离、学习事实不变）；`openapi-contract.test.ts` 契约测试；Database/Contracts/API/API Client/UI 类型检查 | 原生 |
| 复习完成幂等重放、历史查询与工作台操作 | CAP-006 | `apps/api/src/modules/learning/routes.ts`、`packages/database/src/{schema,repositories}/`、`packages/contracts/src/`、`packages/api-client/src/useAervoxApi.ts`、`packages/ui/src/components/AervoxWorkbench.vue` | 2026-08-27 | API 集成测试与 OpenAPI 回归测试；Database/API Client/UI 类型检查 | 原生 |
| 时区安全的复习调度与逾期汇总 | CAP-006 | `packages/practice-review/src/answer.ts`、`apps/api/src/modules/learning/routes.ts`、`packages/database/src/`、`packages/api-client/src/`、`packages/ui/src/components/AervoxWorkbench.vue` | 2026-08-28 | DST 单元测试（春/秋季切换·南半球·无 DST·跨时区）；API 集成测试（逾期不重复·从完成时间重算·时区快照·汇总分类）；覆盖 AC-FR-REV-001-03 | 原生 |
| 确定性练习反馈与下一轮建议 | CAP-016 | `packages/practice-review/src/guidance.ts`、`apps/api/src/modules/learning/routes.ts`、`packages/contracts/src/practice-schemas.ts`、`packages/database/src/repositories/`、`packages/api-client/src/useAervoxApi.ts`、`packages/ui/src/components/AervoxWorkbench.vue`、`packages/ui/src/theme/workbench.css` | 2026-08-28 | guidance 单元测试（边界/零作答/精确阈值/未知数据）；practice-session 集成测试（输入校验·ease/maintain/increase 三分支·用时未知不升难度·幂等保留首值·重复结束一致·租户隔离）；全仓 typecheck | 原生 |
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
| Persona 去模块化收尾：移除 `modules/persona-plugin` 子模块（`.gitmodules`/README/能力注册表/CI 同步） | CAP-019/020 | `modules/persona-plugin` 移除、`.gitmodules`、`README.md`、`docs/reference/capability-registry.md`、`docs/reference/DATABASE.md`、`.github/workflows/ci.yml` | 2026-08-28 | pnpm install + ci-code；仓库无 `@aervox/mod-persona` 消费方 | 原生 |
| Persona 设定 UI（工作台设置 + 角色列表 + 创建/编辑弹窗 + 导入导出 + 技能/工具联动） | CAP-019 | `packages/api-client/src/useAervoxPersonas.ts`、`packages/ui/src/components/persona/`、`packages/ui/src/components/AervoxWorkbench.vue` | 2026-08-27 | UI/Web/Desktop typecheck + build | `AST-03` + 原生 |
| 本地语音模型配置（CR-014 阶段 1：设置配置 + 持久化 + 白名单校验） | CAP-019/020 | `packages/database/src/schema/voice.ts`、`repositories/sqlite/voice-config-repository.ts`、`packages/contracts/src/persona-schemas.ts`、`apps/api/src/modules/voice/`、`packages/api-client/src/useAervoxVoice.ts`、`packages/ui/src/components/voice/LocalVoiceConfigPanel.vue` | 2026-08-28 | Database 单测 + API 集成测试；API Client/UI typecheck | 原生 |
| 人格编辑「语音」能力块（CR-014 阶段 2：人格语音选择 + 试听，写入 `PersonaRevisionConfig.voice`） | CAP-019/020 | `packages/ui/src/components/persona/{VoiceAbilityCard,PersonaEditDialog}.vue`（复用既有 `config.voice` 契约与 `useAervoxVoice`） | 2026-08-28 | UI typecheck + build | 原生 |
| 语音目录选择（CR-014 阶段 3：模型路径与音色支持手输 + 系统「选择文件夹」并存） | CAP-019/020 | `apps/desktop/src/{main/index.ts,preload/domains/dialog-api.ts,preload/index.ts}`、`packages/api-client/src/useAervoxVoice.ts`、`packages/ui/src/components/{voice/LocalVoiceConfigPanel,persona/VoiceAbilityCard}.vue` | 2026-08-28 | API Client/UI/Web/Desktop typecheck + build | 原生 |
| WebUI 大语言模型与供应商配置（CR-015：设置配置 + 连通性测试 + 租户持久化） | CAP-020 / ADR-005 | `packages/database/src/schema/llm.ts`、`repositories/sqlite/llm-config-repository.ts`、`packages/contracts/src/llm-schemas.ts`、`apps/api/src/modules/llm/`、`packages/api-client/src/useAervoxLLM.ts`、`packages/ui/src/components/llm/LLMConfigPanel.vue`、`packages/ui/src/components/AervoxWorkbench.vue` | 2026-08-28 | Database/API 单测与集成测试（`llm-config.test.ts`）；API Client/UI/Web typecheck + build | 原生 |
| 离线语音输入 ASR（CR-016：SenseVoice/Whisper 双模式 + 句子级断句 + 键盘自停） | CAP-019/020 / ADR-005 | `packages/database/src/schema/voice.ts`、`repositories/sqlite/voice-input-config-repository.ts`、`packages/contracts/src/persona-schemas.ts`、`apps/api/src/modules/voice/`、`packages/api-client/src/{voice-input-recorder.ts,useAervoxVoiceInput.ts}`、`packages/ui/src/components/{voice/LocalVoiceConfigPanel.vue,AervoxWorkbench.vue}` | 2026-08-28 | Database/API 单测与集成测试（`voice-config.test.ts`, `voice-input.test.ts`）；API Client/UI/Web typecheck + build；PR #57 安全/契约整改（转写 503 不吞错误 + endpoint 校验）+ 全库吞错误专项排查（见 CR-016 核查记录） | 原生（借鉴 dsh-voice-local） |
| Codex Pets 兼容：9 状态 spritesheet 协议（manifest + 8×9 atlas 渲染 + 工具状态驱动） | CAP-001/018 | `packages/contracts/src/schemas.ts`（`petSheet*`/`petManifest`）、`packages/ui/src/components/SpritePet.vue`、`apps/api/src/modules/tools/mcp.ts`（`derivePetSheetState`） | 2026-08-26 | typecheck + API 集成测试 + ci-code | 原生（外部协议兼容） |
| Skill 契约与存储（注册表 + Neo 生命周期表 + 幂等仓储） | CAP-020 | `packages/contracts/src/schemas.ts`（Skill 契约）、`packages/database/src/schema/skills.ts`、`repositories/sqlite/skill-registry-repository.ts`、`skill-lifecycle-repository.ts` | 2026-08-26 | 单测 | `Skill`（借鉴 AstrBot） |
| Skill 管理模块与 API（zip 安装 + 渐进式披露 prompt） | CAP-020 | `apps/api/src/modules/skills/`（`zip.ts`/`skill-manager.ts`/`skill-prompt.ts`/`routes.ts`） | 2026-08-26 | API 集成测试 | `Skill`（借鉴 AstrBot） |
| Skill Neo 生命周期 + `aervox_skill_*` 工具 | CAP-020 | `apps/api/src/modules/skills/`（`lifecycle.ts`/`skill-tools.ts`） | 2026-08-26 | API 集成测试 | `Skill`（借鉴 AstrBot，PET-05 安全级别） |
| 插件技能联动（只读注册 / 启停 / 卸载） | CAP-020 | `apps/api/src/modules/plugins/service.ts` | 2026-08-26 | API 集成测试 | `Skill`（借鉴 AstrBot） |
| CI 增量缓存（pnpm store + Turbo 本地缓存，只验证变更包） | 基础设施 | `.github/workflows/ci.yml` | 2026-08-26 | YAML 结构校验 + CI 实测通过（1m20s→32s） | 原生 |
| `aervox dev` 命令入口修复（`pnpm exec turbo`，修复 PATH 缺 `.bin`） | 基础设施 | `aervox` | 2026-08-26 | 启动验证（`./aervox dev web`） | 原生 |
| 全能力可选组合目标规范文档化 | CAP-020/027/031 + 基础设施 | `docs/reference/capability-composition.md`（AVX-CAP-001） | 2026-08-26 | ci-docs | `DSH-01` + `PI-01` + 原生 |
| 已集成能力迁移与 DSH/pi 接入教程文档化 | CAP-020/027 | `docs/tutorials/migrate-integrated-capabilities.md`（AVX-TUT-002） | 2026-08-26 | ci-docs | `DSH-01` + `PI-01` + 原生 |
| Agent Harness Loop 目标规范与迁移计划文档化 | CAP-002/005/007/008/019/020/027 + 基础设施 | `docs/reference/agent-harness-loop.md`（AVX-HAR-001）、`docs/reference/changes/CR-012-agent-harness-loop.md` | 2026-08-28 | ci-docs | `DSH-01` + `PI-01` + 原生 |
| 文档治理与事实源标准化（AVX-DOC-GOV-001 / CR-017） | 基础设施（文档治理） | `docs/reference/document-governance.md`、`docs/_meta/document-policy.json`、`scripts/docs-governance.mjs`、`mise.toml`、`.github/workflows/docs.yml`；同步 `docs/README.md`、`docs/DOC_REGISTRY.md`、`docs/getting-started.md`、`docs/reference/standards/doc-standards.md`、`README.md`、`CONTRIBUTING.md`、`AGENTS.md` | 2026-08-28 | `mise tasks run docs-validate`；`mise tasks run ci-docs`；`git diff --check` | 原生 |
| 文档登记强度分级（L1 编辑性 / L2 内容更新 / L3 结构性） | 基础设施（文档治理） | [doc-standards §3.1](standards/doc-standards.md#31-改动等级与同步要求)、`docs/DOC_REGISTRY.md` 维护规则、`AGENTS.md` 硬约束 | 2026-08-26 | ci-docs | 原生 |
| 文档去重：落地登记合并单源 + 导航文档精简 | 基础设施（文档治理） | [reference-design-transfer §6.1](../explanation/reference-design-transfer.md#61-落地登记唯一真源) 改为唯一真源指引（明细移入本节）、`docs/getting-started.md` §3 硬性规则改链接、`AGENTS.md` 硬约束同步 | 2026-08-26 | ci-docs | 原生 |
| 产品上限增强候选需求规格化（A/B 档） | CAP-005/009/014/015/018/019/020/027/030 | 评估成果原落于 [SRS §7]，该节随后被 main 的『SRS §7 插件配置与页面（CR-006）』取代（FR-MEM-001 等候选不再作为可引用需求源，插件规范化独立为 [AVX-PLUG-001](plugin-config-and-pages.md)）；本行保留以追溯产品评估结论 | 2026-08-26 | ci-docs | 原生（产品评估采纳） |
| 文档结构合并与速览精简（运维×3合一、工程流程×3合一、覆盖矩阵立为唯一速览、AGENTS 硬纪律内联、模板目录上移 `docs/templates`） | 基础设施（文档治理） | `docs/reference/operations.md`（AVX-OPS-001）、`docs/how-to/engineering-process.md`（AVX-GUIDE-001/003/004 合一，原 add-requirement/release-gates/run-drill 删除）、模板从 `reference/standards/templates` 迁至 `docs/templates`、`REQUIREMENTS_TRACEABILITY.md` §4 精简、`docs/DOC_REGISTRY.md`、`docs/README.md`、`docs/getting-started.md`、`AGENTS.md` 硬约束同步 | 2026-08-26 | ci-docs | 原生 |
| ESP32-S3 物理桌宠硬件延伸方案（恢复并完善） | CAP-001/018（候选；设备能力待 CR 立项） | `docs/explanation/esp32-s3-hardware-extension.md`（AVX-EXPL-005） | 2026-08-28 | ci-docs；外部模组数据手册核对 | 原生设计提案 |
| 新功能开发流程文档化（根级贡献指南 CONTRIBUTING，双语，替代暂存 AVX-GUIDE-004 how-to） | 基础设施（工程流程/文档治理） | [CONTRIBUTING.md](../../CONTRIBUTING.md)（融合参考项目贡献指南骨架 + 三阶段流程 + 本仓库门禁；feature-development.md 已删除并入） | 2026-08-26 | ci-docs | 原生 |
| Agent Harness Loop 阶段 0+1：契约冻结 + 无工具单 Step Loop（Replay 驱动，替换固定 done SSE） | CAP-002/007 + 基础设施 | `packages/agent-loop`（Ports/Executor/Replay Provider/内存 Store/契约测试）、`packages/database` conversation-repository（`claimTurnAttempt` CAS+fencing / `finalizeTurnAttempt` / `appendStreamEvent` 扩展 attempt/safetyDecision）、`apps/api` conversation routes（POST turn 建 Attempt + `executeTurn`，SSE 改重放 `turn_stream_events`） | 2026-08-28 | `@aervox/agent-loop` 5 单测（确定性序列/幂等重放/CAS）+ `apps/api` conversation-loop 集成测试（POST turn → message→delta→done，重连幂等）；ci-code 全量 | `DSH-01` + 原生 |
| 可选模块方案并入能力组合体系（AVX-MOD-001 提升为必选机制） | 基础设施（文档治理） | [AVX-CAP-001](capability-composition.md) 新增「交付载体与自选机制（必选）」（不变量/双轴/接口边界/判定准则）、新建 [AVX-CAP-REG-001](capability-registry.md) 能力注册表、[AVX-GUIDE-003](../how-to/submodule-collaboration.md) 并入生命周期门禁 §8、删除 `docs/explanation/optional_modules.md` 并同步索引/登记表/教程/CR 引用；README 按项目现状更新 | 2026-08-28 | ci-docs | 原生 |
| Agent Harness Loop 阶段 2a-2c：只读工具多 Step Loop（核心控制流，脚本化 Replay 驱动） | CAP-002/007/020 + 基础设施 | `packages/agent-loop`（`ToolProviderPort` + 只读 mock 工具、Step 状态机与 `ToolCallRequest/Result` 扩展、`executeTurn` 多 Step 循环：白名单 fail-closed + 去重 + 超时 + maxSteps 终止 + 工具结果回填上下文）、脚本化 Replay Provider、7 项工具路径契约测试 | 2026-08-28 | `@aervox/agent-loop` 12 测试（含阶段 1 回归）；ci-code 全量 | `DSH-01` + 原生 |
| Agent Harness Loop 阶段 2d：API 接线（只读白名单适配 ToolRuntime）+ 工具执行账本 `tool_executions` | CAP-002/007/020 + 基础设施 | `packages/database`（`tool_executions` 表/schema/init + `recordToolExecution`/`listToolExecutionsByTurn`）、`packages/agent-loop`（`ExecutionStorePort.recordToolExecution` 副作用证据 + 事件账本断言）、`apps/api`（`createRuntimeToolProvider` 只读白名单 fail-closed、`runLoopTurnOnce` env 开关、SSE 透传 tool 事件、buildApp 暴露 toolRuntime） | 2026-08-28 | `@aervox/agent-loop` 12 测试（含账本断言）；`apps/api` 81 测试（含 conversation-tool-loop 2：SSE tool 事件 + 账本 executed/rejected）；ci-code 全量 | `DSH-01` + 原生 |
| Agent Harness Loop 阶段 2e：真实模型 Provider（OpenAI 兼容流，复用 CR-015 LLM 配置） | CAP-002/007/020 + 基础设施 | `packages/agent-loop`（`createOpenAICompatProvider`：`/chat/completions` SSE 流、content/tool_calls delta 分片累积、`[DONE]`/finish_reason 收尾、`ModelRequest.tools` 注入只读工具 schema）、`apps/api`（`AERVOX_LOOP_PROVIDER=llm` 从 `LLMConfigService` 构造 provider，anthropic 明示不支持；未就绪写 error 事件 + Failed 不静默回退） | 2026-08-28 | `@aervox/agent-loop` 16 测试（含 mock fetch 流解析 4）；`apps/api` 83 测试（含 conversation-llm 2：SSE delta+done / anthropic_unsupported error）；ci-code 全量 | 原生 |
| Agent Harness Loop 阶段 3a：写工具审批通道（write_with_approval 授权决断 + 授权快照） | CAP-002/007/020 + 基础设施 | `packages/database`（`tool_approvals` 表/schema/init + `recordToolApproval`/`decideToolApproval`/`listToolApprovalsByTurn`/`findGrantedToolApproval`）、`packages/agent-loop`（`needsApproval` 语义 + `tool_approval_*` 事件 + 账本 `pending_approval` + 写工具 mock）、`apps/api`（adapter 写工具分支：参数哈希匹配 granted→执行，否则 pending+needsApproval；`POST /v1/turns/:id/tool-approvals` 端点；scripted-write 脚本） | 2026-08-28 | `@aervox/agent-loop` 18 测试（含 approval-loop）；`apps/api` 86 测试（含 conversation-approval 3：未决/grant 重发执行/deny 仍挂）；ci-code 全量 | 原生 + `DSH-01` 借鉴 |
| Agent Harness Loop 阶段 3b-A：租约 TTL 与续租（CAS 续租 + Step 间持有） | CAP-002/007 + 基础设施 | `packages/database`（`turn_attempts.lease_expires_at` 列 + init `addColumnIfMissing` 幂等补齐 + `claimTurnAttempt` 写 TTL + `renewTurnAttemptLease` 续租 CAS）、`packages/agent-loop`（`ExecutionStorePort.renewAttemptLease` + executor Step 间续租 + 续租断言）、`apps/api`（Sqlite 适配续租） | 2026-08-28 | `@aervox/agent-loop` 18 测试（含续租断言 single=0/tool=1）；`packages/database` 107 测试（含 conversation-lease 3：claim TTL / CAS 续租 / 错误 leaseId 拒绝）；ci-code 全量 | 原生 |
| Agent Harness Loop 阶段 3b-B：租约抢占 + worker 恢复 cycle + fencing 单一终态 | CAP-002/007 + 基础设施 | `packages/database`（`claimTurnAttempt` 抢占语义：Running+fencing+租约空/过期才可领；`finalizeTurnAttempt` 单一终态：仅 Running + fencing 匹配可提交；`recoverExpiredAttempts`：过期 Running → fencing+1 + Interrupted）、`packages/agent-loop`（Step 首部租约活性校验：续租即探活，抢占后 lease_lost 中止并丢弃迟到事件；in-memory `simulateLeaseLoss`）、`apps/worker`（`attempt-recovery` cycle 接入 runTick） | 2026-08-28 | `@aervox/agent-loop` 19 测试（含 lease-guard 2：抢占中止+迟到丢弃 / finalize 单一终态）；`packages/database` 111 测试（含 conversation-lease 7：抢占不可/可、过期重领、finalize 拒绝二次提交、recover 恢复）；ci-code 全量 | 原生 |
| 对话触发写日记（aervox_diary_write）与日记/审批契约补全 | CAP-009 | `apps/api/src/modules/diary/{generation,material,diary-write-tool,index}.ts`、`packages/agent-loop/src/{base-prompt,executor,openai-compat-provider,subagent-contribution}.ts`、`packages/contracts/src/{schemas,openapi,index}.ts`、`packages/database/src/repositories/{types,sqlite/diary-repository}.ts`、`packages/api-client/src/{transport,desktop-transport,useAervoxTurn,useAervoxApi,index}.ts`、`packages/ui/src/components/AervoxWorkbench.vue`、`docs/reference/changes/CR-026-on-demand-diary.md` | 2026-08-29 | `diary-ondemand.test.ts` 集成测试 5 项（审批拒绝/新建/改写/空日记/审批缝）；`openapi-contract.test.ts` 契约断言；`@aervox/agent-loop` 117 测试；全仓 typecheck/test/build；真实 DeepSeek E2E（触发→审批→生成→改写→叙述 Completed） | 原生 |

| Agent Harness Loop 阶段 2e：§16.1 测试矩阵文件化 + provider-parity 骨架 | CAP-002/007 + 基础设施 | `packages/agent-loop/test/`（新增 `contract`/`replay`/`state-machine`/`tool-policy`/`provider-parity`；§16.1 十项全部映射到落地测试文件，见 AVX-HAR-001 §16.7） | 2026-08-28 | `@aervox/agent-loop` 47（13 测试文件，新增 14 用例）；ci-code 全量 | 原生 |
| Agent Harness Loop 阶段 2c：工具幂等预留 + unknown outcome 恢复 | CAP-002/007 + 基础设施 | `packages/agent-loop`（`ToolExecutionStatus` 增 `pending`/`outcome_unknown`；`reserveToolExecution`/`updateToolExecutionResult`；executor 工具路径「预留→执行→收口」）、`packages/database`（`tool_executions` attempt+invocation 唯一索引（schema + init 幂等）+ 三方法；`markPendingOutcomeUnknown`）、`apps/worker`（attempt-recovery 释放后标记）、`apps/api`（Sqlite store 适配） | 2026-08-28 | `@aervox/agent-loop` 33（idempotency 3：预留收口/重复不二次执行/崩溃标记）；`@aervox/database` 119（tool-reservation 4：新建/幂等/收口/释放标记）；`@aervox/api` 91（工具账本断言兼容）；ci-code 全量 | 原生 |
| Agent Harness Loop 阶段 2d：预算对账 + 删除/撤权 fail-closed | CAP-002/007 + 基础设施 | `packages/agent-loop`（`maxTurnDurationMs`/`maxConsecutiveSameTool` 预算收敛 `Interrupted`+`done.reason`；`DeletionGatePort` Step 边界 fail-closed）、`packages/database`（`privacy-repository.hasPendingDeletionRequest`）、`apps/api`（`SqlitePrivacyRepository` 注入 conversation 模块 + `runLoopTurnOnce` deletionGate 接线） | 2026-08-28 | `@aervox/agent-loop` 30（budget 5：repeat_tool 超限/不误伤/超时/闸门阻塞/放行）；`@aervox/database` 115；`@aervox/api` 91（conversation-deletion 2：未追平 fail-closed/追平后正常）；ci-code 全量 | 原生 |
| Agent Harness Loop 阶段 2b：用户取消闭环（CancelRequested CAS + executor 检查点 + 路由取消） | CAP-002/007 + 基础设施 | `packages/agent-loop`（`AttemptStatus` 增 `CancelRequested`/`Cancelled`、`ExecutionStorePort.requestCancelAttempt`/`isCancelRequested`、executor 检查点取消优先 + Cancelled 终态 CAS 单一终态）、`packages/database`（`requestCancelTurnAttempt`/`getTurnAttemptStatus`、finalize 允许从 `CancelRequested` 提交）、`apps/api`（`SqliteExecutionStore` 适配 + `POST /v1/turns/:id/cancel` CAS 化：Running→CancelRequested，终态 409/404） | 2026-08-28 | `@aervox/agent-loop` 25 测试（cancel 6：运行中取消/工具批次前零副作用/已终态拒/竞态不写 done/不可领取/not_found）；`@aervox/database` 115（cancel 4：请求位 CAS/终态拒/终态提交/not_found）；`@aervox/api` 89（cancel 集成 3：成功/409/404）；ci-code 全量 | 原生 |
| 底座边界冻结（ADR-016 + import 边界门禁 `scripts/import-boundary.mjs`） | 基础设施 | `docs/reference/adr/ADR-016-base-boundaries.md`、`scripts/import-boundary.{mjs,test.mjs}`、根 `package.json`（`check:boundary`）、`mise.toml`（ci-code 前置）、`.github/workflows/ci.yml`（触发路径 + `scripts/**`）、`docs/reference/adr/README.md`、`docs/DOC_REGISTRY.md` | 2026-08-28 | 边界脚本全仓零违规 + 单测 10/10（覆盖 5 规则、type/副作用/动态 import、宿主合法消费）+ 注入违规实测拦截（exit 1）；`mise tasks run ci-code`/`ci-docs` 通过 | 原生 |

| Observability 接口（阶段 2a：`@aervox/observability` logger/metrics/audit Port + 指标名目录 + Noop） | 基础设施（Observability/Recovery） | `packages/observability/`（`interfaces.ts`/`metric-names.ts`/`noop.ts`；18 counter + 2 gauge + 2 histogram 对齐 AVX-HAR-001 §16.3）、`docs/reference/agent-harness-loop.md`（§16.8 落地进展） | 2026-08-28 | `@aervox/observability` 5 测试（smoke：指标目录关键面 + Noop 不抛错/child 幂等）；ci-code 全量 17 tasks | 原生 |
| 沉浸式工作台 UI 重构与雾蓝主题（双端同步：居中构图（桌宠区域内移 14vw 人物中心约 35vw、卡片锚定 53vw 宽度上限 560px，消除中部留白）+ 顶部左侧液态玻璃菜单胶囊（默认正圆、点按弹性展开为圆角长条、选项高光扫过动画、全部映射既有功能：学习/待办/番茄钟/回看/设置、点击外部自动收起）+ Live2D 左侧满高区域（实际像素底边对齐、alpha ≥ 40 剔除半透明噪声、高度驱动最大化、顶部 6% 动画余量防发饰上探裁切；canvas 宿主 inset 左右 auto 导致 shrink-to-fit 宽度收敛为 0、pixi resizeTo 循环依赖致模型整体不可见，改为左右显式撑满修复）+ 右侧功能卡片升格为页面主元素（纵向满高均分两槽、大图标 56px + 标题/副标题/摘要/底部打开提示分层、亚克力玻璃 + 顶部高光条、用户可选 8 项已有功能、localStorage 持久化、可更换/清空；占位卡与功能卡严格同尺寸：el-dropdown 包裹层撑满槽位 + 620px 断点等分行，任意选择/切换/清空下两槽卡片宽高恒定；窄窗与极端比例降级：880px 断点取消双卡横向铺满、保持右锚纵向双卡仅收缩宽度（clamp(232px, 40vw, 360px)），≤620px 恢复全宽单列纵排，≤430px 收缩图标（38px）/内距/摘要字号，矮窗 ≤640px 收缩卡片内距与图标、≤480px 隐藏摘要保骨架，任意分辨率/比例下布局结构不乱；卡片功能下拉菜单按槽位定展开方向（禁用 popper flip 方向确定化：上方卡 slotIndex 0 = bottom-start 向下、下方卡 slotIndex 1 = top-start 恒向上）、`.side-card-menu` 限高 min(56vh, 400px) 内部滚动 + preventOverflow 贴边，任何视口下不超出页面；html/body/#app 双端加固 max-width/max-height 100vw/100vh + overscroll-behavior: none，页面恒定无横向/纵向滚动）+ 输入框 IME 修复（组合期不收起、候选 Enter 不发送；对话模式选择器（陪学讲解/快问快答/深度拆解/自由聊天 + 前缀随消息发送 + localStorage 持久化）已整体移除：模板 radiogroup/收起态 chip 删除、companionModes/activeMode/setMode/aervox-composer-mode 存取与 sendMessage 模式前缀逻辑删除、composer-modes/mode/chip 样式与 grid 区域清理，placeholder 固定文案）+ 去卡片纯文本消息面板最大化（1440px / 62vh；改单条显示：主面板仅渲染最新一条 AI 回复（latestAssistantLine computed，流式光标保留）、高度收敛 clamp(150px, 34vh, 460px)、右下角"回看完整对话"胶囊入口；完整上下文移入二级视觉小说式回看窗口：Teleport 全屏暗化背景 + 居中液态玻璃面板（min(880px, 100%) × min(84vh, 920px)）、说话人名条 + 左侧强调竖线文本块（assistant 雾蓝 accent / user 灰化）纵向回溯列表、打开自动滚至最新、Esc/点击空白/关闭按钮三路关闭）+ 收起式半透明输入 + 悬浮设置（仅 Web 端显示，桌面端经 isWeb 条件移除右上角悬浮设置按钮、保留标题栏与菜单胶囊入口）+ WinUI3 风格云母背景去绿改雾蓝 + 全卡阴影轻量化扁平化：投影统一收敛至 0 2–4px 低扩散低透明度（side-card/消息面板/输入区/菜单胶囊/气泡/功能坞 0 2–4px .07–.10、回看模态 0 10px .2、`--shadow` 亮暗双主题 0 4px .05/.14），叠加 `inset 0 1px 0 rgba(255,255,255,.18)` 顶缘内高光强化液态玻璃质感，hover 抬升 -3px→-1px 弱化立体感）+ 桌宠独立窗口透明沉浸形态（全窗无背景：仅 Live2D 本体满高实际像素底边对齐（共享 layout.ts）+ 顶部对话气泡（speak 命令经 CustomEvent 驱动、液态玻璃、自动消隐）+ 底部功能坞（打招呼/开心/关闭图标+文字胶囊按钮，背板 backdrop 虚化承托模型腿部截断、hover 抬升发光 + 按压回弹，均调用既有 aervoxLive2D API 与 window.close，最小液态玻璃、亮暗主题经 fairyDesktop 通道同步；移除角落 Aervox Live2D 署名小字）） | CAP-001/002/018 | `packages/ui/src/components/AervoxWorkbench.vue`（居中构图 + 菜单胶囊 + 功能卡片升格 + 模式选择 + IME 修复 + 主面板单条显示与视觉小说回看窗口）、`packages/ui/src/theme/{workbench,index,hero}.css`（云母/亚克力/全局令牌换雾蓝 + 菜单胶囊液态玻璃样式 + 主元素卡片样式 + 占位卡与功能卡同尺寸修复 + `clamp()` 全尺寸自适应 + vn-history 视觉小说回看样式）、`packages/ui/src/live2d/layout.ts`（高度驱动缩放 + 实际像素底边对齐 + headroomRatio 顶部动画余量）、`packages/ui/src/components/Live2DPet.vue`（canvas 宿主左右撑满修复宽度塌缩）、`apps/desktop/src/renderer/src/App.vue`（`show-companion` 开启）、`apps/desktop/src/renderer/src/components/{PetWindow,Live2DPet}.vue` + `apps/desktop/src/renderer/src/styles/pet.css`（桌宠窗口云母/液态玻璃同步）、`apps/web/src/styles.css` + `apps/desktop/src/renderer/src/styles/shell.css`（html/body/#app 双端 max-width/max-height 100vw/100vh + overscroll-behavior: none 无滚动加固） | 2026-08-28 | UI/Web/Desktop typecheck + build + test（12 包全过）；`check:boundary` 零违规；浏览器多视口实测（初始双占位卡/选功能后功能卡 vs 占位卡/窄视口 608px 三场景，两卡宽高差均 < 1px；窄窗 608×682 实测双卡纵排全宽单列无横向溢出，620–880/≤430/矮窗 ≤480 各断点经 CSS 级联核算：单列 grid 物理排除横排、卡片均界内；下拉菜单实测双占位卡清空 localStorage 后逐张点开：上方卡 bottom-start 向下展开、下方卡 top-start 恒向上展开，两菜单均在视口内，菜单出现前后 scrollW/scrollH 恒等于 innerW/innerH 页面零滚动） | 原生 |

| 对话回看窗口亮暗主题适配修复（Teleport 变量作用域丢失） | CAP-001/018 | `packages/ui/src/theme/workbench.css`（`.history-overlay` 自带 `--glass-bg-strong`/`--glass-border`/`--glass-blur` 令牌 + `:root[data-theme="dark"]` 暗色覆盖：回看窗口经 Teleport 挂载至 body、脱离 `.aervox-workbench` 作用域导致玻璃令牌失效、面板背景声明无效退化为透明、亮色下整窗被深色遮罩吞没变黑且文字对比度崩坏；修复后亮色遮罩改浅雾 rgba(190,200,218,.4)、暗色 rgba(10,13,20,.5)，面板不透明度 .8→.92 提升可读性，正文 15px→16px、说话人名条 12px→12.5px） | 2026-08-29 | `@aervox/ui` build（`vue-tsc`）通过；浏览器双主题实测：亮色 overlayBg rgba(190,200,218,.4)/panelBg rgba(250,251,254,.92)/文字 rgb(42,50,66)，暗色 overlayBg rgba(10,13,20,.5)/panelBg rgba(30,37,52,.92)/文字 rgb(232,235,243)，截图确认双主题玻璃面板协调、文字清晰 | 原生 |
| 功能卡片选择交互重构（下拉菜单改内嵌网格 + 移除按钮） | CAP-001 | `packages/ui/src/components/AervoxWorkbench.vue`（占位卡 el-dropdown 整体移除、改为卡片内嵌 `.side-card-grid` 两列按钮网格（8 项 cardCatalog 直选，已选功能 disabled 防重复）；功能卡 el-dropdown 更换菜单移除、右上角改 `.side-card-remove` X 按钮（`@click.stop` 调 `selectCard(slot, null)` 直接清空该槽）；`handleCardCommand` 函数删除）、`packages/ui/src/theme/workbench.css`（`.side-card-swap`/`.side-card-option`/`.side-card-menu`/`.side-card-slot > .el-dropdown` 下拉相关样式删除；新增 `.side-card-remove`（hover 危险色 `--danger`/`--danger-soft`）与 `.side-card-grid`/`.side-card-grid-item`（flex:1 撑满卡身、内部滚动、hover 雾蓝 accent、disabled .38 透明度）+ ≤430px/≤640px 断点收缩 padding 与字号；占位卡布局由横排 row 改纵排 column：head（图标+标题）+ 网格主体，虚线边框与玻璃材质保留） | 2026-08-29 | 浏览器实测全链路：清空 localStorage 后占位卡 grid 8 项无 dropdown、点「今日学习」生成功能卡且另一占位卡该项 disabled、点 X 后卡回占位 grid 恢复 8 项；`@aervox/ui` typecheck/build 通过；`mise tasks run ci-code` 17/17 全过（api 234、database 全绿） | 原生 |
| 占位卡头部缩小 + 图标样式扁平化统一 | CAP-001 | `packages/ui/src/components/AervoxWorkbench.vue`（占位卡头部 Plus 图标 24→17）、`packages/ui/src/theme/workbench.css`（`.side-card-placeholder` 头部一行紧凑化：head gap 9px、图标底座 30×30 无底色、标题字号收缩至 13px/11px，选择网格占据卡身主体；`.side-card-icon` 图标底座去渐变改纯色扁平（`linear-gradient` 145deg → `color-mix` accent 10% 纯色）、去 hover scale 立体位移只留边框加深；`.side-card-grid-item`/`.side-card-remove` hover 去 `translateY` 位移；发送按钮渐变背景 → 纯色 `var(--accent)`；全站功能图标统一 `lucide-vue-next` 线性图标，唯一内联 SVG 为番茄钟表盘功能性绘图非图标） | 2026-08-29 | 浏览器实测：占位卡 headHeight 30px、iconBg none（渐变已移除）、svg 17px、标题 13px，grid 区域占卡身主体；功能卡图标 backgroundImage none + accent 纯色底座；`@aervox/ui` typecheck/build 通过；`mise tasks run ci-code` 17/17 全过 | 原生 |
| 设置弹窗固定高度 + 内容内部滚动 | CAP-001 | `packages/ui/src/theme/workbench.css`（`.el-dialog.settings-dialog` 固定高度 `min(640px, calc(100vh - 48px))` + flex column 布局（`!important` 压过 Element Plus 内联样式；注意 `settings-dialog` 为 customClass 直接挂在 `.el-dialog` 根元素、非嵌套子元素，选择器须用 `.el-dialog.settings-dialog` 复合形式）；`.el-dialog__header` flex 固定、`.el-dialog__body` flex:1 + min-height:0 承接剩余高度；`.settings-layout` 高度 100% 传递；`.settings-detail` 改 `height: 100%` 填满并 `overflow-y: auto` 细滚动条（原 `max-height: calc(85vh - 70px)` 高度不随固定窗口联动）；`.settings-categories` 左侧分类导航补 `min-height: 0` + `overflow-y: auto` 防分类过多超高） | 2026-08-29 | 浏览器实测（459px 极矮视口）：弹窗高度 411 = min(640, 100vh−48) 固定不随内容撑开、dialogBottom 435 ≤ 459 完整在视口内；「模型与服务」长内容 scrollH 930 > clientH 250 正确转内部滚动、scrollTop=200 实测可滚动；快捷工具/插件短内容分类无滚动条；`@aervox/ui` typecheck/build 通过、ci-docs 0 errors | 原生 |
| 学习模式卡片联动、今日学习富卡片与每日一题入口、AI 提问临时选项卡 | CAP-001/002 + UQ-01 | `packages/ui/src/components/AervoxWorkbench.vue`（`savedCardSlots` 内存快照 + `applyStudyCardLayout`/`restoreStudyCardLayout`：开启学习模式两槽临时替换为「今日学习 + 番茄钟」、退出恢复、刷新回落持久化配置且 studyModeEnabled 时重应用，不写 localStorage；study 卡在学习模式下追加 `.side-card-actions` 快捷按钮网格（每日一题/开始专注/错题重练，`@click.stop` 防穿透）；`openDailyProblem`：桌面优先 `fairyDesktop.openExternal`、Web 回退 `window.open` 打开牛客每日一题页 `https://www.nowcoder.com/problem/tracker`（纯跳转不抓数据）；UQ-01 `user_question_required` 时第一槽临时覆盖为提问卡 `questionCardData`：单选点选即提交、多选本地暂存 + 提交按钮，复用既有 `handleQuestionSubmit`/`submitQuestionAnswers` 契约，`watch(activeQuestion)` 作答后自动恢复原卡片；卡片区包 `<Transition name="card-swap" mode="out-in">` 单根 `side-card-slot-inner` key 切换触发动画）、`packages/ui/src/theme/workbench.css`（`.card-swap` 进出场过渡 ~.28s 上浮淡入/上移淡出、过渡期 `pointer-events: none` 防残影误触；`.side-card-actions` 固定高度快捷网格；`.side-question-card`/`.side-question-text` 三行省略/`.picked` 选中态/`.side-question-submit` 按钮）、`apps/desktop/src/main/index.ts`（`window:open-external` IPC 仅放行 https + `shell.openExternal`）、`apps/desktop/src/preload/{index.ts,domains/window-api.ts}`、`apps/desktop/src/renderer/src/env.d.ts`（桥类型） | 2026-08-29 | `@aervox/ui` typecheck/build；`mise tasks run ci-code`；桌面端 dev 冒烟：学习模式开/关卡片带动画替换与恢复、今日学习卡统计 + 按钮网格、每日一题唤起系统浏览器、AI 提问时第一槽切为提问卡、作答后自动恢复 | 原生（牛客每日一题为外链跳转，无数据抓取） |
| 专注模式切换开关样式修复（悬浮顶栏） | CAP-001 | `packages/ui/src/theme/workbench.css`（上游 #96 引入的 `.floating-top-actions` 顶栏容器与 `.floating-study-switch-wrap` 专注模式开关模板无任何配套 CSS 导致按钮裸奔不可用——补齐：顶栏容器 absolute 右上角 flex 横排取代原 `.floating-settings` 独立定位；开关胶囊玻璃材质（图标 + 「专注模式」文案 + iOS 风格 34×19 轨道 + 15px 圆滑块），开启态轨道 accent 雾蓝 + 滑块 translateX(15px)、wrap 加 `on` class 变 accent；≤620px 断点隐藏文案只留图标 + 轨道防与左侧菜单胶囊拥挤）、`packages/ui/src/components/AervoxWorkbench.vue`（label 补 `:class="{on: studyModeEnabled}"` 显式绑定） | 2026-08-29 | 浏览器实测：开关胶囊高 34px 与设置按钮同行（top 15/12 垂直居中差 < 4px）、右侧间距 8px；点击开启轨道变 rgb(78,119,209) accent、滑块 matrix(1,0,0,1,15,0) 位移、收起态输入框「专注模式」chip 联动出现；再点击关闭恢复灰底；492px 窄视口文案正确隐藏；`@aervox/ui` typecheck/build 通过、ci-docs 0 errors | 原生 |
| CAP-033 desktop 测试 Windows 可移植性修复（学习模式卡片联动分支顺带） | CAP-033 | `apps/desktop/test/proactive-source-adapters.test.ts`（上游 #104 引入的存量测试仅在 macOS/Linux 通过：`fileMetadata` 走 `uniquePaths()` → `resolve()` 在 Windows 把 posix fixture 根 `/fixture/root` 解析为 `C:\fixture\root` 与 mock 字面路径永不匹配、probe 收敛 denied；`browserHistory` 候选路径由 `join()` 构造在 Windows 输出反斜杠同样不匹配、probe 收敛 unavailable。修复：fixture 改用 `node:path` 的 `resolve()`/`join()` 生成（browser 历史路径按 adapter 同样分段 `join`、file 根先 `resolve` 再 `join` 派生 safe/link/escape），任意平台与 adapter 内部路径逐字一致，断言语义不变） | 2026-08-29 | `mise x -- pnpm --filter @aervox/desktop exec vitest run` 6/6 全绿（修复前 Windows 上 2 failed：browser history unavailable / file metadata denied）；全量 `turbo run build typecheck test --concurrency=1` 38/38 成功 | 原生 |
| 番茄钟卡片内嵌基础操作 + 右上倒计时土司通知 | CAP-001 | `packages/ui/src/components/AervoxWorkbench.vue`（timer 卡 body 追加 `.timer-card-ops`：待运行态显示 15/25/45/60 分钟预设 chips（`selectPresetMinutes`，`aria-pressed` 标记选中）+ 开始专注/暂停、重置两列操作网格（复用 `.side-card-grid-item`，`@click.stop` 防穿透，卡片本体点击仍打开二级抽屉完整表盘、二级菜单保留）；新增 `TOAST_RING_*` 常量与 `toastRingDashoffset` computed，`timerRunning` 驱动 `<Transition name="timer-toast">` 土司：开启即右上流畅侧弹出（translateX(calc(100% + 24px)) → 0，~.38s 弹性曲线），内含 SVG 环形倒计时（`stroke-dashoffset` 每秒线性过渡形成连续流走动画）+ tabular-nums 时间 + 脉冲圆点「专注中 · N 分钟回合」+ 暂停/重置快捷按钮，暂停/重置/结束时自动收回）、`packages/ui/src/theme/workbench.css`（`.timer-card-ops`/`.timer-card-presets`/`.timer-chip`（active 雾蓝 accent）/`.timer-card-actions` 两列网格；`.timer-toast` 玻璃材质土司（absolute 右上 z-index 70、`backdrop-filter` + 顶缘内高光）、`.timer-toast-ring` 40px 环（进度弧 1s linear transition）、`.timer-toast-label::before` 2.2s 脉冲动画、进出场过渡期 `pointer-events: none` 防残影误触；≤620px 断点土司收缩：隐藏副文案、环 40→32px、按钮 28→26px） | 2026-08-29 | `@aervox/ui` typecheck（`vue-tsc`）+ build 通过；桌面端 dev 冒烟建议：卡片内选预设→开始专注→土司右上侧弹出且环随秒流动、土司暂停/卡片暂停均同步收回与恢复 | 原生 |
| 窗口尺寸调大 + 标题栏 LLM 连接状态呼吸灯 + 刷题入口入卡片目录 | CAP-001 | `apps/desktop/src/main/index.ts`（主窗口默认 1360×820 → 1440×880，稍大以容纳富卡片与土司）、`apps/desktop/src/renderer/src/components/AppTitlebar.vue`（呼吸灯从静态「AI companion」改为大模型连接状态三态：`probeLlmConnection` 经 `useAervoxLLM` 读 `GET /v1/llm/config` + `POST /v1/llm/test-connection`（与设置面板测试连接同一后端逻辑），挂载即探测 + 60s 周期轮询，状态映射 unknown 探测中（橙 1.2s 呼吸）/online 已连接（绿 2.4s 呼吸）/offline 未连接（红静默）；文案 + `el-tooltip` + `aria-label` 同步状态）、`apps/desktop/src/renderer/src/styles/shell.css`（`.titlebar-status.llm-*` 三态配色与 `llm-breath` keyframes）、`packages/ui/src/components/AervoxWorkbench.vue`（`CardId` 增 `quiz`，`cardCatalog` 增「刷题模式」卡（`ClipboardList` 图标，action 直接 `startQuiz()` 发送带刷题前缀消息；占位卡选择菜单遍历 catalog 自动可选）；移除悬浮顶栏 `.floating-quiz-btn` 及模板按钮）、`packages/ui/src/theme/workbench.css`（删除 `.floating-quiz-btn`/`.quiz-btn-label` 死样式） | 2026-08-29 | `@aervox/ui` + `@aervox/desktop` typecheck（`vue-tsc`）通过；`@aervox/desktop` build 通过；桌面端 dev 冒烟建议：新窗口默认 1440×880、标题栏呼吸灯随模型可用性变绿呼吸/红静默、点「刷题模式」卡即发起出题对话 | 原生 |
| 视觉小说式分句呈现（对话框限高 + 首句先行 + 下一句切换） | CAP-001 | `packages/ui/src/components/AervoxWorkbench.vue`（`splitIntoSentences` 按 `(?<=[。!?!?…])\s*|\n+` 切句保留句末标点；`novelIndex` 当前句索引 + `novelSentences`/`novelStreamingText`（流式仅显示第一句，打字机效果落在首句、余句静默缓存）/`novelDisplayText`（**切换模式**：一次只显示当前句 `sentences[novelIndex]`，点「下一句」整句替换非追加，对话框高度恒定不超限）/`queuedSentenceCount`/`hasQueuedSentence` computed；`watch(latestAssistantLine)` 新回复重置到第一句；`showNextSentence` 切换到下一句 + `petReact({speak})` 桌宠同步念出 + 新句限高滚动容器复位到顶部；`scrollStoryToBottom` 兼查句 markdown-body 内部滚动跟随打字位置；模板 streaming 分支渲染首句、complete 分支渲染当前句 + `.novel-progress` 句序页码「N / M」+ `.novel-next-btn` 按钮（`:key="novelIndex"` 触发整句替换切换动画）、`packages/ui/src/theme/workbench.css`（`.message-novel-text .markdown-body` 与流式分支 `.message-text > .markdown-body` 均加 `max-height: clamp(88px, 20vh, 220px)` + 内部滚动——单句超长也不撑破对话框；`.novel-meta-row` 句序页码与按钮同行 flex；`.novel-progress` tabular-nums 页码；`.28s` 新句淡入、`.novel-next-btn` 紧凑玻璃胶囊、`novel-next-in` `.34s` 上浮入场；对话框最大高度：主 clamp(120px, 26vh, 320px)、窄断点 clamp(160px, 40vh, 380px)、矮屏断点 38vh）。**分句呈现回归修复**：`handleSend` 中 `assistantLine` 为 push 前创建的原始对象，`onDelta`/`onDone`/catch 对其赋值绕过 reactive 代理 set trap——新增 computed 依赖代理 `.text`/`.state` 后依赖永不失效、computed 永不重算，导致流式无输出且兜底/错误文案均不显示（一直「正在连接」）。修复：push 后从 reactive 数组取回代理 `liveAssistantLine = story.value[story.value.length - 1]` 并全部改用之赋值；catch 补 `console.error` 便于诊断 | 2026-08-29 | `@aervox/ui` typecheck（`vue-tsc` = build）+ `vitest` 3/3 通过；浏览器实测（5173）：无桥环境下错误文案即时上屏（证明赋值→UI 链路恢复）；桌面端 dev 冒烟建议：长回复流式期间仅首句打字机显示、完成后左下「N / M」页码 + 紧凑「下一句」按钮、点击整句替换带淡入、单句超长内部滚动不超对话框限高、末句时按钮消失 | 原生 |
| 对话区域收起开关（高度折叠为细条摘要） | CAP-001 | `packages/ui/src/components/AervoxWorkbench.vue`（`consoleCollapsed` 内存态开关（刷新回落展开不写 localStorage）+ `collapsedSummaryText` computed 收起态摘要：流式显示首句打字/完成显示当前句/错误显示错误文案/无回复显示「正在连接」，单行省略；模板 `message-panel` 绑 `:class="{collapsed}"`，收起时头部渲染 `.console-collapsed-summary`（说话人 + 摘要），右上角常驻 `.console-collapse-toggle` 按钮（ChevronUp/ChevronDown 随状态切换，`aria-expanded` + `aria-label` 无障碍）、`packages/ui/src/theme/workbench.css`（`.message-panel` 加 `max-height`/`padding-block` `.32s` 弹性过渡；`.message-panel.collapsed`：max-height 44px + padding-block 9px 折叠为细条，`.message-viewport` 与 `.message-history-entry`（absolute 定位）塌缩 opacity 0 + `pointer-events: none`；`.console-collapsed-summary` flex 单行（speaker accent 色 + 摘要 text-2 色省略号 + `padding-right` 34px 避让 toggle）；`.console-collapse-toggle` 右上角 26×26 玻璃小按钮 hover accent 抬升） | 2026-08-29 | `@aervox/ui` typecheck（`vue-tsc`）+ `vitest` 3/3 通过；浏览器实测（5174）：收起后面板高度塌至 ~35px 细条、摘要「思隅 + 当前句」正常显示（DOM 断言 innerText/color）、图标随状态切换、展开恢复完整内容、快速连续切换 4 次动画流畅无残影、console 无 error | 原生 |

| Agent Harness Loop 阶段 3a：Host 幂等键 + 崩溃/超时/重复投递三重恢复测试 | CAP-002/007 + 基础设施 | `packages/agent-loop/src/executor.ts`（`executionId = attemptId:step:seq` Host 键：副作用账本/工具执行以之标识，事件新增 `executionId` 保留 `invocationId=call.id` 契约兼容）、`packages/agent-loop/test/recovery.test.ts`（crash/timeout/redelivery 三场景）、`docs/reference/agent-harness-loop.md`（§16.9） | 2026-08-28 | `@aervox/agent-loop` 50（recovery 3：crash 不重放/新 Attempt 独立、timeout 收口一次不重试、redelivery claim 拒绝+预留已存在）；`ci-code` 全量 | 原生 |

| Agent Harness Loop 阶段 3b：privileged 管理员通道 | CAP-002/007/020 + 基础设施 | `apps/api`（`createRuntimeToolProvider` privileged 收敛为授权命中→执行/未批准→待决；`POST /v1/turns/:id/tool-approvals` 管理员校验 `x-admin-user-id` ∈ `AERVOX_ADMIN_IDS` 否则 403；`scripted-privileged` Provider 脚本；`API_PRIVILEGED_SCRIPT`）、`packages/database`（`getToolApproval`）、`docs/reference/agent-harness-loop.md`（§16.10） | 2026-08-28 | `@aervox/api` 101（conversation-privileged 3：未批准待决/非管理员 403/管理员 grant 执行）；`@aervox/database` 122；ci-code 全量 | 原生 |

| Turn 级完全访问开关（CR-022：普通写工具预授权 + CAP-033 全动作授权扩展） | CAP-002/007/020/033 + 基础设施 | `packages/contracts`（`toolApprovalModeSchema`）、`apps/api/src/shared/tool-approval-policy.ts`、`apps/api/src/modules/conversation/agent-executor.ts`（动态 ToolRuntime + 静态 Contribution 授权门）、`packages/database/src/repositories/sqlite/conversation-repository.ts`（排除自动授权前缀）、`packages/api-client/src/`、`packages/ui/src/components/AervoxWorkbench.vue`、`apps/desktop/src/{main,preload,renderer}/` | 2026-08-29 | `@aervox/api` 233（`conversation-approval` 4、`conversation-privileged` 4、`tool-approval-policy` 2）；`@aervox/api-client` 15（`transport` 2，含 `full_access` 请求体透传）；Contracts/API/API Client/UI/Desktop typecheck；OpenAPI 生成；ci-code/ci-docs | 原生 |

| CAP-033 主动智能模式数据面、部分来源采集与桌面 Host（CR-023） | CAP-033 + CAP-002/005/007/008/009/010/012/013/018/020/022/023/024/026/027/030 + Agent Host/Inbox/OS 权限/隐私/本地存储基础设施 | `packages/database/src/schema/proactive.ts`、`packages/database/src/schema/init.ts`、`packages/database/src/repositories/{types,sqlite/proactive-profile-repository}.ts`、`packages/database/src/{client,proactive-vault-auth,proactive-vault-crypto}.ts`、`apps/api/src/modules/proactive/`、`apps/worker/src/{proactive-profile-worker,proactive-distiller}.ts`、`packages/ui/src/proactive/`、`apps/desktop/src/main/{proactive-host,proactive-source-adapters}.ts`、`apps/desktop/src/preload/domains/proactive-api.ts` | 2026-08-29 | 本地 Vault/加密、授权/lease/loopback token、action authorizer、Aervox activity/operation、clipboard、screen/browser/file adapter、Worker 提炼、本地画像上下文、来源级删除、导出和 heartbeat 已实现；聚焦测试覆盖 Database/API/Worker/Desktop adapters，Contracts OpenAPI build 通过。应用活动正文、通信/音视频/位置/传感器 provider、全链本地证明和生产门禁仍待实现 | 原生 |

| 主动智能十二能力 + Home Assistant + 小米运动健康（CR-024） | CAP-033/034/035 + CAP-002/005/007/010/018/020/022/027/030 | `packages/database/src/schema/proactive-intelligence.ts`、`packages/database/src/repositories/sqlite/proactive-intelligence-repository.ts`、`apps/api/src/modules/proactive/{intelligence-routes,integration-manager,integration-routes,integration-tools,home-assistant-client,xiaomi-health-client}.ts`、`apps/worker/src/proactive-intelligence-worker.ts`、`packages/contracts/src/{proactive,proactive-schemas,openapi}.ts`、`packages/ui/src/components/AervoxWorkbench.vue`、`apps/desktop/src/{main/index,preload/domains/proactive-api}.ts` | 2026-08-29 | Database 2 个主动智能仓储用例、API 3 个集成用例、Worker 1 个十二能力端到端用例；API/Database/Worker 全量测试通过；Contracts/UI/Desktop/API/Worker typecheck 与 OpenAPI 生成通过 | 原生 |

| CAP-033 主动动作安全加固（授权指纹服务端派生 + 动作状态机 + 租约感知采集门禁） | CAP-033 + 基础设施（安全/隐私） | `packages/database/src/repositories/sqlite/proactive-profile-repository.ts`（`createAction` 服务端从真实 granted grant 版本派生 `actionGrantRevision`，忽略客户端伪造；`updateAction` 增加动作状态机约束：pending→approved→running→executed，未决动作不得直接置执行态、终态不可变）、`apps/api/src/modules/proactive/routes.ts`（state 端点转发状态机错误为 409）、`apps/desktop/src/main/proactive-host.ts`（`shouldCollect`/`shouldKeepAlive` 纳入激活租约有效性：租约过期或未建立即挂起，防止挂断后继续采集剪贴板/屏幕等敏感源） | 2026-08-29 | `@aervox/database` proactive-profile 6（新增：伪造授权指纹被忽略+派生指纹、pending 直接 executed/running 被拒、approved 二次批准被拒、终态不可变、全链合法前进行）；`@aervox/api` 255 全量无回归；`@aervox/api-client` 18、`@aervox/agent-loop` 146、`@aervox/worker` 7 无回归；Desktop/UI/API/Database/Worker typecheck + build | 原生 |
| Agent Harness Loop 阶段 3c：恢复裁决基础设施（decideResume + findResumeCandidates） | CAP-002/007 + 基础设施 | `packages/agent-loop/src/resume.ts`（`decideResume` 纯函数：最后工具批次全 executed 且无终态→resume；终态/混合/未知/无结果收敛）、`packages/database`（`findResumeCandidates`：过期 Running + executed 工具 + 无 done）、`apps/worker`（recovery cycle 候选观测日志，行为不变）、`docs/reference/agent-harness-loop.md`（§16.11） | 2026-08-28 | `@aervox/agent-loop` 56（resume-decision 6 矩阵）；`@aervox/database` 125（候选 3：命中/终态排除/未知排除）；`ci-code` 全量。**续跑执行接线待阶段 4 host-agent** | 原生 |
| CAP-033 主动智能激活死锁修复（最小激活集 + 集成来源授权以连接为准 + dev 信任默认） | CAP-033/034/035 | `packages/contracts/src/proactive.ts`（`PROFILE_CAPABILITY_CATALOG`：通信/位置/传感器/敏感资料 4 个无平台 Provider 的来源 `required: false`——此前 19 项全 required 且 4 项无探测路径，`deriveProfileEffectiveState` 永远 limited，集成连接/动作授权/采集全链路被闸死；对齐设计方案 §4「剩余授权仍满足最小集合时主状态可继续显示主动智能模式」）、`packages/database/src/schema/proactive.ts`（`FULL_PROFILE_SOURCE_MANIFEST` 增加 `mandatory` 字段与 contracts required 对齐）、`packages/database/src/repositories/sqlite/proactive-profile-repository.ts`（`confirmProfile` fallback mandatory 改用 manifest）、`apps/api/src/modules/proactive/routes.ts`（authorize 对目录内来源以服务端 manifest 覆写 mandatory，不信任客户端声明）、`apps/api/src/modules/proactive/integration-manager.ts`（`assertSourceActive` 不再要求无 OS Provider 来源 grant===granted：外部连接本身即显式授权，仅阻断用户显式 revoked/denied；grant 行保留作溯源）、`apps/api/src/modules/proactive/intelligence-routes.ts`（未确认画像修订时写接口 500→409）、`aervox`（dev desktop/full 目标显式 `AERVOX_TRUST_LOCAL_DEV_HOST=1`，未签名 dev Host 不再静默挂起）、`packages/ui/src/components/AervoxWorkbench.vue` + `theme/workbench.css`（状态横幅显示挂起原因：unsigned_development_host/suspendReason 中文提示） | 2026-08-29 | 新增 UI 契约测试（待接入来源不阻塞 active）、Database 用例（fallback mandatory=15、requested 待接入来源下 active）、API 用例（服务端 mandatory 覆写+active、device.sensors requested 可连 HA/显式撤销后 403）；`turbo run build typecheck test` 38/38 全过；真实运行时验证：本地 Vault API 授权→租约→`GET /v1/proactive/status` effectiveState=active（mandatory 15/15），intelligence 写接口无修订返回 409 | 原生 |

| Agent Harness Loop 阶段 4a：内嵌异步 Host + SQLite ExecutionStore 迁移 + Observability 注入 | CAP-002/007 + 基础设施 | `packages/host-agent`（`sqlite-execution-store.ts`：自 apps/api 迁移的组合根适配，API 同步路径与异步 Host 共用；`agent-host.ts`：轮询/claim 委托 executeTurn/并发上限+背压/优雅停机 drain/processed/running；`agent-host` 接 `@aervox/observability`：turn.completed、fencing.denials、duration_ms 直方图、审计 entry，Noop 兜底不抛错）、`apps/api`（`agent-executor.ts` 删除本地 130 行 SqliteExecutionStore 副本，改引 `@aervox/host-agent`）、`docs/reference/agent-harness-loop.md`（§16.12） | 2026-08-28 | `@aervox/host-agent` 12（agent-host 6：轮询/背压/CAS 跳过/drain/观测打点×2；store 冒烟 3）；`@aervox/api` 101 无回归；ci-code 全量 | 原生 |

| Agent Harness Loop 阶段 4b：恢复接线（续跑执行） | CAP-002/007 + 基础设施 | `packages/agent-loop`（`ExecuteTurnOptions.resume`：占用 claim（expected=当前 fencing）/跳过 message 身份事件/sequence 从 lastSequence+1/Step 从 lastStep 之后（executionId 不冲突）/预填 history；`buildResumeHistory` 纯函数：从事件流重建 user+assistant 文本+权威 tool 结果）、`packages/database`（`findResumeCandidates` 扩展返回续跑数据面：租户/session/userMessage/fencingToken）、`packages/host-agent`（`sqlite-resume-source.ts`：候选→decideResume 裁决→重建上下文→产出带 resume 的 ClaimableTurn）、`docs/reference/agent-harness-loop.md`（§16.12） | 2026-08-28 | `@aervox/agent-loop` 58（resume-executor 2：抢占续跑自然完成/Step 与 executionId 不冲突）；`@aervox/host-agent` 15（resume 源 3：命中/终态过滤/未知过滤）；`@aervox/database` 125（候选数据面 3）；ci-code 全量 | 原生 |

| Agent Harness Loop 阶段 4c：最小 Profile（D2=B） | CAP-002/007 + 基础设施 | `packages/host-agent/src/profile.ts`（`createAgentProfile`：Driver→Provider 绑定（replay 无依赖 / native 需 baseUrl/apiKey/modelId 同 CR-015）、单例锁文件 <data>/profile-<id>.lock：持有者存活拒绝/陈旧锁接管/释放后可重取）、`docs/reference/agent-harness-loop.md`（§16.12） | 2026-08-28 | `@aervox/host-agent` 18（profile 6：replay 解析/单例拒/释放重取/陈旧接管/native 缺配置抛错/native 配置齐全解析）；ci-code 全量 | 原生 |

| Agent Harness Loop 阶段 4d：Host 健康检查 + 阶段 4 退出条件验证 | CAP-002/007 + 基礎设施 | `packages/host-agent/src/agent-host.ts`（`health(): Promise<HostHealth>`：liveness 五态 starting/healthy/draining/stopped/stalled（tick 超 3×pollIntervalMs 未推进，首次 tick 未完成以 startedAt 兜底）；readiness `probeDeps()` 依赖探针，探针抛错收敛为 `probeDeps` 故障项；`health()` 上报 gauge `agent.host.running/processed/uptime_ms`，Noop 兜底不抛错）、`packages/observability/src/metric-names.ts`（新增 3 个 gauge：`agent.host.running`/`agent.host.processed`/`agent.host.uptime_ms`）、`packages/agent-loop/test/provider-parity.test.ts`（阶段 4 退出条件：replay 与 custom provider 事件流 eventType 集合 ⊆ 契约枚举、首 message 末 done、delta 骨架同构）、`docs/reference/agent-harness-loop.md`（§16.13 + §13 阶段 4 标记完成 + §16.7/§16.8 状态更新） | 2026-08-28 | `@aervox/host-agent` 27（新增 `host-health.test.ts` 9：未启动 starting/启动 healthy/探针 ready true/false/探针抛错收敛/draining+stopped/stalled/容量 gauge/Noop 兜底）；`@aervox/agent-loop` 59（provider-parity 新增 1：driver 切换契约骨架同构）；阶段 4 退出条件三要素机器验证（契约骨架测试 + `agent-loop-no-db` import-boundary 健身函数 + `profile.test.ts` 无 DSH/pi 原生可运行）；ci-code 全量 | 原生 |

| Agent Harness Loop 阶段 5a：受控收件箱 AgentInboxItem（数据面 + 消费闭环） | CAP-002/007 + 基础设施（ADR-017 冻结） | `packages/database/src/schema/agent-inbox.ts` + `packages/database/src/schema/init.ts`（`agent_inbox_items` 表：租户/目标边界/type/orderingSeq/sourceActor/payloadJson/status/consumeBoundary/claim-ack/expire + 幂等唯一索引）、`packages/database/src/repositories/sqlite/agent-inbox-repository.ts`（`SqliteAgentInboxRepository`：enqueue 幂等/claimForConsumption（CAS 单赢 + 边界过滤 + 过期过滤）/acknowledge/getByIdempotencyKey）、`packages/agent-loop/src/ports.ts`（`InboxPort` + ContextBuilderPort 追加 `inboxItems`）、`packages/agent-loop/src/types.ts`（`AgentInbox*` 领域类型）、`packages/agent-loop/src/context-builder.ts`（`createInboxAwareContextBuilder` 注入 §7.1 第 7 项）、`packages/agent-loop/src/executor.ts`（`ExecuteTurnDeps.inbox` 可选：每 Step claim→注入→ack）、`packages/agent-loop/src/in-memory-inbox.ts`（测试骨架）、`packages/host-agent/src/agent-host.ts`（`AgentHostDeps.inbox` 透传）、`docs/reference/agent-harness-loop.md`（§16.14 + §13 阶段 5 标注） | 2026-08-28 | `@aervox/database` 132（`agent-inbox.test.ts` 7：enqueue 幂等/claim 单赢/ack 仅 claimed/过期过滤/租户隔离/next-turn 无 attemptId）；`@aervox/agent-loop` 67（`inbox.test.ts` 7：claim→注入→ack 集成/无残留/后向兼容/其它 attempt 不消费/builder 注入标注/InMemoryInbox 语义）；`@aervox/host-agent` 27 接线后无回归；ci-code 全量 | 原生 |
| Agent Harness Loop 阶段 5a-2：受控收件箱 HTTP 入口 + 过期回收 | CAP-002/007 + 基础设施（ADR-017 冻结） | `packages/contracts/src/inbox-schemas.ts`（`createInboxItemRequestSchema`/`inboxItemResponseSchema` 等） + `packages/contracts/src/openapi.ts`（`POST /v1/sessions/{sessionId}/inbox` 路径，tags: Inbox）、`apps/api/src/modules/inbox/`（`routes.ts` 统一端点：type/boundary/payload/幂等强校验 + x-plugin-id 插件身份（已安装+启用+`inbox.command` 权限）403 门禁 + sourceActor 服务端注入；`port.ts` `createTenantInboxPort`）、`apps/api/src/modules/conversation/`（创建 Turn 时 next-turn claim→ack→注入 followup 为输入；`runLoopTurnOnce` 接 inbox 消费 next-step）、`packages/database`（`expireOverdue`：跨租户 pending/claimed 过期→expired）、`apps/worker/src/inbox-expiry.ts`（`runInboxExpiryCycle` 挂载 `runTick`）、`docs/reference/agent-harness-loop.md`（§16.15 + §13 阶段 5 标注） | 2026-08-28 | `@aervox/api` 109（`inbox-routes.test.ts` 8：三类提交 201/幂等 200/非法 type·payload·边界 400/steer attemptId/插件 403→授权 201/next-turn 注入与不重复消费）；`@aervox/database` 134（`agent-inbox.test.ts` 新增 2：expireOverdue pending+claimed 回收/跨租户+幂等）；ci-code 全量 | 原生 |
| Agent Harness Loop 阶段 5b：Context 压缩 seam + Skill 渐进式披露接入 ContextBuilder | CAP-002/007 + 基础设施 | `packages/agent-loop`（`types.ts` `SkillDescriptor`/`ContextCompaction*`、`ports.ts` `ContextCompactionPort` + `ContextBuilderPort.build` 返回扩展 `PromptContext \| Promise<PromptContext>`、`context-builder.ts` `buildSkillsPrompt`（由 apps/api 迁入）/`createSummaryCompaction`/`createSkillAwareContextBuilder`（system 前置不翻倍）/`createComposedContextBuilder`（skills→inbox→历史→压缩最外层））、`apps/api`（`skills/skill-manager.ts` 改引 agent-loop `buildSkillsPrompt`，删除 `skill-prompt.ts` 本地副本；`conversation/agent-executor.ts` 默认注入 `skillLoader`（activeOnly skills）退化安全 + `AERVOX_LOOP_COMPACTION=rule` 开关）、`docs/reference/agent-harness-loop.md`（§16.16 + §13 阶段 5 标注） | 2026-08-28 | `@aervox/agent-loop` 77（`context-builder.test.ts` 9：skills prompt 构造/空清单/system 不翻倍/默认透传/规则摘要阈值与幂等/composer 组合顺序/异步 build）；`@aervox/api` 110（`conversation-loop.test.ts` 新增 1：active Skill 注册后造 Turn 成功，skillLoader 接线不破坏 Loop）；ci-code 全量 | 原生 + `Skill`（借鉴 AstrBot 渐进披露） |
| Agent Harness Loop 阶段 5c：Subagent/Workflow 通过独立 Tool/Provider Contribution 接入 | CAP-002/007/020 + 基础设施 | `packages/agent-loop`（`types.ts` `SubagentDelegateInput`/`SubagentRunResult`/`WorkflowDefinition`/`WorkflowStep` 等、`ports.ts` `SubagentPort` + `ToolExecutionInput.sessionId`、`subagent-contribution.ts` `composeToolProviders({fallback?})`/`createSubagentToolProvider`（`subagent_delegate` 写类走审批）/`createWorkflowToolProvider`（`workflow_run` + TS 步骤定义）、`executor.ts` 透传 sessionId 无控制流改动）、`packages/database`（`schema/subagent-runs.ts` + init 幂等：`subagent_runs` 表 + `parentAttemptId+parentExecutionId` 幂等唯一索引 + `SqliteSubagentRunRepository`：create 幂等/finalize 仅 Running/list 租户隔离）、`packages/host-agent`（`subagent-executor.ts` `createSqliteSubagentPort`：独立子 turn/attempt 落库 + 嵌套 executeTurn + 隔离上下文/递归防护/崩溃幂等）、`apps/api`（`agent-executor.ts` `buildLoopProvider` 提取 + compose(runtime fallback)接线、`conversation/index.ts` subagentFactory + workflows、`routes.ts` `GET /v1/turns/:id/subagents` + `GET /v1/workflows`、`app.ts` BuildAppOptions.workflows 透传）、`docs/reference/agent-harness-loop.md`（§16.17 + §13 阶段 5 标注） | 2026-08-29 | `@aervox/agent-loop` 工具名兼容性回归（点号名称编码与回调还原）+ `@aervox/api`/`@aervox/host-agent` 既有贡献与递归防护测试；`ci-code` / `ci-docs` | 原生 |
| 基础设施加固：租户认证中间件与已验证租户上下文（缺陷1） | 基础设施（API 认证/租户隔离） | `apps/api/src/shared/{auth,tenant}.ts`、`apps/api/src/app.ts`、`apps/api/test/auth.test.ts` | 2026-08-28 | `auth.test.ts` 集成测试 4（open/token 模式、缺失·错误·畸形 token 401 短路、正确 token 走业务路由、配置推导）；ci-code 全量 | 原生 |
| 基础设施加固：模块装配上下文收敛耦合 + eventBus 定位（缺陷2） | 基础设施（ADR-014 模块化单体装配） | `apps/api/src/modules/context.ts`、`apps/api/src/modules/*/index.ts`（16 模块统一 `registerX(ctx)` 签名）、`apps/api/src/app.ts`、`apps/api/src/shared/event-bus.ts` | 2026-08-28 | ci-code 全量（`@aervox/api` 219 用例全绿）；全仓 typecheck | 原生 |
| 基础设施加固：Turn 三入口并发语义测试固化（缺陷3） | 基础设施（Agent Harness Loop fencing/租约，AVX-HAR-001 §3.2/§5.3） | `packages/agent-loop/test/concurrency.test.ts` | 2026-08-28 | `concurrency.test.ts` 4（并发领取仅先者/执行中 fencing 拦截/租约过期抢占旧执行者 renew·finalize·claim 全拒/占用式续跑续序不重放）；`@aervox/agent-loop` 22 文件 112 用例；ci-code 全量 | 原生（DSH-01 架构语境） |
| 基础设施加固：Worker 按任务独立调频（缺陷4） | 基础设施（OPS 后台任务调度） | `apps/worker/src/index.ts` | 2026-08-28 | worker typecheck；ci-code 全量 | 原生 |
| 基础设施加固：可观测性必选注入 + 审计落库（缺陷5） | 基础设施（Observability/审计可追溯） | `packages/host-agent/src/{agent-host,sqlite-observability}.ts`、`packages/database/src/schema/{audit,init}.ts`、`packages/host-agent/test/{sqlite-observability,agent-host,host-health}.test.ts` | 2026-08-28 | `sqlite-observability.test.ts` 2（audit 落库字段/payload JSON/NULL）；`@aervox/host-agent` 11 文件 58 用例（含 fail-fast）；`@aervox/database` 27 文件 142 用例；ci-code 全量 | 原生 |
| 基础设施加固：eventBus 序列化约束、统一错误码与配置优先级（缺陷6） | 基础设施（API 错误契约/配置治理） | `apps/api/src/shared/{event-bus,errors}.ts`、`apps/api/src/app.ts`、`mise.toml`、`apps/api/test/error-handling.test.ts` | 2026-08-28 | `error-handling.test.ts` 4（统一 `{error,code,message}` 与默认 404 不回归）；ci-code 全量 | 原生 |
| 基础设施加固：token×租户绑定 + fail-closed（缺陷A·批次2） | 基础设施（API 认证/租户隔离；TM-001/TM-004） | `apps/api/src/shared/auth.ts`（AuthConfig 增 `workspaceId/subjectUserId/actorId`；token 模式租户身份只来自服务端配置 `AERVOX_AUTH_WORKSPACE/USER/ACTOR`，请求头被忽略，缺失 500 `AUTH_NOT_CONFIGURED` fail-closed）、`apps/api/test/auth.test.ts`（4→6 用例） | 2026-08-28 | `auth.test.ts` 6（token+绑定放行/伪造租户头被忽略/未绑定 500 fail-closed/配置推导）；ci-code 全量 | 原生 |
| 基础设施加固：数据/工具层业务异常映射 403/404/409（缺陷B·批次2） | 基础设施（统一错误契约；TM-004 越权 403 vs 500） | `packages/database/src/errors.ts`（`DatabaseError`/`NotFoundInTenantError`/`TenantAccessViolationError`/`DomainConflictError` 领域错误，不感知 HTTP）、`database/src/tenant.ts`、`database/src/repositories/sqlite/provenance-repository.ts`（3 处 not-found-in-tenant → 404）、`database/src/repositories/sqlite/persona-repository.ts`（顺带修复：切换历史 `desc(switchedAt)` 毫秒同值排序 flaky → rowid tiebreaker）、`apps/api/src/shared/errors.ts`（新增 `ForbiddenError`）、`apps/api/src/modules/tools/runtime.ts`（callTool 未注册→404、禁用/未授权/未绑定→403）、`apps/api/src/app.ts`（setErrorHandler 映射 DatabaseError→403/404/409）、`apps/api/test/error-handling.test.ts`（4→7） | 2026-08-28 | `error-handling.test.ts` 7（ForbiddenError→403、NotFoundInTenant→404、TenantAccessViolation→403 等）；persona cap019 复跑 4 次稳定（原 flaky 连续 3 次跑失败 2 次）；`@aervox/database` 28 文件 145 用例；ci-code 全量 | 原生 |
| 基础设施加固：挂起提问会话持久化与重启恢复（缺陷C·批次2） | 基础设施（UQ-01 交互可靠性；进程重启/多实例不再悬挂） | `packages/database/src/schema/user-question.ts`+`init.ts`（`pending_user_questions` 表，`expiresAt`=超时唯一真源）、`repositories/sqlite/user-question-repository.ts`（upsert 幂等/get/delete 租户隔离）、`apps/api/src/modules/conversation/{user-question-coordinator,routes,index}.ts`（内存态丢失→持久化恢复路径、幂等不重复写 answered、按 expiresAt 判超时、getPending 持久化回退）、`packages/agent-loop/src/executor.ts`（ask_user_question 超时语义注释收敛：真源为持久化 expiresAt）、`packages/database/test/user-question-repository.test.ts`、`apps/api/test/user-question-persistence.test.ts` | 2026-08-28 | `user-question-repository.test.ts` 3（覆盖/租户隔离/跨租户删除防护）；`user-question-persistence.test.ts` 5（挂起持久化/重启恢复/重启后超时判定/getPending 回退）；`@aervox/api` 229 无回归；ci-code 全量 | 原生 |
| 基础设施加固：工具超时 AbortSignal 真取消（缺陷D·批次2） | 基础设施（Agent Loop 取消语义；AVX-HAR-001 §10「超时即终止」） | `packages/agent-loop/src/ports.ts`（`ToolExecutionInput.signal`）、`executor.ts`（`withTimeout` 超时 `AbortController.abort()` 向下游传播）、`user-question-tool.ts`（透传 signal 给协调器）、`apps/api/src/modules/conversation/user-question-coordinator.ts`（abort → 清理内存挂起+持久化并 reject `USER_QUESTION_CANCELLED`）、`packages/agent-loop/test/tool-loop.test.ts`、`apps/api/test/user-question-persistence.test.ts` | 2026-08-28 | `tool-loop.test.ts` 超时用例断言底层收到 abort 且 `signal.aborted===true`（取消真实向下传播）；api abort 用例（立即终止+持久化清理+无 answered 事件）；`@aervox/agent-loop` 22 文件 117 用例；ci-code 全量 | 原生 |
| 基础设施加固：集中类型化配置 @aervox/config（缺陷E·批次2） | 基础设施（配置治理；单一默认值+启动期校验） | `packages/config/`（新包：`ApiConfig`/`WorkerConfig` + `loadApiConfig/loadWorkerConfig(env?)`，数字/枚举 fail-fast，worker 任务节拍覆盖非法值回退告警）、`apps/api/src/index.ts`（PORT）、`apps/api/src/modules/conversation/{agent-executor,routes}.ts`（LOOP_PROVIDER/COMPACTION/ADMIN_IDS）、`apps/api/src/modules/voice/{index,service,asr-providers}.ts`（GPT_SOVITS_*/SENSEVOICE_*/WHISPER_*）、`apps/worker/src/index.ts`（WORKER_ID/TICK_MS/INTERVAL_*）、`packages/config/test/config.test.ts`；desktop（Electron 主进程）与测试级 env 注入按运行时边界保留 | 2026-08-28 | `config.test.ts` 6（缺省/覆盖/非法 PORT·枚举 fail-fast/worker 节拍与覆盖回退）；`@aervox/api` 229 无回归；全仓 typecheck；ci-code 全量 | 原生 |
| Agent Harness Loop 阶段 6：DSH/pi 进程外 Adapter 契约面 + 模拟器 + Host 接入 + 固定 SHA 复核 | CAP-002/007/020/027 + 基础设施（ADR-010） | `packages/agent-loop/src/adapter-contract.ts`（`AdapterDriverPort`/`AdapterManifest`/`AdapterWireMessage` JSON 行协议 + 纯函数 `concludeAdapterBatch`（any/every 收紧为 `all-results-conclude`，混合批次拒绝不静默放行）与 `verifyAdapterManifest`（固定 SHA/许可证白名单/策略））+ `adapter-sim.ts`（`createSimAdapterDriver` dsh-any/pi-every 双实现 + `drainAdapterDriver` 判定）、`packages/host-agent/src/stdio-adapter.ts`（`createStdioAdapterDriver`：spawn→hello 准入复核→逐 Turn ping-pong；超时/kill switch/失败自动禁用）+ `test/fixtures/sim-adapter.mjs`、`packages/host-agent/src/adapter-turn.ts`（`runAdapterTurn`：claim→adapter 整 Turn→事件映射既有契约落库→finalize，收紧 concluded/mixed/协议/异常）+ `agent-host.ts`（`adapter?` 分支轮询驱动）、`packages/host-agent/src/dsh-reference.ts`（`probeDSHReference`：submodule gitlink 固定 SHA 复核 + 许可证）、`packages/host-agent/src/profile.ts`（`LoopDriverId` 扩 dsh/pi；缺 adapter 拒绝/adapterId 失配拒绝）、`docs/reference/adr/ADR-010-dsh-pi-adapters.md`（实施进展注记）+ `docs/reference/agent-harness-loop.md`（§16.18/§16.19 + §13 阶段 5 标注 + §16.7 parity 状态） | 2026-08-28 | `@aervox/agent-loop` 105（`adapter-contract.test.ts` 15：conclude 收紧矩阵/verifyAdapterManifest SHA·许可证·策略/decode 合法非法/sim 双实现 + drain 判定与协议缺陷）；`@aervox/host-agent` 51（`stdio-adapter.test.ts` 10：握手准入/SHA 失配 kill/许可证拒绝/mixed 收紧/协议缺陷/超时禁用 + Profile 解析矩阵；`adapter-host.test.ts` 7：concluded/mixed/协议缺陷/抛错/skipped + Host 集成双路径；`dsh-reference.test.ts` 3：gitlink SHA 匹配 MIT manifest/missing/non-git fail-closed）；`@aervox/api` 202 无回归；ci-code 全量 | `DSH-01` + `PI-01`（仅参考设计/进程外 Agent；参考仓库构建产物未接入，真运行 turn 需 submodule+install+build 指引见 ADR-010） |
| Agent Harness Loop 阶段 7：ContextManifest 写入 + ModelRun Step 级关联（ADR-017 迁移面） | CAP-002/007 + 基础设施（ADR-017） | `packages/database/src/schema/platform.ts` + `schema/init.ts`（`model_runs` 新增 `attempt_id`/`step_id`、`context_manifests` 新增 `snapshot_json`；PRAGMA 检查 + ADD COLUMN 幂等 Expand 不回填 + `model_runs_tenant_attempt_idx`）、`packages/agent-loop`（`types.ts` `ModelRunRecord`/`ContextManifestRecord`、`ports.ts` `ExecutionStorePort.recordModelRun/recordContextManifest`、`executor.ts` 每 Step 写入 + 每 Turn 首 Step manifest 快照——可观测副作用不进入控制流、`in-memory-store.ts` 收集）、`packages/host-agent`（`sqlite-execution-store.ts` 可选 `ModelRunSink` 委托）、`apps/api`（conversation 注入 `SqlitePlatformRepository` 落库 + attach 关联回写）、`docs/reference/adr/ADR-017-context-manifest-modelrun-step.md`（实施进展）+ `docs/reference/agent-harness-loop.md`（§16.20 + §16.14 状态更新） | 2026-08-28 | `@aervox/agent-loop` 108（`context-manifest.test.ts` 3：单 Step run+manifest 快照/多 Step 每 Step 一条 run 且 manifest 仅首条/无 meta 缺省兼容）；`@aervox/database` 142（`platform-modelrun.test.ts` 3：Expand 幂等/Step 级 create+complete/manifest snapshot+attach）；`@aervox/api` 202 无回归；ci-code 全量 | 原生 |
| Agent Harness Loop 阶段 6d：DSH 真 Turn 接通骨架 + 真实模型回合 | CAP-002/007/020/027 + 基础设施（ADR-010） | `packages/host-agent/src/dsh-adapter.ts`（`createDSHAdapterDriver({ repoRoot, env? })`：probeDSHReference 通过才 spawn runner）+ `test/fixtures/dsh-turn-runner.mjs`（stdio 协议 hello/request/delta/batch/done/error；模型回合 OpenAI 兼容直连 `DEEPSEEK_API_KEY`/`DSH_LLM_BASE_URL`；缺前置指引性 `dsh_unconfigured` 失败自动禁用；`DSH_LIB_MODE=1` 库内产物动态 import 验证导出面）、`docs/reference/adr/ADR-010-dsh-pi-adapters.md`（实施进展 6d/6e）+ `agent-harness-loop.md`（§16.21） | 2026-08-28 | `@aervox/host-agent` 56 +1 skipped（`dsh-turn.test.ts` 6：复核通过+spawn 且 manifest 一致 / 缺 key→dsh_unconfigured / 真模型回合（it.runIf key 就绪，外部 4xx 软跳过）/ probe 未就绪 fail-closed / 本地兼容端点完整回合 delta→batch→done→concluded 机器验证 / 库内产物加载证明（it.runIf 产物存在））；`@aervox/api` 203 无回归；ci-code 全量 | `DSH-01`（固定 commit；`reference/deepseek-harness` install+build 本地通过；库内 Cordis 容器组装为 P2） |

| Agent Harness Loop 阶段 3c+-B1：事件写入 fencing CAS（3c+ 第一项「事件写入的 fencing」前置落地） | CAP-002/007 + 基础设施 | `packages/database`（`errors.ts` 新增 `FencingMismatchError`；`repositories/{types,sqlite/conversation-repository}.ts` `appendStreamEvent` 增 `expectedFencingToken` 可选字段，携带时在 BEGIN IMMEDIATE 事务内对 turn_attempts 做 fencing+状态 CAS——运行中放行、终态仅收尾 done/error 放行，失配抛错拒写）；`packages/agent-loop`（`errors.ts` 新增 `LeaseLostError`；`ports.ts` `AgentStreamEventInput.expectedFencingToken`；`executor.ts` 全部 14 处 appendEvent 携带 claim fencing + catch 拦截 LeaseLostError→`lease_lost`（不再产生新副作用）；`in-memory-store.ts` 同语义守卫 + `simulatePreemption` 钩子）；`packages/host-agent`（`sqlite-execution-store.ts` 透传期望值 + FencingMismatchError→LeaseLostError 转译；`adapter-turn.ts` 写入携带 claim fencing）；`apps/api`（`agent-executor.ts` `failTurnWithError` 未 claim 路径携带 expectedFencingToken=0） | 2026-08-28 | `@aervox/database` 150（新增 `event-fencing.test.ts` 5：正确 fencing 通过/恢复器抢占后失配拒绝零污染/attempt 不存在拒绝/终态仅 done 放行 delta 拒绝/CancelRequested 可写）；`@aervox/agent-loop` 121（新增 `executor-fencing.test.ts` 4：内存守卫三态 + 工具执行中模拟抢占→failed(lease_lost) 且无迟到事件/无终态）；`@aervox/host-agent` 62（新增 `sqlite-execution-store-fencing.test.ts` 3：正确/转译 LeaseLostError/无校验兼容）；`@aervox/api` 229 无回归；`mise tasks run ci-code` 全量（17 tasks）+ check:boundary 零违规；ci-docs | 原生 |

| Agent Harness Loop 阶段 3c+-B2：长调用周期心跳续租 | CAP-002/007 + 基础设施 | `packages/agent-loop`（`lease-heartbeat.ts` 新增 `LeaseHeartbeat`：setInterval 周期续租 + CAS 丢失判定（renew ok=false）+ lost 订阅回调 + `throwIfLost` 检查点 + 幂等单播；`executor.ts` `ExecuteTurnOptions` 增 `leaseTtlMs`（默认 60_000）与 `leaseHeartbeatIntervalMs`（默认 TTL/2，0 关闭）；claim 后启动、try/finally 兜底停止；model stream chunk 间 `throwIfLost`，长工具调用 `onLost→cancel.abort()` + 工具 catch 内 `heartbeat.lost` 收口 `lease_lost`；`index.ts` 导出）；宿主无改动（复用既有 `renewAttemptLease` CAS） | 2026-08-28 | `@aervox/agent-loop` 131（新增 `lease-heartbeat.test.ts` 5：单元 lost 判定/幂等多播/stop 后停更 + 集成——120ms 长工具调用期间续租 ≥3（防租约超时被恢复器误判）且 Turn 正常完成 / 长调用中途 simulatePreemption（fencing+1）→ 心跳续租失败 → 在途工具 abort → failed(lease_lost) 且无 tool_result/done/error 迟到事件、不写终态 / `leaseHeartbeatIntervalMs=0` 时仅 Step 首部探活）；`@aervox/database` 151、`@aervox/host-agent` 64（含 B3 场景）、`@aervox/api` 230 无回归；`mise tasks run ci-code` 全量（17 tasks）+ check:boundary 零违规；ci-docs | 原生 |

| Agent Harness Loop 阶段 3c+-B3：工具 replay 声明 + 未知结果三态政策 + 合成结果注入 | CAP-002/007/020 + 基础设施 | `packages/database`（`schema/tool-registry.ts` 增 `replay` 列 + `schema/init.ts` 新库建列与旧库 `addColumnIfMissing` 幂等补齐；`repositories/{types,sqlite/tool-registry-repository}.ts` registerTool 读写 replay；`conversation-repository.ts` `listToolExecutionsByTurn` LEFT JOIN tool_registrations 返回 replay）；`packages/agent-loop`（`resume.ts`：`ResumeExecutionLike` 增 replay；批次聚合改为按 executionId step 段归批（含崩溃残留 tool_request 意图边界）；三态政策——未确定（pending/outcome_unknown）且相关工具全部 `replay: safe` → 返回 `reason: "synthesized"` + 合成清单（pending→not_started / outcome_unknown→outcome_unknown），`pending_approval` 永远收敛（不被合成绕过），未声明/never → fail-closed 收敛）；`packages/host-agent`（`sqlite-resume-source.ts` 传入 replay、synthesized 时向重建上下文注入合成 tool 消息——TOOL_NOT_STARTED / TOOL_OUTCOME_UNKNOWN，只进上下文不写事件/账本，事件流保持仅权威提交边界）；`apps/api`（`tools/routes.ts` POST /v1/tools 支持 replay 枚举校验透传） | 2026-08-28 | `@aervox/database` 151（`tool-registry.test.ts` 增 B3 replay 存取：safe/never/省略 null/幂等覆盖）；`@aervox/agent-loop` 131（`resume-decision.test.ts` 6→11：synthesized 双形态/未声明与 never 收敛/pending_approval 不绕过/多未确定项全 listing）；`@aervox/host-agent` 64（`sqlite-resume-source.test.ts` 增 2：replay:safe + pending → 产出含 TOOL_NOT_STARTED 合成 tool 消息的续跑上下文 / replay:never → 收敛不产出）；`@aervox/api` 230（`tools-plugins.test.ts` 增 replay 透传 + 非法 400）；`mise tasks run ci-code` 全量（17 tasks）+ check:boundary 零违规；ci-docs | 原生 |

| Agent Harness Loop 阶段 3c+-B4：工具结果入口校验 + 流式可中断 + 模型调用重试 | CAP-002/007 + 基础设施 | `packages/agent-loop`（`tool-result-safe.ts` 新增 `inspectToolResult`：大小截断（默认 8000 可配）+ Prompt injection 启发式（中英双语典型越权样本，保守匹配）；`executor.ts`：`ExecuteTurnOptions.maxModelRetries`（默认 1，0 关闭，仅首 Step 且 `textAccumulator` 为空时重试一次，LeaseLost/heartbeat.lost 不重试）；Provider 流 chunk 间隙 ≥100ms 节流执行 `prematureTermination`（取消/删除水位/总时长）命中即提前终止迭代；工具结果回填前 sanitize——注入命中以受控摘要 `blocked_tool_injection` 替代（fail-closed），超长截断后回填；`index.ts` 导出） | 2026-08-28 | `@aervox/agent-loop` 143（新增 `tool-result-safe.test.ts` 5：注入中英双语命中/超长截断/自定义上限/正常透传；`executor-b4.test.ts` 7：回填注入被摘要替代且原文不进上下文、超长截断回填、正常透传、首调用抛错自动重试一次完成、`maxModelRetries=0` 持续失败仅调一次、流式第二 chunk 前取消收敛且后续文本不产出）；`@aervox/database` 151、`@aervox/host-agent` 64、`@aervox/api` 232 无回归；`mise tasks run ci-code` 全量（17 tasks）+ check:boundary 零违规；ci-docs | 原生 |
| Agent Harness Loop 阶段 3c+-B4-D：跨包原子写对（§12.2 事务边界） | CAP-002/007 + 基础设施 | `packages/agent-loop`（`ports.ts` `ExecutionStorePort` 新增 `recordToolOutcome`（工具结果账本收口 + tool_result 事件原子）与 `finalizeAttemptWithEvent`（终态 CAS + done/error 事件原子）；`in-memory-store.ts` 同语义；`executor.ts` 工具结果收口（executed/rejected/timeout_error/duplicate）改走 `recordToolOutcome`（duplicate 账本无预留行时插入独立记录），5 处终态路径（Cancelled/Completed/Interrupted×2/Failed(tools_disabled)/catch error+Failed）改走 `finalizeAttemptWithEvent`）；`packages/database`（`conversation-repository.ts` 新增 `recordToolOutcomeAtomically`/`finalizeAttemptWithEventAtomically`：BEGIN IMMEDIATE 内 fencing+状态守卫 + 同事务写账本与事件，守卫失败抛 `FencingMismatchError`/终态 CAS 失败返回 false 不写事件）；`packages/host-agent`（`sqlite-execution-store.ts` 转译 `FencingMismatchError`→`LeaseLostError`） | 2026-08-29 | `@aervox/database` 154（新增 `atomic-write-pairs.test.ts` 3：同事务收口+事件 / fencing 失配抛错且无部分写入 / 终态+done 同事务且二次提交 false 不写第二个 done）；`@aervox/agent-loop` 143 无回归（cancel 终态竞态用例改 override `finalizeAttemptWithEvent`；duplicate 账本独立留痕保持）；`@aervox/host-agent` 65（fencing 桥接 +2 原子方法）；`mise tasks run ci-code` 全量（17 tasks）+ check:boundary 零违规；ci-docs | 原生 |
| Agent Harness Loop 阶段 3c+-E：授权快照幂等 + 安全片段/Draft 原子化（§12.2 事务边界） | CAP-002/007 + 基础设施 | `packages/database`（`schema/safe-segments.ts` 新增 `safe_segments` 表（turn_id/attempt_id/sequence/text/committed/stream_event_id + 租户列，turn+sequence 唯一）+ `schema/init.ts` 建表与索引；`conversation-repository.ts` `recordToolApproval` 幂等（同 (toolName, argumentsHash) 存在 pending 则复用既有行，跨 turn 复用，granted/denied 后新请求才新建）新增 `recordSafeSegmentAtomically`（BEGIN IMMEDIATE 内 fencing 守卫 + 同事务写 safe_segments(committed=1) 与 delta 事件并回填关联，守卫失败抛 FencingMismatchError 无部分写入）与 `listCommittedSegments`（可见前缀按 sequence 升序））；`packages/agent-loop`（`ports.ts` `ExecutionStorePort` 新增 `recordSafeSegment` 与可选 `listCommittedSegments`；`in-memory-store.ts` 同语义 + `safeSegments` 断言钩子；`executor.ts` 两处 delta 写入（无工具 isFinal / 有工具 isFinal:false）改走 `recordSafeSegment` 原子提交）；`packages/host-agent`（`sqlite-execution-store.ts` 委托原子方法 + FencingMismatchError→LeaseLostError 转译 + listCommittedSegments） | 2026-08-29 | `@aervox/database` 160（新增 `segment-approval.test.ts` 6：E1 幂等复用/不同 hash 新建/已决后新请求新建；E2 同事务写入+事件关联/fencing 失配无部分写入/可见前缀升序）；`@aervox/agent-loop` 143 无回归；`@aervox/host-agent` 65（fencing 桥接 +1 recordSafeSegment 原子+可见前缀+失配转译）；`@aervox/api` 230 无回归；`mise tasks run ci-code` 全量（17 tasks）+ check:boundary 零违规；ci-docs | 原生 |

| 人格问卷与基础偏好（CAP-010：人格偏好评测 + 5 条 API） | CAP-010 | `packages/database/src/schema/preferences.ts` + `repositories/sqlite/preferences-repository.ts`、`packages/contracts/src/schemas.ts`（`personaPreferencesSchema`/`toneSchema` 等枚举）、`apps/api/src/modules/preferences/`（`/v1/preferences` 5 路由） | 2026-08-28 | `@aervox/api` `preferences.test.ts` 7（BR-PER-001 未配置中性默认等）；Database/API typecheck；ci-code 全量 | 原生 |

| 术语抽取、流式回填与追问探索（CAP-007 / CAP-002） | CAP-007/002 | `plugins/study-companion/`、`plugins/term-explorer/`、`packages/practice-review/src/terms.ts`、`packages/contracts/src/{schemas,openapi}.ts`、`apps/api/src/modules/{terms,conversation}/`、`packages/api-client/src/{transport,useAervoxTurn}.ts`、`packages/ui/src/components/{AervoxWorkbench.vue,TermExploreDialog.vue}`、`packages/ui/src/theme/workbench.css` | 2026-08-28 | `terms.test.ts` 单元测试；`terms-explore.test.ts` / `study-term-plugins.test.ts` 集成测试；UI/Web/Desktop build + typecheck | 原生 + `AVX-PLUG-001` 插件 Bundle 规范 |
| 学习资料整理（CAP-011：资料 CRUD + 版本回溯 + 来源/许可台账 + JSON/Markdown 导出） | CAP-011 | `packages/database/src/schema/study-materials.ts`（`study_materials`/`material_versions`/`material_sources` + 索引）+ `repositories/sqlite/study-material-repository.ts`、`packages/contracts/src/schemas.ts`（materialType/status/sourceType/licenseStatus 枚举）、`apps/api/src/modules/study-materials/` | 2026-08-28 | `@aervox/api` `study-materials.test.ts` 10（版本回溯/来源台账/导出）；Database/API typecheck；ci-code 全量 | 原生 |

| 多模态答疑（CAP-012：附件元数据 + OCR 解析 + crop + RFC 5987 文件名编码） | CAP-012 | `packages/database/src/schema/content.ts`（attachment metadata + `content_parse_results`）+ `repositories/sqlite/content-repository.ts`、`packages/contracts/src/schemas.ts`（attachmentPurpose/allowedMediaTypes/`OCR_CONFIDENCE_THRESHOLD`）、`apps/api/src/modules/content/routes.ts`（附件/解析/裁剪/转文本） | 2026-08-28 | `@aervox/api` `multimodal-qna.test.ts` 8（置信度阈值/裁剪/RFC5987 文件名）；Database/API typecheck；ci-code 全量 | 原生 |

| 消息编辑、删除与引用（CAP-013：版本化编辑 + 级联删除传播 + 引用追问） | CAP-013 | `packages/database/src/schema/conversations.ts`（`turns.quote_message_id` 迁移）+ `repositories/sqlite/conversation-repository.ts`（版本历史/删除影响预览）、`packages/contracts/src/schemas.ts`（`editMessageSchema`/`messageVersionSchema`/`deleteImpactPreviewSchema`）、`apps/api/src/modules/conversation/routes.ts`（编辑/删除影响/引用端点） | 2026-08-28 | `@aervox/api` `message-edit-delete.test.ts` 7；API 171 无回归；ci-code 全量 | 原生 |

| 层级对话与会话地图（CAP-014：branch spawn/merge/return/archive + 布局 + 分支树） | CAP-014 | `packages/database`（`conversation_branches` 表 + `conversation-repository.ts` 分支方法）、`packages/contracts/src/schemas.ts`（`createBranchSchema`/`updateBranchLayoutSchema`/`branchReasonSchema`）、`apps/api/src/modules/branch/routes.ts`（`/v1/sessions/:id/branches` + 分支树 + 布局） | 2026-08-28 | `@aervox/api` `branch-map.test.ts` 10（生命周期/布局丢失不影响会话内容/递归分支树）；ci-code 全量 | 原生 |

| 思维宇宙（CAP-015：knowledge_relations + 纠错状态 + 合并追踪） | CAP-015 | `packages/database/src/schema/learning.ts`（`knowledge_relations`）+ `repositories/sqlite/learning-repository.ts`（关系/纠错/合并方法）、`packages/contracts/src/schemas.ts`（`relationTypeSchema`/`knowledgeSourceSchema`）、`apps/api/src/modules/knowledge/routes.ts` | 2026-08-28 | `@aervox/api` `thought-universe.test.ts` 8（关系 CRUD/纠错传播/证据关联/合并）；ci-code 全量 | 原生 |

| 自适应刷题与考试日计划（CAP-016/017：practice_reports + study_plans + 完成预测 + 降级计划） | CAP-016/017 | `packages/database/src/schema/learning.ts`、`repositories/sqlite/learning-repository.ts`、`packages/contracts/src/{schemas,openapi}.ts`、`apps/api/src/modules/learning/cap016-017-routes.ts`、`packages/api-client/src/useAervoxApi.ts`、`packages/ui/src/components/AervoxWorkbench.vue`（创建、预测、归档与滚动调整） | 2026-08-28 | `practice-report-study-plan.test.ts` 8（完成预测/降级计划/滚动调整）；`openapi-contract.test.ts` 契约测试；`e2e/study-plan.spec.ts` 生命周期 E2E；Contracts/API Client/UI 类型检查 | 原生 |

| 多人格模板（CAP-019：draft→review→approved/rejected + 切换日志 + 回滚 + 记忆隔离/共享） | CAP-019 | `packages/database/src/schema/persona.ts`（personas 审核列迁移 + `persona_switch_logs`/`persona_memory_scopes`）+ `repositories/sqlite/persona-repository.ts`、`packages/contracts/src/persona-schemas.ts`（reviewStatus/memoryPolicy 枚举）、`apps/api/src/modules/persona/`（`service.ts`/`routes.ts`/`bundle.ts`/`types.ts`：模板审核/切换/记忆范围端点） | 2026-08-28 | `@aervox/api` `cap019-persona-templates.test.ts` 16（模板审核流转/切换日志/回滚/记忆隔离与共享确认）；ci-code 全量 | 原生 |

| 向用户询问能力接入（CR-021 / UQ-01：ask_user_question 工具 + Loop 挂起等待 + API 协调队列 + 双形态前端呈现） | CAP-001 | `packages/contracts/src/schemas.ts`、`packages/agent-loop/src/user-question-tool.ts`、`apps/api/src/modules/conversation/user-question-coordinator.ts`、`packages/api-client/src/`、`packages/ui/src/components/UserQuestionComposer.vue`、`apps/desktop/src/renderer/src/components/PetWindow.vue` | 2026-08-28 | `@aervox/agent-loop` `user-question-tool.test.ts`；OpenAPI 生成；全仓 typecheck；ci-code 与 ci-docs 门禁 | `DSH-UQ-01` |

| 多能力 E2E 与 Playwright 测试基建 | CAP-010~017/019 | `e2e/`（`preferences`/`message-edit-delete`/`practice-flow`/`mistake-book`/`session-recovery.spec.ts`）、`playwright.config.ts`、`package.json`（`test:e2e`；`@playwright/test` 根 workspace devDep） | 2026-08-28 | playwright 用例（依赖本地 dev server）；根 workspace typecheck | 原生 |
| 能力注册表状态同步：CAP-010~019 主仓交付裁定（CR-019） | 基础设施（文档治理） | [CR-019](changes/CR-019-capability-registry-status-sync.md)、`docs/reference/capability-registry.md`（P1 表移除候选 + 转主仓交付说明）、`docs/DOC_REGISTRY.md`、`docs/README.md`、`README.md` | 2026-08-28 | `mise tasks run ci-docs`；`git diff --check` | 原生 |
| 刷题模式闭环（专注模式关键词 / 前端「刷题」按钮触发 → AI 经 `ask_user_question` 现场出题 → 判定后 `record_practice_attempt` 落库 → incorrect 自动进错题本） | CAP-003/004/016 | `packages/agent-loop`（`ports.ts` `PracticeAttemptPort`、`practice-attempt-tool.ts` `record_practice_attempt` 工具、`base-prompt.ts` `QUIZ_MODE_SYSTEM_PROMPT` + `quizMode` 选项 + 工具指引、`index.ts` 导出）、`packages/config`（`scripted-quiz` LoopProvider 枚举）、`apps/api`（`conversation/agent-executor.ts` 刷题模式检测（`[模式：刷题模式]` 前缀或专注模式关键词命中）+ 工具 Contribution 接线、`conversation/practice-attempt-port.ts` SQLite 落库适配、`conversation/{routes,index}.ts` 端口注入）、`packages/ui`（`AervoxWorkbench.vue` 悬浮「刷题」按钮 + 模式前缀组装、`theme/workbench.css` 按钮样式） | 2026-08-29 | `@aervox/agent-loop` `practice-attempt-tool.test.ts`（参数校验/端口透传/incorrect 进错题本）；`@aervox/api` `quiz-mode.test.ts`（刷题前缀 Turn：tool_request/tool_result 事件 + incorrect 作答 `GET /v1/mistakes` 入库）；ci-code 全量 | 原生 |
| Live2D 桌宠操作反馈系统（事件总线 + 多操作挂钩 + 待机自然化） | CAP-001/018 | `packages/ui/src/live2d/petReactions.ts`（`aervox:pet-react` window 自定义事件总线：`petReact({motion, expression, lookAtEl, lookDuration, speak})`，组件零耦合触发反馈；`resolveLookAtElement` 支持 CSS 选择器或元素引用）、`packages/ui/src/live2d/controller.ts`（视线平滑：focusTicker 按帧 lerp(0.12) 插值避免瞬移；`focusViewportPoint(clientX, clientY, holdMs)` 视口坐标定位 + `gazeHoldUntil` 视线占用防待机游移打断；待机自然化：两层级联根因——① 资产路径错误：`mergeExternalMotionData` 拼接 `motion/<name>.motion3.json` 而模型动作文件实际位于 `motion/motion/` 嵌套目录（与 model3.json 原始 Idle 条目同构），Vite SPA fallback 使错误路径返回 index.html（HTTP 200 + text/html）→ CubismMotionJson 解析静默失败 → Motion 组 243 个动作从未真正加载（操作反馈动作同因失效）；修复为 `motion/motion/<name>`（新路径实测 application/json + Version:3 动作数据，facial/ 平铺不受影响）；② 运行库动作播完自动随机播放 Idle 组而模型 Idle 组仅 1 个动作（w-adult-blushed01，路径正确故唯一能播）永远重复、且我方待机动作以 IDLE 级播放被库 idle 循环同级压制从未生效；修复为 `diversifyIdleGroup()` 在 Live2DModel.from 前把 manifest Idle 组替换为多样待机池（复用 Motion 组 File 引用，库 idle 自动循环随之多样）+ `playIdleHandMotion()` 提级 NORMAL(2) 保证可打断 idle 循环又因同级被拒不打断操作反馈，多样式手部动作池 `IDLE_HAND_STYLES`（摆姿势/小摆弄/挥手互动/轻松摇摆/手部变换 5 种风格）节拍间切换风格池 + 池内避开上次动作名防重复、模型 Motion 组缺失时回退自带 Idle 组（同样避开上次下标）、间隔 8–17s 随机、60% 概率换动作否则仅 `wanderGaze()` 中心附近 ±16%/±12% 视线游移）、`packages/ui/src/components/Live2DPet.vue`（统一监听反馈事件：看向目标元素中心→到时回画布中心；移除全程鼠标跟随（快速移动会鬼畜），视线仅在操作反馈期间跟随；动作/表情/口型分发）、`packages/ui/src/components/AervoxWorkbench.vue`（操作挂钩：选卡 glad+smile_03 看向卡片槽 3.6s/移除卡 shake+trouble_01/启用功能卡 forward+notice_01 看向该卡/开菜单 greet 看向菜单胶囊/关菜单 nod/开设置 tilthead 看向弹窗/关设置 nod/开复习窗 think 看向 overlay/发消息 think 看向消息面板/流式回复口型 speak/回复完成 glad+smile_01+口型/出错 sad+sad_01/专注模式开 glad 关 shake 看向开关/计时器开 nod 关 tilthead/输入框展开 tilthead 看向输入坞；动作按语义池 glad/nod/think/tilthead/shake/sad/greet/forward 随机抽取防单调） | 2026-08-29 | `@aervox/ui` typecheck（Vue 工具链）通过；浏览器实测：点击卡片桌宠看向对应卡片槽并播放 glad 动作、到时视线回中心；待机 8–17s 间隔随机换不同 idle 动作 + 视线轻微游移无重复循环；快速移动鼠标视线不跟随无鬼畜 | 原生 |

| 多模态输入（输入框上传文档/图片/音频等文件，CAP-012 扩展） | CAP-012 | `packages/contracts/src/schemas.ts`（`attachmentPurposeSchema` 扩 6 枚举（`question/chart/code_screenshot/reading/audio/file`）、`allowedMediaTypesSchema` 扩 15 类型（新增 pdf/text/doc/docx/audio 5 类）、`turnAttachmentRefSchema` 附件引用、`createTurnRequestSchema.message.attachments` 附件透传 + `packages/contracts/src/index.ts`/`openapi.json` 导出生成）、`apps/api/src/modules/content/routes.ts`（`POST /v1/attachments/binary` 原始二进制上传（query fileName/mediaType/purpose/idempotencyKey 校验 + bodyLimit=MAX_ATTACHMENT_SIZE + 扩展名兜底 + 本地落盘 attachments 目录）+ `GET /v1/attachments/:id/content` 附件内容回读（Content-Type 透传 + path.basename 防目录穿越 + 租户隔离）、`apps/api/src/modules/{content/index,conversation/routes}.ts`（路由注册 + Turn 创建消息附件注入）、`packages/api-client/src/{transport,desktop-transport,useAervoxTurn,index}.ts`（`AervoxTransport.uploadAttachment` 可选接口 + `streamAervoxTurn` attachments 选项 + `uploadAervoxAttachment` 桌面 IPC 优先/Web fetch 回退）、`apps/desktop/src/{main,preload}`（`aervox:attachment:upload` IPC：renderer File→base64→主进程 Buffer 二进制转发 API；`turn:start` 附件透传）、`packages/ui/src/components/AervoxWorkbench.vue`（附件选择按钮 + hidden file input（accept 白名单 + 扩展名映射兜底）+ 待发附件 chips（图片缩略图/类型图标/文件名/大小/X 移除）+ 发送时先批量上传取 attachmentRefs 再建 Turn + 用户消息行附件展示 + 上传错误横幅）、`packages/ui/src/theme/workbench.css`（`composer-attachments`/`attachment-chip`/`vn-history-attachments` 玻璃样式 + composer grid 三区改 attachments/input/footer）、`apps/api/test/attachment-binary.test.ts` | 2026-08-29 | `@aervox/api` `attachment-binary.test.ts`（二进制上传 201/非法类型·超限 400/内容回读/租户隔离）；`multimodal-qna.test.ts` 反例改 video/mp4 适配扩展后白名单；Contracts/API/API Client/UI/Desktop 五包 typecheck 全过 | 原生 |
| 桌宠 dock 可收起 + 展开按钮旁快捷输入 + 回复气泡（CAP-001 桌宠入口交互扩展，FR-UX-003 自由输入既有范围） | CAP-001 | `apps/desktop/src/renderer/src/pet-main.ts`（`configureAervoxClient` 注入 `desktopTransport`：桌宠窗口快捷对话与选择肢提交经主进程桥带租户/鉴权头，不再裸 fetch 直连 API）、`apps/desktop/src/renderer/src/components/PetWindow.vue`（`dockOpen` 内存态开关（默认展开不写 localStorage）；底部常驻 `.pet-dock-bar` = `pet-quick-input`（回车发送、等待中禁用并显示「思考中…」）+ `pet-dock-toggle` 展开开关（ChevronUp/Down + `aria-expanded`）；功能坞三按钮 `<transition name="pet-dock-slide">` 向上淡入展开；`sendQuickChat()` 经 `streamAervoxTurn`：onDelta 流式追加气泡文本（`stripMarkdownForBubble` 清理）、onDone 按 `replyBubbleDurationMs`（6~18s）调度消失、onError 气泡报错、onUserQuestion 复用既有 VN 选择肢（`questionBubbleActive` 门控防流式文本覆盖提问气泡）、onToolApproval 提示到工作台确认；流式占用气泡期间忽略 `aervox:pet-bubble`（防自身 Turn 的 emote speak 覆盖回复）、气泡点击提前关闭）、`apps/desktop/src/renderer/src/quick-chat.ts`（`stripMarkdownForBubble`/`replyBubbleDurationMs` 纯函数）、`apps/desktop/src/renderer/src/pet-button-poses.ts`（dock 按钮 Live2D 独立动作+表情响应：打招呼/开心/关闭（挥手告别 + 1.6s 延迟关窗防重复点击）/展开/收起/快捷发送思考各绑定互不重叠的 motion+expression 预搭配姿态池，`playPose` 同时驱动、随机取用防连续重复）、`apps/desktop/src/renderer/src/styles/pet.css`（`.pet-dock-wrap`/`.pet-dock-bar`/`.pet-quick-input`/`.pet-dock-toggle` 液态玻璃样式、`.pet-dock-slide` 过渡、`.pet-bubble-reply` 去 4 行截断改 max-height 内部滚动、窄窗输入框收窄回退）、`apps/desktop/src/renderer/src/live2d/model.ts`（同步 packages/ui 上游修复：`mergeExternalMotionData` 动作路径 `motion/` → `motion/motion/`——此前桌宠窗口整个 Motion 组 404 静默失效，dock 按钮只有表情没有动作）、`apps/desktop/test/quick-chat.test.ts`、`apps/desktop/test/pet-button-poses.test.ts`、`apps/desktop/test/pet-motion-merge.test.ts`（以真实 BuildMotionData 断言全部动作/表情 URL 层级与磁盘资产存在性） | 2026-08-29 | `@aervox/desktop` Vitest 30/30（`quick-chat.test.ts` 10：markdown 清理 6 + 时长 4；`pet-button-poses.test.ts` 5：姿态池非空/动作与表情资产存在性/按钮间动作互不重叠/交替取用；`pet-motion-merge.test.ts` 3：Motion 组 243 项路径与磁盘存在性/命名解析/Facial 组）；Desktop typecheck（`vue-tsc`）+ build 通过；`mise tasks run ci-code` 全量 20/20（`@aervox/api` `conversation-privileged` 首轮并发下偶发 5s 超时，单独复跑 5/5 与二轮全量均通过，与本改动无关）；桌面 dev 冒烟建议：dock 收起/展开动画、输入回车发送、流式气泡打字与超长滚动、选择肢作答、与工作台同会话历史 | 原生 |

| 恢复悬浮「刷题」入口按钮（合并 PR #109：#109 分支为 #106 同源支线，净增量即悬浮按钮；与 #108 卡片目录「刷题模式」卡并存，双入口触发同一 `startQuiz()` 刷题前缀链路） | CAP-003/004/016 | `packages/ui/src/components/AervoxWorkbench.vue`（顶栏悬浮 `.floating-quiz-btn` 玻璃胶囊按钮，`:disabled="streaming"`，`@click="startQuiz"`）、`packages/ui/src/theme/workbench.css`（`.floating-quiz-btn`/`.quiz-btn-label` 样式（与学习模式开关同视觉语言）） | 2026-08-29 | 合并净 diff 审查（相对 `main` 仅两 UI 文件 +49 行，API/agent-loop 内容与 #106 squash 一致）；全仓 ci-code（install + build + typecheck + test）通过 | 原生 |
| 扩展中心设置增强（插件面板集成 Skill 技能与 MCP 工具端点调试） | CAP-020 | `packages/api-client/src/{useAervoxSkills.ts,useAervoxTools.ts,index.ts}`、`packages/ui/src/components/plugin/{SkillManagerTab.vue,SkillContentDialog.vue,McpToolsTab.vue,ToolCallDialog.vue,McpRegisterDialog.vue,PluginManagerPanel.vue}`、`packages/ui/src/index.ts` | 2026-08-29 | API Client/UI/Desktop/Web typecheck；UI build；全栈测试全绿；ci-docs 门禁 | 原生 |

| 学习计划生成与路由（LLM 生成里程碑式学习路线图：JSON 提取/校验/水合/缺口处理 + 计划列表/详情/任务状态/归档路由 + 前端「AI 学习规划」面板替代旧「今日学习」抽屉） | CAP-016/017 | `apps/api/src/modules/learning/plan-generation.ts`（单次 LLM 调用生成「里程碑 + 任务」规划：结构化 JSON 提取与校验、缺口补齐水合、失败降级文案）、`apps/api/src/modules/learning/plan-routes.ts`（`POST /v1/learning-plans` 生成、列表/详情/任务状态更新/归档）、`apps/api/src/modules/learning/{index.ts,cap016-017-routes.ts}`（注册 + 移除旧 `/v1/study-plans` 手动计划端点）、`packages/database/src/schema/learning.ts`、`packages/contracts/src/{schemas,openapi}.ts`、`packages/api-client/src/{useAervoxApi.ts,index.ts}`、`packages/ui/src/components/AervoxWorkbench.vue`（学习规划面板：主题输入生成、里程碑/任务勾选推进、归档） | 2026-08-29 | `@aervox/api` `learning-plan.test.ts`（生成校验/租户隔离/任务推进/归档）；本地试验合并全仓 ci-code 20/20；GitHub CI build/typecheck 全绿 | 原生 |

**替代关系（2026-08-29，PR #118，维护者确认合入）**：`/v1/learning-plans`（LLM 生成式学习规划）**替代**原 `/v1/study-plans` 手动学习计划端点（「自适应刷题与考试日计划」登记行中 study_plans 部分；practice_reports 部分不变），旧端点与其 UI、旧测试随 #118 移除；工作台「待复习 / 今日日记 / 提醒 / 番茄钟」卡与目标管理 UI 同批移除（「今日学习」抽屉由「AI 学习规划」面板替代），上述能力的后端路由与数据层保留未动，UI 形态恢复或重设计待后续 CR 立项。

| 移除工作台右上角悬浮「刷题」按钮（产品裁定回归单入口：卡片目录「刷题模式」卡与悬浮按钮曾双入口并存，保留后者冗余；刷题能力与 `startQuiz()` 链路不变；与上行「恢复悬浮刷题入口」行为 #118 后的入口收敛决策） | CAP-001/003 | `packages/ui/src/components/AervoxWorkbench.vue`（移除悬浮顶栏 `.floating-quiz-btn` 模板按钮；`cardCatalog`「刷题模式」卡（`ClipboardList` 图标）与 `startQuiz()` 刷题前缀链路保留，卡片入口不受影响）、`packages/ui/src/theme/workbench.css`（删除 `.floating-quiz-btn`/`.floating-quiz-btn:hover`/`.floating-quiz-btn:disabled`/`.quiz-btn-label` 死样式） | 2026-08-29 | `@aervox/ui` typecheck（`vue-tsc`）+ build + Vitest 通过；`mise tasks run ci-code` 全量；浏览器冒烟建议：右上角仅剩专注模式开关（与 Web 端设置按钮）、卡片目录「刷题模式」卡仍可发起刷题对话、全站无 `floating-quiz` 残留引用 | 原生 |

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
| `NFR-AVAIL-001` | 可用性 | CAP-001～035 | `Specified` | [PRD NFR](PRD.md#prd-nfr) | `AC-NFR-AVAIL-001` | `TC-PERF-AVAIL-001` |
| `NFR-PERF-001` | 性能 | CAP-001～035 | `Specified` | [PRD NFR](PRD.md#prd-nfr)、[流式协议](STREAMING_PROTOCOL.md) | `AC-NFR-PERF-001` | `TC-PERF-API-001`、`TC-CONTRACT-STREAM-001` |
| `NFR-SCALE-001` | 容量 | CAP-001～035 | `Specified` | [PRD NFR](PRD.md#prd-nfr) | `AC-NFR-SCALE-001` | `TC-PERF-SCALE-001` |
| `NFR-REL-001` | 可靠性/幂等 | CAP-002/003/005/009/013 | `Specified` | [PRD NFR](PRD.md#prd-nfr) | `AC-NFR-REL-001` | `TC-RES-RETRY-001` |
| `NFR-JOB-001` | 后台任务 SLA | CAP-006/009/030 | `Specified` | [SRS](SRS.md#srs-nfr) | `AC-NFR-JOB-001` | `TC-INTEG-JOB-001` |
| `NFR-DR-001` | 灾备 | CAP-001～035 | `Specified` | [SRS](SRS.md#srs-nfr)、[架构灾备](ARCHITECTURE.md#arch-nfr) | `AC-NFR-DR-001` | `TC-RES-DR-001`、`TC-RES-LEDGER-001` |
| `NFR-A11Y-001` | 无障碍 | CAP-001/002/003/009 | `Specified` | [PRD NFR](PRD.md#prd-nfr) | `AC-NFR-A11Y-001` | `TC-A11Y-CORE-001` |
| `NFR-COMPAT-001` | 兼容性 | CAP-001/018/027 | `Mapped` | [PRD NFR](PRD.md#prd-nfr) | `AC-NFR-COMPAT-001` | `TC-E2E-COMPAT-001` |
| `NFR-I18N-001` | 国际化/时区 | CAP-006/009/030 | `Specified` | [PRD NFR](PRD.md#prd-nfr) | `AC-NFR-I18N-001` | `TC-INTEG-TZ-001` |
| `NFR-SEC-001` | 安全 | CAP-001～035 | `Specified` | [SRS](SRS.md#srs-nfr)、[数据隐私](DATA_PRIVACY.md#privacy-security) | `AC-NFR-SEC-001` | `TC-SEC-BASELINE-001` |
| `NFR-PRIV-001` | 隐私 | CAP-005/009/013/027 | `Specified` | [数据隐私](DATA_PRIVACY.md#privacy-gates) | `AC-NFR-PRIV-001` | `TC-PRIV-DEL-001` |
| `NFR-OBS-001` | 可观测性 | CAP-001～035 | `Mapped` | [架构告警](ARCHITECTURE.md#arch-nfr) | `AC-NFR-OBS-001` | `TC-OPS-OBS-001` |
| `AIQ-TEACH-001` | 教学正确性与提示层级 | CAP-002/003/007 | `Specified` | [AI 质量](AI_QUALITY_SAFETY.md#ai-teach) | `AC-AIQ-TEACH-001` | `TC-AIEVAL-LRN-001` |
| `AIQ-MEM-001` | 记忆压缩/晋升/来源 | CAP-005/015 | `Specified` | [AI 记忆](AI_QUALITY_SAFETY.md#ai-memory) | `AC-AIQ-MEM-001` | `TC-AIEVAL-MEM-001` |
| `AIQ-DIA-001` | 日记事实与时间窗口 | CAP-009 | `Specified` | [AI 日记](AI_QUALITY_SAFETY.md#ai-diary) | `AC-AIQ-DIA-001` | `TC-AIEVAL-DIA-001` |
| `AIQ-SAFE-001` | 安全分类与响应 | CAP-008/019/030 | `Specified` | [AI 安全响应](AI_QUALITY_SAFETY.md#ai-safety) | `AC-AIQ-SAFE-001` | `TC-AIEVAL-SAFE-001` |
| `DATA-MEM-001` | 记忆来源链与投影 | CAP-005 | `Specified` | [PRD 数据规则](PRD.md#prd-data) | `AC-DATA-MEM-001` | `TC-INTEG-MEM-001` |
| `DATA-DIA-001` | 日记版本/来源/缓冲 | CAP-009 | `Specified` | [PRD 数据模型](PRD.md#prd-data) | `AC-DATA-DIA-001` | `TC-INTEG-DIA-001` |
| `FR-STREAM-001` | Turn 流式响应、恢复与取消 | CAP-002/007/008 | `Specified` | [SRS 流式需求](SRS.md#srs-fr-stream)、[流式协议](STREAMING_PROTOCOL.md) | `AC-FR-STREAM-001-01～05` | `TC-CONTRACT-STREAM-001`、`TC-RES-STREAM-001`、`TC-SEC-STREAM-001`、`TC-E2E-STREAM-001` |
| `BR-CONV-001` | 工具执行授权与完全访问边界 | CAP-002/007/020/033 | `Specified` | [SRS 代码执行边界](SRS.md#br-conv-001-代码执行边界)、[CR-022](changes/CR-022-full-access-tool-permission.md)、[CR-023](changes/CR-023-proactive-local-intelligence-mode.md)、[Agent Harness Loop §9](agent-harness-loop.md#9-工具执行管线) | `AC-BR-CONV-001-01～07` | `TC-SEC-CONV-001`、`TC-RES-CONV-001`、`TC-API-CONV-APPROVAL-001`、`TC-API-CONV-PRIV-001`、`TC-E2E-CONV-PERM-001`、`TC-SEC-PRO-ACTION-001` |
| `FR-PRO-001` | 全量画像授权包与主动智能激活 | CAP-033 | `Specified` | [SRS CAP-033](SRS.md#srs-pro-001-全量画像授权与激活)、[CR-023](changes/CR-023-proactive-local-intelligence-mode.md) | `AC-FR-PRO-001-01～04` | `TC-API-PRO-001`、`TC-E2E-PRO-001` |
| `FR-PRO-002` | 全量来源观察与持续 watcher | CAP-033/012/023/024/026 | `Specified` | [SRS CAP-033](SRS.md#fr-pro-002-全量来源观察) | `AC-FR-PRO-002-01～03` | `TC-INTEG-PRO-SOURCE-001`、`TC-SEC-PRO-SOURCE-001` |
| `FR-PRO-003` | 本地画像推断与记忆提炼 | CAP-033/005/022 | `Specified` | [SRS CAP-033](SRS.md#fr-pro-003-本地画像与记忆提炼) | `AC-FR-PRO-003-01～04` | `TC-AIEVAL-PRO-001`、`TC-INTEG-PRO-MEM-001` |
| `FR-PRO-004` | 后台生命周期与重启恢复 | CAP-033/018/027 | `Specified` | [SRS CAP-033](SRS.md#fr-pro-004-后台生命周期与恢复) | `AC-FR-PRO-004-01～03` | `TC-RES-PRO-LIFECYCLE-001`、`TC-E2E-PRO-LIFECYCLE-001` |
| `FR-PRO-005` | 全量主动动作执行 | CAP-033/002/007/020/030 | `Specified` | [SRS CAP-033](SRS.md#fr-pro-005-主动动作执行) | `AC-FR-PRO-005-01～04` | `TC-SEC-PRO-ACTION-001`、`TC-E2E-PRO-ACTION-001` |
| `FR-PRO-006` | 暂停、撤权与删除传播 | CAP-033/005/013/026/027 | `Specified` | [SRS CAP-033](SRS.md#fr-pro-006-暂停撤权与删除) | `AC-FR-PRO-006-01～04` | `TC-PRIV-PRO-REVOKE-001`、`TC-RES-PRO-REVOKE-001`、`apps/api/test/proactive.test.ts`（来源级 revoke/delete：撤销 consent、scrub capture、删 observation/claim、撤销动作） |
| `FR-PRO-007` | 主动画像本地导出 | CAP-033/026/027 | `Specified` | [SRS CAP-033](SRS.md#fr-pro-007-主动画像导出) | `AC-FR-PRO-007-01～03` | `TC-API-PRO-EXPORT-001`、`TC-PRIV-PRO-EXPORT-001` |
| `BR-PRO-001` | 主动智能四轴状态与完全访问前置 | CAP-033/002/007/018/020 | `Specified` | [SRS CAP-033](SRS.md#br-pro-001-激活前置与状态) | `AC-BR-PRO-001-01～03` | `TC-UNIT-PRO-STATE-001`、`TC-E2E-PRO-STATE-001` |
| `BR-PRO-002` | 来源/动作授权修订与独立撤销 | CAP-033/020/023/027 | `Specified` | [SRS CAP-033](SRS.md#br-pro-002-授权修订与撤销) | `AC-BR-PRO-002-01～03` | `TC-SEC-PRO-GRANT-001`、`TC-PRIV-PRO-CONSENT-001` |
| `BR-PRO-003` | `local_only` 溯源与禁止远程降级 | CAP-033/005/022/026/027 | `Specified` | [SRS CAP-033](SRS.md#br-pro-003-本地处理边界) | `AC-BR-PRO-003-01～03` | `TC-SEC-PRO-LOCAL-001`、`TC-RES-PRO-LOCAL-001` |
| `BR-PRO-004` | 原始副本七天保留与记忆提炼门 | CAP-033/005/026 | `Specified` | [SRS CAP-033](SRS.md#br-pro-004-原始副本保留与提炼) | `AC-BR-PRO-004-01～03` | `TC-INTEG-PRO-RETENTION-001`、`TC-PRIV-PRO-RETENTION-001` |
| `BR-PRO-005` | 全动作授权快照与执行审计 | CAP-033/002/007/020 | `Specified` | [SRS CAP-033](SRS.md#br-pro-005-全动作授权快照) | `AC-BR-PRO-005-01～03` | `TC-SEC-PRO-ACTION-001`、`TC-INTEG-PRO-AUDIT-001` |
| `BR-PRO-006` | 后台恢复通知与用户可见状态 | CAP-033/010/018/030 | `Specified` | [SRS CAP-033](SRS.md#br-pro-006-后台恢复与通知) | `AC-BR-PRO-006-01～03` | `TC-E2E-PRO-NOTICE-001`、`TC-RES-PRO-LIFECYCLE-001` |
| `DATA-PRO-001` | CAP-033 控制面、来源、捕获、画像和动作实体 | CAP-033 | `Specified` | [SRS CAP-033](SRS.md#srs-pro-data) | `AC-DATA-PRO-001-01～03` | `TC-INTEG-PRO-SCHEMA-001`、`TC-SEC-TENANT-001` |
| `AIQ-PRO-001` | 画像推断证据、状态与记忆提炼质量 | CAP-033/005/022 | `Specified` | [SRS CAP-033](SRS.md#aiq-pro-001-画像推断质量) | `AC-AIQ-PRO-001-01～03` | `TC-AIEVAL-PRO-001`、`TC-AIEVAL-MEM-001` |
| `SEC-PRO-001` | 受信 Host、OS Permission Broker、权限回执与 loopback token | CAP-033/018/020 | `Specified` | [SRS CAP-033](SRS.md#sec-pro-001-受信-host-与-os-权限) | `AC-SEC-PRO-001-01～04` | `TC-SEC-PRO-HOST-001`、`TC-SEC-PRO-SOURCE-001`、`TC-SEC-PRO-AUTH-001` |
| `SEC-PRO-002` | 主动动作越权与 Prompt injection 隔离 | CAP-033/002/007/020 | `Specified` | [SRS CAP-033](SRS.md#sec-pro-002-主动动作越权隔离) | `AC-SEC-PRO-002-01～03` | `TC-SEC-PRO-ACTION-001`、`TC-SEC-PROMPT-001` |
| `PRIV-PRO-001` | 全量画像与动作独立同意 | CAP-033/008/009/010/020/023/027 | `Specified` | [SRS CAP-033](SRS.md#priv-pro-001-全量画像同意) | `AC-PRIV-PRO-001-01～03` | `TC-PRIV-PRO-CONSENT-001`、`TC-E2E-PRO-001` |
| `PRIV-PRO-002` | 主动数据本地持久化与不出云 | CAP-033/026/027 | `Specified` | [SRS CAP-033](SRS.md#priv-pro-002-本地持久化与不出云) | `AC-PRIV-PRO-002-01～03` | `TC-SEC-PRO-LOCAL-001`、`TC-PRIV-PRO-EXPORT-001` |
| `PRIV-PRO-003` | 七天保留、撤权删除与导出权利 | CAP-033/005/013/026/027 | `Specified` | [SRS CAP-033](SRS.md#priv-pro-003-保留删除与导出) | `AC-PRIV-PRO-003-01～03` | `TC-PRIV-PRO-RETENTION-001`、`TC-PRIV-PRO-REVOKE-001` |
| `OPS-PRO-001` | 后台 Host 心跳、崩溃恢复与状态收敛 | CAP-033/018/027/030 | `Specified` | [SRS CAP-033](SRS.md#ops-pro-001-后台运行与恢复) | `AC-OPS-PRO-001-01～03` | `TC-RES-PRO-LIFECYCLE-001`、`TC-PERF-PRO-001` |
| `FR-PRC-001` | 练习题组、作答判定与错题派生 | CAP-003/004 | `Specified` | [SRS 练习需求](SRS.md#fr-prc-001-练习判定与错题)、[CR-008](changes/CR-008-practice-session-contract.md) | `AC-FR-PRC-001-01～07` | `TC-UNIT-PRC-001`、`TC-API-PRC-001`、`TC-INTEG-PRC-001`、`TC-E2E-PRC-001` |
| `DATA-STREAM-001` | Turn 事件保留、撤回与删除 | CAP-002/007/008/013 | `Specified` | [SRS 跨域规则](SRS.md#srs-data-stream)、[流式协议](STREAMING_PROTOCOL.md#5-重连保留与断点恢复) | `AC-DATA-STREAM-001-01～02` | `TC-PRIV-STREAM-001`、`TC-INTEG-STREAM-RET-001` |
| `DATA-DEL-001` | 删除传播与账本 | CAP-005/009/013/026/027 | `Specified` | [删除 SLA](DATA_PRIVACY.md#privacy-deletion-sla) | `AC-DATA-DEL-001` | `TC-PRIV-DEL-001` |
| `BR-CTRL-001` | 独立恢复控制账本一致性 | CAP-001～035 | `Specified` | [SRS 控制规则](SRS.md#srs-br-ctrl) | `AC-BR-CTRL-001-01～03` | `TC-RES-LEDGER-001`、`TC-SEC-REVOKE-001` |
| `SEC-PLG-001` | 插件最小权限/沙箱 | CAP-020/031 | `Mapped` | [架构插件边界](ARCHITECTURE.md#arch-ai-security) | `AC-SEC-PLG-001` | `TC-SEC-PLUG-001` |
| `SEC-TEN-001` | 工作区/数据主体/组织隔离 | CAP-001～035 | `Specified` | [SRS 租户隔离](SRS.md#srs-sec-ten)、[数据安全控制](DATA_PRIVACY.md#privacy-security) | `AC-SEC-TEN-001-01～03` | `TC-SEC-TENANT-001`、`TC-INTEG-RLS-001` |
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
| `RISK-011` | P0-P3 范围持续扩张，导致核心闭环和安全基础延期 | `CAP-001`～`CAP-035` | 5 | 4 | 20 | 阶段基线、DoR、变更控制、容量预算和退出条件 | Open |
| `RISK-012` | 完全访问被误开启，或自动授权在关闭后被跨模式复用，导致未确认写操作 | `CAP-002/007/020/033` | 3 | 5 | 15 | 默认关闭、风险确认、Turn 级快照、CAP-033 独立全动作授权快照、授权关闭后排除、双端可见状态 | Open |
| `RISK-013` | 广域设备/应用捕获、私人文档或画像推断未经独立授权被记录，或经远程存储/模型/向量/日志离开本机；全动作授权被滥用或原始副本未按七天/提炼规则清理 | `CAP-002/005/007/008/009/012/013/018/020/022/023/024/026/027/030/033` + Agent Host/Inbox 基础设施 | 4 | 5 | 20 | 版本化完整画像与动作 Consent、OS Permission Broker 与签名 Host、强制本地私密存储与 Provider 校验、未授权来源 fail closed、`local_only` 传播、七天捕获提炼门、动作目标/修订审计、撤权零召回、导出/删除门禁 | Open |

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
---
id: CR-001
type: reference
scope: change
owner: <team-role>
doc_status: draft
decision_status: proposed
delivery_status: planned
version: 0.1.0
updated_at: YYYY-MM-DD
reviewed_at: YYYY-MM-DD
review_interval_days: 90
---

# CR-001 变更标题

- 提出人：<账号> · YYYY-MM-DD
- 修改人：<账号> · YYYY-MM-DD

## 变更原因与证据
## 关联能力与需求
## 当前行为与目标行为
## 范围外
## UX/API/数据/AI/安全/隐私影响
## 迁移与向后兼容
## 测试、埋点和验收影响
## 风险、成本、灰度、回滚和用户通知
## 更新的文档和测试
## 发布后结果
```

## 12. 维护规则与审计

至少在每次版本立项、`G1` 基线、Release Candidate 和生产发布后复核一次矩阵。审计时重点检查：孤立需求、孤立测试、无归属风险、过期豁免、已发布但未验证的状态，以及 PRD、实现和用户实际行为之间的偏差。对矩阵内所有改动，在变更记录中更新修改人与日期。
