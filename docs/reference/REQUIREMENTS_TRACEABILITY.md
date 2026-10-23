---
id: AVX-TRC-001
---

# Aervox｜思隅 需求追踪与交付质量基线

<a id="AVX-CAP-REG-001"></a>

产品需求来源：[PRD.md](PRD.md)

适用范围：原型、MVP、MVP+、P1、桌面阶段、P2、P3 及后续维护版本

## 1. 目的与使用方式

本文档集中维护能力分类与载体、覆盖状态、交付证据、未决项、风险和发布门禁。行为与验收条件见 [SRS](SRS.md)，工作顺序见 [plan.md](../../plan.md)。PRD 负责说明产品价值、用户场景、生命周期范围和功能优先级；本文档负责证明每项需求是否已经被完整定义、实现、验证并发布。

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
| `Specified` | 主要范围、流程、规则、异常和可测试验收条件已形成可评审草案 | SRS 或专项契约已有独立详细说明，且剩余缺口已列出；尚未通过 DoR |
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
| `ITER` | 唯一人工分配的变更编号，在 plan.md 协调工作 | `ITER-006` Page 与客户端认证 |
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
| `CR` | 历史变更请求编号，流程已退役 | `CR-001` 调整日记默认视角 |

变更编号统一遵循[贡献指南](../../CONTRIBUTING.md#change-numbering)。其余编号标识能力、需求、测试、风险或决定等事实源，不是另一套变更编号；实施进展回链 ITER，审查和交付证据链接 PR，普通小修复无需额外编号。

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
- ITER 只在 plan.md 的单一序列中分配；其他 ID 在各自命名空间或领域内单调递增，标题变化不改变 ID。
- 需求拆分时，原 ID 标为 `Deprecated`，通过 `replacedBy` 指向新 ID。
- 需求合并时，保留全部旧 ID，并通过 `supersededBy` 指向合并后的 ID。
- 优先级、目标版本和状态属于字段，不是 ID 的组成部分。

## 4. CAP-001～CAP-035 覆盖矩阵（全部能力状态唯一速览）

本表是 CAP 分类、载体、状态和剩余验收的唯一登记处；优先级的产品理由见 [PRD 功能地图](PRD.md#prd-cap-map)。`Specified` 只表示已有规格，`Mapped` 只表示范围已登记；已有局部代码不代表整个 CAP 通过评审、验证或发布。原“DoR 就绪”“落地”列并入剩余验收和证据，不再另记重复状态。

| 能力 ID | 能力 | 优先级 · 阶段 | 当前状态 | 分类、载体与启用方式 | 依据与已有证据 | 剩余验收 |
|---|---|---|---|---|---|---|
| `CAP-001` | 桌宠入口 | `P0 · R1` | `Specified` | 标准产品 · 第一方根界面与共享 UI | [首页工作台](SRS.md#prd-home)、[视觉小说式对话形态](SRS.md#prd-conversation-ui)、`CR-005`（已归档）、`CR-007`（已归档）；已有局部实现；验证范围见 PR | [ADR-025](adr/ADR-025-ui-surface-hosts.md) 与 [PR #275](https://github.com/3yearsZhuang/Aervox-harness/pull/275) 承接根界面/设置切片；补齐自动化 `TC-*`、埋点和真实场景验收后推进 `Ready` |
| `CAP-002` | 学习目标与对话 | `P0 · R1` | `Specified` | 标准产品 · `focus-mode` 第一方插件；学习事实主仓 | [学习目标](SRS.md#prd-cap-002)、[引导式学习对话](SRS.md#prd-cap-007)、`CR-060`；已有局部实现；验证范围见 PR | 拆分 `FR/BR/AC`，明确会话状态、并发修改、归档和恢复规则；实现载体已由 `CR-060` 明确（第一方插件 `focus-mode`，见 §4.2） |
| `CAP-003` | 互动刷题 | `P0 · R1` | `Specified` | 标准产品 · 主仓 | [互动练习与错题本](SRS.md#prd-cap-003-004)；已有局部实现；验证范围见 PR | 已由 `CR-008`（已归档） 与 `CR-013`（已归档） 补齐题目选择、快照、恢复、幂等和完成边界；新增 CR-020 guidance E2E + 错因筛选 E2E + 刷题闭环 E2E；仍需评审证据后推进 Ready |
| `CAP-004` | 错题本 | `P0 · R1` | `Specified` | 标准产品 · 主仓 | [互动练习与错题本](SRS.md#prd-cap-003-004)、`CR-009`（已归档）、`CR-018`（已归档）；已有局部实现；验证范围见 PR | 错因记录与筛选已进入实现；仍需补重复题合并的产品决策，以及 E2E 与评审证据 |
| `CAP-005` | 四段式记忆与记忆树 | `P0 · R1–R2` | `Specified` | 标准产品 · 主仓 | [四段式记忆与记忆树](SRS.md#prd-cap-005)；已有局部实现；验证范围见 PR | 拆分各层状态转换、TTL、压缩、冲突、删除、重建和迁移测试 |
| `CAP-006` | 间隔重复 | `P0 · R1` | `Specified` | 标准产品 · 主仓 | [间隔复习](SRS.md#prd-cap-006)、`CR-010`（已归档）、`CR-011`（已归档）；已有局部实现；验证范围见 PR | AC-FR-REV-001-03 已有 DST、跨时区与逾期汇总回归；仍需长期算法升级和批量历史重算策略 |
| `CAP-007` | 文本与代码答疑 | `P0 · R1` | `Specified` | 标准产品 · `focus-mode` 第一方插件；事实主仓 | [引导式学习对话](SRS.md#prd-cap-007)、`CR-060`；已有局部实现；验证范围见 PR | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready`（讲解触发复用 `FR-CONV-001`）；概念探索端点与术语管线实现载体为第一方插件 `focus-mode` |
| `CAP-008` | 情绪价值与安全陪伴 | `P0 · R1` | `Specified` | 标准产品 · 主仓 | [关系与情绪边界](PRD.md#prd-safety-boundary)、[轻量陪伴](SRS.md#prd-cap-008)；已有局部实现；验证范围见 PR | 固定风险分级、地区化求助热线、不可篡改求助响应、安全门禁前置硬阻断、isRedacted=1 数据隔离红线（日记与记忆素材零泄漏）、审计事件落库已闭环验证（AC-FR-SAFE-001-01~03 / TC-SEC-SAFE-001）；仍需补充更多小众地区资源与大规模线上对抗样本集 |
| `CAP-009` | AI 每日日记 | `P0 · R1.5` | `Specified` | 标准产品 · 主仓 | [AI 每日日记](SRS.md#prd-cap-009)、[日记与记忆层的关系](SRS.md#prd-diary-memory)、`CR-026`（已归档）；已有局部实现；验证范围见 PR | 对话触发路径已落地（CR-026，已归档）；定时任务幂等、重试、版本冲突、来源快照、通知和时区边界测试仍待阶段 2 |
| `CAP-010` | 人格问卷与基础偏好 | `P0 · R1.5` | `Specified` | 标准产品 · 主仓 | [全生命周期功能地图](PRD.md#prd-cap-map)、[P0 最低验收](SRS.md#prd-cap-001-010-013)；已有局部实现：[PR #64](https://github.com/3yearsZhuang/Aervox-harness/pull/64) | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready` |
| `CAP-011` | 学习资料整理 | `P0 · R1.5` | `Specified` | 标准产品 · 主仓 | [全生命周期功能地图](PRD.md#prd-cap-map)、[P0 最低验收](SRS.md#prd-cap-001-010-013)；已有局部实现：[PR #64](https://github.com/3yearsZhuang/Aervox-harness/pull/64) | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready` |
| `CAP-012` | 多模态答疑 | `P0 · R1.5` | `Specified` | 标准产品 · 主仓 | [全生命周期功能地图](PRD.md#prd-cap-map)、[P0 最低验收](SRS.md#prd-cap-001-010-013)；已有局部实现：[PR #64](https://github.com/3yearsZhuang/Aervox-harness/pull/64) | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready` |
| `CAP-013` | 消息编辑、删除与引用 | `P0 · R1.5` | `Specified` | 标准产品 · 主仓 | [学习记录与数据控制](SRS.md#prd-cap-013)、[P0 最低验收](SRS.md#prd-cap-001-010-013)；已有局部实现；验证范围见 PR | 进入 DoR：补齐自动化 `TC-*` 与埋点后推进 `Ready` |
| `CAP-014` | 层级对话与会话地图 | `P1 · R2` | `Mapped` | 主仓交付；不纳入自选 | [P1 验收原则](SRS.md#prd-cap-014-019)、[PR #315](https://github.com/3yearsZhuang/Aervox-harness/pull/315)；共享分支合同与有界循环/多父地图读取已合入 | 仍补真实来源归属、返回主线、删除决策、布局恢复和大图性能验收；读取保护不构成完整 `Specified` 或发布验收 |
| `CAP-015` | 思维宇宙 | `P1 · R2` | `Mapped` | 主仓交付；不纳入自选 | [P1 验收原则](SRS.md#prd-cap-014-019)；已有局部实现：[PR #64](https://github.com/3yearsZhuang/Aervox-harness/pull/64) | 仍补节点/边类型、证据、纠错传播、版本和可视化交互验收并推进 `Specified` |
| `CAP-016` | 自适应刷题与报告 | `P1 · R2` | `Mapped` | `focus-mode` 第一方插件；学习事实主仓 | [P1 验收原则](SRS.md#prd-cap-014-019)、`CR-020`（已归档）、`CR-060`；已有局部实现：[PR #64](https://github.com/3yearsZhuang/Aervox-harness/pull/64) | CR-020 已落地确定性练习反馈与下一轮建议（用时/提示数观测 + guidance 规则 + 报告展示）；CR-060 把现场刷题闭环（作答落库工具与报告端点）实现载体明确为第一方插件 `focus-mode`，学习事实真源仍留主仓；仍补算法升级、冷启动策略和偏差评估并推进 `Specified` |
| `CAP-017` | 考试日计划 | `P1 · R2` | `Mapped` | 主仓交付；不纳入自选 | [P1 验收原则](SRS.md#prd-cap-014-019)；已有局部实现：[PR #64](https://github.com/3yearsZhuang/Aervox-harness/pull/64) | 仍补计划生成约束、滚动调整、冲突、跳过、过期和完成定义并推进 `Specified` |
| `CAP-018` | 桌面化与 Live2D | `P1 · R3` | `Specified` | `apps/desktop` 薄宿主与第一方 UI 包；构建选择，皮肤可替换 | [P1 验收原则](SRS.md#prd-cap-014-019)、[ADR-009](adr/ADR-009-electron-plugin-sandbox.md)、[PR #312](https://github.com/3yearsZhuang/Aervox-harness/pull/312)；Electron/Vue 与固定文档导航、主 frame IPC 守卫已合入 | 平台矩阵、签名更新、OS 权限、资源预算、崩溃恢复与后台生命周期仍待验收；自动化和合成 Electron 探针不替代实机发布 |
| `CAP-019` | 多人格模板 | `P1 · R2` | `Mapped` | 主仓交付；不纳入自选 | [P1 验收原则](SRS.md#prd-cap-014-019)；已有局部实现：[PR #64](https://github.com/3yearsZhuang/Aervox-harness/pull/64) | 补模板审核、切换、记忆隔离/共享、回滚和人格回归评估 |
| `CAP-020` | 技能与插件系统 | `P2 · R4` | `Mapped` | 自选候选 · 构建 + 运行；声明包与受信宿主扩展 | [P2 验收原则](SRS.md#prd-cap-020-027)、[插件合同](plugin-config-and-pages.md)、[#311](https://github.com/3yearsZhuang/Aervox-harness/pull/311)、[#313](https://github.com/3yearsZhuang/Aervox-harness/pull/313)、[#314](https://github.com/3yearsZhuang/Aervox-harness/pull/314)；配置/基础 Skills 共享合同、Page 文件与归档冲突保护已合入 | 声明清单与兼容校验不等于第三方代码沙箱；签名、开放运行权限、Secret 静态加密、Page Token、完整生命周期及撤权/卸载验收仍未闭合 |
| `CAP-021` | 学习路线与视频推荐 | `P2 · R4` | `Mapped` | 远期 · 运行时选择 | [P2 验收原则](SRS.md#prd-cap-020-027)；尚无实现登记 | 补来源、排序、失效链接、用户反馈、商业内容标识和推荐评估 |
| `CAP-022` | 兴趣分析与跨域推荐 | `P2 · R4` | `Mapped` | 远期 · 运行时选择 | [P2 验收原则](SRS.md#prd-cap-020-027)；尚无实现登记 | 补授权信号、解释、关闭/重置、敏感属性禁用和偏差评估 |
| `CAP-023` | 第三方刷题接入 | `P2 · R4` | `Mapped` | 自选候选 · 运行时连接 | [P2 验收原则](SRS.md#prd-cap-020-027)；已有局部实现；验证范围见 PR | 补 OAuth、字段映射、增量同步、冲突、限流、撤权和删除 |
| `CAP-024` | 文献阅读与发散 | `P2 · R4` | `Mapped` | 自选候选 · 运行时选择 | [P2 验收原则](SRS.md#prd-cap-020-027)；尚无实现登记 | 补解析格式、引用定位、长文分段、版权、模型上下文和失败恢复 |
| `CAP-025` | 线下试卷扫描 | `P2 · R4` | `Mapped` | 自选候选 · 运行时选择 | [P2 验收原则](SRS.md#prd-cap-020-027)；已有局部实现；验证范围见 PR | 补图像质量、分题/批改识别、人工校正、置信度和附件删除 |
| `CAP-026` | 收藏空间与知识库 | `P2 · R4` | `Mapped` | 自选候选 · 构建 + 运行 | [P2 验收原则](SRS.md#prd-cap-020-027)；已有局部实现；验证范围见 PR | 补收藏状态、去重、检索、标签、来源失效、导入导出和容量限制 |
| `CAP-027` | 本地数据主权与可移植性 | `P2 · R4` | `Specified` | 强制系统责任 · 不可关闭 | [P2 验收原则](SRS.md#prd-cap-020-027)、`CR-030`（已归档）；CR-030 D1～D3 实现；生产演练未闭合 | CR-030 D1～D3 的迁移基础能力、去租户数据库边界和安全入口已实现；完整运行编排、rollback 演练和发布环境证据完成前保持 Not Ready |
| `CAP-028` | 社区互助 | `P3 · R5` | `Mapped` | 远期 · 运行时选择 | [P3 验收原则](SRS.md#prd-cap-028-033)；尚无实现登记 | 补角色、发布/回答状态机、信誉、举报申诉、审核 SLA 和未成年保护 |
| `CAP-029` | 名词解释网页 | `P3 · R5` | `Mapped` | 远期 · 运行时选择 | [P3 验收原则](SRS.md#prd-cap-028-033)；尚无实现登记 | 补发布、更新、撤回、来源失效、SEO/分享、隐私预览和版权规则 |
| `CAP-030` | 主动提醒深化 | `P3 · R5` | `Mapped` | 远期 · 运行时选择 | [P3 验收原则](SRS.md#prd-cap-028-033)；已有局部实现；验证范围见 PR | 补触发优先级、频控、去重、解释、免打扰、跨端和退订验收 |
| `CAP-031` | 内容与技能市场 | `P3 · R5` | `Mapped` | 远期 · 构建 + 运行 | [P3 验收原则](SRS.md#prd-cap-028-033)；尚无实现登记 | 补商品、版本、审核、结算、退款、下架、许可证和供应链治理 |
| `CAP-032` | 机构与监护模式 | `P3 · R5` | `Mapped` | 远期 · 运行时选择 | [P3 验收原则](SRS.md#prd-cap-028-033)；尚无实现登记 | 补组织角色、邀请/移除、授权报表、最小可见、审计和监护同意 |
| `CAP-033` | 全域感知与个人画像（主动智能模式） | `P3 · R5` | `Specified` | 构建 Privacy Host + 运行时独立授权 | [SRS CAP-033](SRS.md#prd-cap-033)、`CR-023`（已归档）、`CR-024`（已归档）、[ADR-018](adr/ADR-018-proactive-local-privacy-host.md)；本地 Vault、十二项派生、部分来源与导出切片；未生产启用 | 十二项本地派生、日/周回顾和仪表盘已验证；应用活动正文、通信、音视频、位置等平台 Provider、生产 OS Broker 和全链本地证明仍未闭合，保持 `Not Ready` |
| `CAP-034` | Home Assistant 家庭环境连接 | `P3 · R5` | `Specified` | 运行时连接 · 依赖 CAP-033 / `device.sensors` | [SRS CAP-034](SRS.md#prd-cap-034)、`CR-024`（已归档）、[ADR-019](adr/ADR-019-proactive-integrations-local-gateway.md)；本地集成验证；真实平台与发布证据未闭合 | REST/WS Client、私网校验、实体/service 白名单、Agent 工具、动作审计与撤销删除已验证；生产重连、OAuth 和 HA 版本矩阵仍待门禁 |
| `CAP-035` | 运动健康信号连接 | `P3 · R5` | `Specified` | 运行时连接 · 依赖 CAP-033 / `restricted.profile` | [SRS CAP-035](SRS.md#prd-cap-035)、`CR-024`（已归档）、[ADR-019](adr/ADR-019-proactive-integrations-local-gateway.md)；本地集成验证；真实平台与发布证据未闭合 | 小米官方开放平台通用适配、Token 刷新、每日指标、只读工具与撤销删除已验证；厂商账号审批、真实沙箱契约和长期兼容测试仍待完成 |

CAP-027 的 SQLite 本地真源、保留、导出、删除和恢复责任不可关闭；完整实现与演练仍须验收。CAP-033 保持 `Specified`、未通过 Ready、未 Released；签名 Privacy Host、OS Broker、本地出网证明、撤权删除和恢复证据闭合前不得生产启用。关联能力不会因 CAP-033 的局部实现自动升级。

<a id="capability-delivery"></a>

### 4.1 交付载体与依赖

自选分类按[能力组合边界](capability-composition.md#核心与可选的边界判定)判定；“候选/远期”是是否纳入自选及近期范围的分类，不是另一套交付状态。构建选择决定产物是否包含代码，运行选择决定当前用户是否可用，均不能关闭数据权利。

CAP-014～017/019 已按 CR-019 转主仓交付，重新自选需重新裁决；CAP-002/007/016 的实现按 CR-060 内聚到第一方 `focus-mode`，Schema、复习算法与学习事实仍归主仓。当前没有已注册的 `modules/*` 独立模块；不存在的目录不作为运行能力。`apps/desktop`、`apps/cli` 是宿主；移动宿主仍按 [ADR-022](adr/ADR-022-mobile-runtime-access.md) 提案评审。

CAP-033 依赖记忆、桌面权限、插件、本地数据与提醒边界；CAP-034/035 分别要求有效 `device.sensors`/`restricted.profile`，HA 实体默认禁用且受 service 白名单控制，健康连接只接受用户有权使用的官方平台。插件主动触发与模型降级不能扩大授权，外部内容始终按不可信输入处理。

<a id="41-建议交付批次与拆分原则"></a>

当前执行顺序只在 [plan.md](../../plan.md) 维护；仅在能力范围、载体、状态或验收缺口变化时修改本表，普通修复不另写流水登记。

<a id="42-落地实现登记"></a>
<a id="42-落地实现原则"></a>
<a id="cli-attached-20260930"></a>
<a id="core-control-approval-20261002"></a>

### 4.2 证据与适用限制

PR、自动化测试和目标环境验证是交付证据，不抄写终端日志。已完成切片仍须保留会影响后续判断的范围限制：

| 切片与证据 | 已覆盖范围 | 尚未覆盖或不能推定 |
|---|---|---|
| ITER-002 · [#258](https://github.com/3yearsZhuang/Aervox-harness/pull/258)、[#265](https://github.com/3yearsZhuang/Aervox-harness/pull/265) | 原子接单、孤儿 Turn 收敛为 Interrupted + done、子任务委托原子接单与崩溃重试复用 | `subagent_runs` 行自身中断恢复、跨进程同幂等键 HTTP 语义未纳入；重复副作用仍由唯一索引兜底，不自动重放 |
| ITER-003 · [#258](https://github.com/3yearsZhuang/Aervox-harness/pull/258)、[#259](https://github.com/3yearsZhuang/Aervox-harness/pull/259) | 显式 Memory 清理/独立验证、迟到副本阻断、共享召回资格与 `memory_long` 用途闸门、创建去重、账本原子取号 | `scope→targets`、来源→派生传播、grant 修订绑定及恢复账本接线仍待完成；数据库级唯一 sequence 约束仍须迁移演练，不能宣称全链删除 |
| ITER-004 · [#258](https://github.com/3yearsZhuang/Aervox-harness/pull/258)、[#259](https://github.com/3yearsZhuang/Aervox-harness/pull/259) | 消息短事务/CAS、同库 Config/Secret 一致提交、会话锁回收 | 外部 SecretStore 不在范围 |
| ITER-007 · [#257](https://github.com/3yearsZhuang/Aervox-harness/pull/257)、[#258](https://github.com/3yearsZhuang/Aervox-harness/pull/258)、[#259](https://github.com/3yearsZhuang/Aervox-harness/pull/259) | 调用级取消/上下文、Workflow 与子任务截止继承、DSH 本地/删除拒绝、写工具授权修订核对 | 默认预算策略、费用与跨重启计量、完整 Driver 合同及一次性授权/有效期仍待验收或相应 ADR |
| ITER-008 · [#266](https://github.com/3yearsZhuang/Aervox-harness/pull/266) | 下载偏移/实体/哈希/截断校验、路径与 symlink 防护、代际进程、有界探针 | 未持久化 ETag/If-Range；磁盘余量与默认时长策略、health-prober 就绪分级未覆盖；信任摘要与计算摘要区分须先 ADR |
| ITER-052 · [#262](https://github.com/3yearsZhuang/Aervox-harness/pull/262) | Transport 事件流、实例级插件状态、公开 Port、日记原子提交、宿主注入 | 组合根注入无独立渲染用例；不提升 CAP 发布状态 |
| 运行诊断存储 · ITER-003/068/070 · [#301](https://github.com/3yearsZhuang/Aervox-harness/pull/301)、[#302](https://github.com/3yearsZhuang/Aervox-harness/pull/302)、[#324](https://github.com/3yearsZhuang/Aervox-harness/pull/324) | 每次实际模型调用分别记录成功/失败/重试；Core 保留进程内输入，仓储新写 ContextManifest 只存消息/角色/工具计数及合法生成参数，不复制正文、工具 Schema 或内容 hash；回归检查真实 SQLite 存储 | 历史正文未自动清洗；来源删除传播、完整来源/授权条目仍未闭合，请求元数据不是可靠恢复或权限证明，[隐私最小化要求](DATA_PRIVACY.md#10-安全控制)继续有效 |
| 执行合同 · ITER-057/068/069 · [#307](https://github.com/3yearsZhuang/Aervox-harness/pull/307)、[#310](https://github.com/3yearsZhuang/Aervox-harness/pull/310) | 终态 fencing/CAS、准备期取消、有界工具 Schema；DSH 文件真实路径/描述符复验与命令取消，合同见 [Agent Harness](agent-harness-loop.md) | 合成负载不证明真实模型性能；路径检查不等于 OS 沙箱，不覆盖硬链接或同 OS 用户主动移动文件；任意第三方代码隔离仍待决定 |
| 传输与关闭 · ITER-013 · [#316](https://github.com/3yearsZhuang/Aervox-harness/pull/316)、[#317](https://github.com/3yearsZhuang/Aervox-harness/pull/317) | 持久事件分页、socket 背压、终态/水位一致快照与尾事件排空；Worker 共享关闭总截止 | 超大历史单事件、全局并发流、逐帧撤权/删除校验仍未闭合；异步截止不能打断同步阻塞或替代原生主管时限，不证明全部写者已排空 |
| 本机与 Page 边界 · ITER-006/069 · [#309](https://github.com/3yearsZhuang/Aervox-harness/pull/309)、[#312](https://github.com/3yearsZhuang/Aervox-harness/pull/312)、[#313](https://github.com/3yearsZhuang/Aervox-harness/pull/313)、[#324](https://github.com/3yearsZhuang/Aervox-harness/pull/324) | 业务前 Origin/open Host 拒绝、受信主 frame IPC/导航、Page 资源链接边界；Page 会话绑定 lifecycleGeneration，配置读写携带打开代际，配置保存/重置事务联合复验启用/可用性/代际/Schema/revision | 不能防御同 OS 用户恶意进程或受信入口自身被攻陷；全 capability 跨窗口撤权推送、Page Token 资源通道、Cookie/移动认证、签名与生产平台验收仍待完成 |
| 共享 API · ITER-064 · [#311](https://github.com/3yearsZhuang/Aervox-harness/pull/311)、[#314](https://github.com/3yearsZhuang/Aervox-harness/pull/314)、[#315](https://github.com/3yearsZhuang/Aervox-harness/pull/315)、[#318](https://github.com/3yearsZhuang/Aervox-harness/pull/318) | 配置、基础 Skills、会话分支、Feedback 由共享声明校验请求/成功响应；反馈操作者绑定认证上下文，归档文件/目录冲突在写入前拒绝；精确行为见 [API 约定](API_CONVENTIONS.md) | 历史路由覆盖例外仍未清零；Neo 生命周期、全量列表资源预算、回答版本关联与质量复核队列仍未完成，不据此完成 BR-CONV-002 或 CAP-020 |
| 第一方界面 · ITER-053～055/059 · [ADR-025](adr/ADR-025-ui-surface-hosts.md)、[#304](https://github.com/3yearsZhuang/Aervox-harness/pull/304)、[#306](https://github.com/3yearsZhuang/Aervox-harness/pull/306) | 工作台、桌宠、设置由受信第一方 UI 包及 `ui-host` 装配；桌面经典陪伴布局、手机/平板主动陪伴入口，已选界面优先；回归见[设计基线](DESIGN.md) | [第三方界面生态](adr/ADR-026-ui-surface-open-ecosystem.md)仍为提案；学习记录推荐、历史消息加载、真实模型、移动真机及正式发布分别验收 |
| CLI · ITER-029 · [#308](https://github.com/3yearsZhuang/Aervox-harness/pull/308)、[#319](https://github.com/3yearsZhuang/Aervox-harness/pull/319) | 本机服务的基础问答、交互与诊断；开发启动器就绪探测和进程组回收；通过现有列表 API 显式分页浏览会话 | 列表 offset 不是固定快照或完整导出；详情/历史读取、模型配置入口、学习/复习、记忆专用命令、独立宿主、跨平台和正式分发分别验收 |

跨切片重复实现只计一次；历史过程从 Git/PR 或归档仓库追溯。本文保留的是现行限制，不是另一份执行队列。

## 5. 原子需求字段模板

在 SRS 或所属契约中记录稳定 ID、Parent CAP、可观察行为、适用的权限/数据影响、异常与恢复，以及验收条件。只有确有影响时才增加性能、AI、迁移等字段，不填写整表“不适用”，不手写修改人或日期。

## 6. Definition of Ready

进入开发的范围须明确用户价值、正常与适用的失败/并发/撤销路径，可由他人判断的验收条件，以及受影响 API、数据、安全、AI、兼容与回退边界。阻塞决策已关闭或有明确、有效期内的豁免；测试和观测方法足以证明范围。未确认假设以实验/提案保留，不伪装为 Ready。

## 7. Definition of Done

实现经评审并通过与风险相称的自动化/人工验证才可记为 Verified；涉及数据、权限、AI 或迁移时，还须完成对应专项门禁。Released 另需目标环境发布、监控、回退和发布后验证，不能由代码合并或本地测试推定。

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

下表把 SRS、架构、数据和 AI 专项规范中已经写成基线的跨能力要求纳入同一追踪入口。它们仍需在目标版本进入 `Ready` 前补充具体测试证据和批准记录；没有证据时不得把 `Specified` 视为已发布。

| 需求 ID | 类别 | Parent CAP | 当前状态 | 规范/来源 | AC | 测试/证据 |
|---|---|---|---|---|---|---|
| `NFR-AVAIL-001` | 可用性 | CAP-001～035 | `Specified` | [SRS NFR](SRS.md#srs-nfr) | `AC-NFR-AVAIL-001` | `TC-PERF-AVAIL-001` |
| `NFR-PERF-001` | 性能 | CAP-001～035 | `Specified` | [SRS NFR](SRS.md#srs-nfr)、[流式协议](STREAMING_PROTOCOL.md) | `AC-NFR-PERF-001` | `TC-PERF-API-001`、`TC-CONTRACT-STREAM-001` |
| `NFR-SCALE-001` | 容量 | CAP-001～035 | `Specified` | [SRS NFR](SRS.md#srs-nfr) | `AC-NFR-SCALE-001` | `TC-PERF-SCALE-001` |
| `NFR-REL-001` | 可靠性/幂等 | CAP-002/003/005/009/013 | `Specified` | [SRS NFR](SRS.md#srs-nfr) | `AC-NFR-REL-001` | `TC-RES-RETRY-001` |
| `NFR-JOB-001` | 后台任务 SLA | CAP-006/009/030 | `Specified` | [SRS](SRS.md#srs-nfr) | `AC-NFR-JOB-001` | `TC-INTEG-JOB-001` |
| `NFR-DR-001` | 灾备 | CAP-001～035 | `Specified` | [SRS](SRS.md#srs-nfr)、[架构灾备](ARCHITECTURE.md#arch-nfr) | `AC-NFR-DR-001` | `TC-RES-DR-001`、`TC-RES-LEDGER-001` |
| `NFR-A11Y-001` | 无障碍 | CAP-001/002/003/009 | `Specified` | [SRS NFR](SRS.md#srs-nfr) | `AC-NFR-A11Y-001` | `TC-A11Y-CORE-001` |
| `NFR-COMPAT-001` | 兼容性 | CAP-001/018/027 | `Mapped` | [SRS NFR](SRS.md#srs-nfr) | `AC-NFR-COMPAT-001` | `TC-E2E-COMPAT-001` |
| `NFR-I18N-001` | 国际化/时区 | CAP-006/009/030 | `Specified` | [SRS NFR](SRS.md#srs-nfr) | `AC-NFR-I18N-001` | `TC-INTEG-TZ-001` |
| `NFR-SEC-001` | 安全 | CAP-001～035 | `Specified` | [SRS](SRS.md#srs-nfr)、[数据隐私](DATA_PRIVACY.md#privacy-security) | `AC-NFR-SEC-001` | `TC-SEC-BASELINE-001` |
| `NFR-PRIV-001` | 隐私 | CAP-005/009/013/027 | `Specified` | [数据隐私](DATA_PRIVACY.md#privacy-gates) | `AC-NFR-PRIV-001` | `TC-PRIV-DEL-001` |
| `NFR-OBS-001` | 可观测性 | CAP-001～035 | `Mapped` | [架构告警](ARCHITECTURE.md#arch-nfr)、[只读运行详情](agent-harness-loop.md)；`apps/api/test/turn-diagnostics.test.ts`、`e2e/ui/turn-diagnostics.spec.ts` 覆盖持久摘要与界面；完整告警和真实模型验收未闭合 | `AC-NFR-OBS-001` | `TC-OPS-OBS-001` |
| `AIQ-TEACH-001` | 教学正确性与提示层级 | CAP-002/003/007 | `Specified` | [AI 质量](AI_QUALITY_SAFETY.md#ai-teach) | `AC-AIQ-TEACH-001` | `TC-AIEVAL-LRN-001` |
| `AIQ-MEM-001` | 记忆压缩/晋升/来源 | CAP-005/015 | `Specified` | [AI 记忆](AI_QUALITY_SAFETY.md#ai-memory) | `AC-AIQ-MEM-001` | `TC-AIEVAL-MEM-001` |
| `AIQ-DIA-001` | 日记事实与时间窗口 | CAP-009 | `Specified` | [AI 日记](AI_QUALITY_SAFETY.md#ai-diary) | `AC-AIQ-DIA-001` | `TC-AIEVAL-DIA-001` |
| `AIQ-SAFE-001` | 安全分类与响应 | CAP-008/019/030 | `Specified` | [AI 安全响应](AI_QUALITY_SAFETY.md#ai-safety) | `AC-AIQ-SAFE-001` | `TC-AIEVAL-SAFE-001` |
| `DATA-MEM-001` | 记忆来源链与投影 | CAP-005 | `Specified` | [数据库契约](DATABASE.md) | `AC-DATA-MEM-001` | `TC-INTEG-MEM-001` |
| `DATA-DIA-001` | 日记版本/来源/缓冲 | CAP-009 | `Specified` | [数据库契约](DATABASE.md) | `AC-DATA-DIA-001` | `TC-INTEG-DIA-001` |
| `FR-STREAM-001` | Turn 流式响应、恢复与取消 | CAP-002/007/008 | `Specified` | [SRS 流式需求](SRS.md#srs-fr-stream)、[流式协议](STREAMING_PROTOCOL.md) | `AC-FR-STREAM-001-01～06` | `TC-CONTRACT-STREAM-001`、`TC-RES-STREAM-001`、`TC-SEC-STREAM-001`、`TC-E2E-STREAM-001`、[有界流回归](../../apps/api/test/conversation-stream-bounded.test.ts) |
| `BR-CONV-001` | 工具执行授权与完全访问边界 | CAP-002/007/020/033 | `Specified` | [SRS 代码执行边界](SRS.md#br-conv-001-代码执行边界)、`CR-022`（已归档）、`CR-023`（已归档）、[Agent Harness Loop §9](agent-harness-loop.md#9-工具执行管线) | `AC-BR-CONV-001-01～07` | `TC-SEC-CONV-001`、`TC-RES-CONV-001`、`TC-API-CONV-APPROVAL-001`、`TC-API-CONV-PRIV-001`、`TC-E2E-CONV-PERM-001`、`TC-SEC-PRO-ACTION-001` |
| `FR-PRO-001` | 全量画像授权包与主动智能激活 | CAP-033 | `Specified` | [SRS 主动智能规格](SRS.md#srs-pro-001-全量画像授权与激活)、`CR-023`（已归档） | `AC-FR-PRO-001-01～04` | `TC-API-PRO-001`、`TC-E2E-PRO-001` |
| `FR-PRO-002` | 全量来源观察与持续 watcher | CAP-033/012/023/024/026 | `Specified` | [SRS 主动智能规格](SRS.md#fr-pro-002-全量来源观察) | `AC-FR-PRO-002-01～03` | `TC-INTEG-PRO-SOURCE-001`、`TC-SEC-PRO-SOURCE-001` |
| `FR-PRO-003` | 本地画像推断与记忆提炼 | CAP-033/005/022 | `Specified` | [SRS 主动智能规格](SRS.md#fr-pro-003-本地画像与记忆提炼) | `AC-FR-PRO-003-01～04` | `TC-AIEVAL-PRO-001`、`TC-INTEG-PRO-MEM-001` |
| `FR-PRO-004` | 后台生命周期与重启恢复 | CAP-033/018/027 | `Specified` | [SRS 主动智能规格](SRS.md#fr-pro-004-后台生命周期与恢复) | `AC-FR-PRO-004-01～03` | `TC-RES-PRO-LIFECYCLE-001`、`TC-E2E-PRO-LIFECYCLE-001` |
| `FR-PRO-005` | 全量主动动作执行 | CAP-033/002/007/020/030 | `Specified` | [SRS 主动智能规格](SRS.md#fr-pro-005-主动动作执行) | `AC-FR-PRO-005-01～04` | `TC-SEC-PRO-ACTION-001`、`TC-E2E-PRO-ACTION-001` |
| `FR-PRO-006` | 暂停、撤权与删除传播 | CAP-033/005/013/026/027 | `Specified` | [SRS 主动智能规格](SRS.md#fr-pro-006-暂停撤权与删除) | `AC-FR-PRO-006-01～04` | `TC-PRIV-PRO-REVOKE-001`、`TC-RES-PRO-REVOKE-001`、`apps/api/test/proactive.test.ts`（来源级 revoke/delete：撤销 consent、scrub capture、删 observation/claim、撤销动作） |
| `FR-PRO-007` | 主动画像本地导出 | CAP-033/026/027 | `Specified` | [SRS 主动智能规格](SRS.md#fr-pro-007-主动画像导出) | `AC-FR-PRO-007-01～03` | `TC-API-PRO-EXPORT-001`、`TC-PRIV-PRO-EXPORT-001` |
| `BR-PRO-001` | 主动智能四轴状态与完全访问前置 | CAP-033/002/007/018/020 | `Specified` | [SRS 主动智能规格](SRS.md#br-pro-001-激活前置与状态) | `AC-BR-PRO-001-01～03` | `TC-UNIT-PRO-STATE-001`、`TC-E2E-PRO-STATE-001` |
| `BR-PRO-002` | 来源/动作授权修订与独立撤销 | CAP-033/020/023/027 | `Specified` | [SRS 主动智能规格](SRS.md#br-pro-002-授权修订与撤销) | `AC-BR-PRO-002-01～03` | `TC-SEC-PRO-GRANT-001`、`TC-PRIV-PRO-CONSENT-001` |
| `BR-PRO-003` | `local_only` 溯源与禁止远程降级 | CAP-033/005/022/026/027 | `Specified` | [SRS 主动智能规格](SRS.md#br-pro-003-本地处理边界) | `AC-BR-PRO-003-01～03` | `TC-SEC-PRO-LOCAL-001`、`TC-RES-PRO-LOCAL-001` |
| `BR-PRO-004` | 原始副本七天保留与记忆提炼门 | CAP-033/005/026 | `Specified` | [SRS 主动智能规格](SRS.md#br-pro-004-原始副本保留与提炼) | `AC-BR-PRO-004-01～03` | `TC-INTEG-PRO-RETENTION-001`、`TC-PRIV-PRO-RETENTION-001` |
| `BR-PRO-005` | 全动作授权快照与执行审计 | CAP-033/002/007/020 | `Specified` | [SRS 主动智能规格](SRS.md#br-pro-005-全动作授权快照) | `AC-BR-PRO-005-01～03` | `TC-SEC-PRO-ACTION-001`、`TC-INTEG-PRO-AUDIT-001` |
| `BR-PRO-006` | 后台恢复通知与用户可见状态 | CAP-033/010/018/030 | `Specified` | [SRS 主动智能规格](SRS.md#br-pro-006-后台恢复与通知) | `AC-BR-PRO-006-01～03` | `TC-E2E-PRO-NOTICE-001`、`TC-RES-PRO-LIFECYCLE-001` |
| `DATA-PRO-001` | CAP-033 控制面、来源、捕获、画像和动作实体 | CAP-033 | `Specified` | [SRS 主动智能规格](SRS.md#srs-pro-data) | `AC-DATA-PRO-001-01～03` | `TC-INTEG-PRO-SCHEMA-001`、`TC-SEC-PRO-LOCAL-001` |
| `AIQ-PRO-001` | 画像推断证据、状态与记忆提炼质量 | CAP-033/005/022 | `Specified` | [SRS 主动智能规格](SRS.md#aiq-pro-001-画像推断质量) | `AC-AIQ-PRO-001-01～03` | `TC-AIEVAL-PRO-001`、`TC-AIEVAL-MEM-001` |
| `SEC-PRO-001` | 受信 Host、OS Permission Broker、权限回执与 loopback token | CAP-033/018/020 | `Specified` | [SRS 主动智能规格](SRS.md#sec-pro-001-受信-host-与-os-权限) | `AC-SEC-PRO-001-01～04` | `TC-SEC-PRO-HOST-001`、`TC-SEC-PRO-SOURCE-001`、`TC-SEC-PRO-AUTH-001` |
| `SEC-PRO-002` | 主动动作越权与 Prompt injection 隔离 | CAP-033/002/007/020 | `Specified` | [SRS 主动智能规格](SRS.md#sec-pro-002-主动动作越权隔离) | `AC-SEC-PRO-002-01～03` | `TC-SEC-PRO-ACTION-001`、`TC-SEC-PROMPT-001` |
| `PRIV-PRO-001` | 全量画像与动作独立同意 | CAP-033/008/009/010/020/023/027 | `Specified` | [SRS 主动智能规格](SRS.md#priv-pro-001-全量画像同意) | `AC-PRIV-PRO-001-01～03` | `TC-PRIV-PRO-CONSENT-001`、`TC-E2E-PRO-001` |
| `PRIV-PRO-002` | 主动数据本地持久化与不出云 | CAP-033/026/027 | `Specified` | [SRS 主动智能规格](SRS.md#priv-pro-002-本地持久化与不出云) | `AC-PRIV-PRO-002-01～03` | `TC-SEC-PRO-LOCAL-001`、`TC-PRIV-PRO-EXPORT-001` |
| `PRIV-PRO-003` | 七天保留、撤权删除与导出权利 | CAP-033/005/013/026/027 | `Specified` | [SRS 主动智能规格](SRS.md#priv-pro-003-保留删除与导出) | `AC-PRIV-PRO-003-01～03` | `TC-PRIV-PRO-RETENTION-001`、`TC-PRIV-PRO-REVOKE-001` |
| `OPS-PRO-001` | 后台 Host 心跳、崩溃恢复与状态收敛 | CAP-033/018/027/030 | `Specified` | [SRS 主动智能规格](SRS.md#ops-pro-001-后台运行与恢复) | `AC-OPS-PRO-001-01～03` | `TC-RES-PRO-LIFECYCLE-001`、`TC-PERF-PRO-001` |
| `FR-PRC-001` | 练习题组、作答判定与错题派生 | CAP-003/004 | `Specified` | [SRS 练习需求](SRS.md#fr-prc-001-练习判定与错题)、`CR-008`（已归档） | `AC-FR-PRC-001-01～11` | `TC-UNIT-PRC-001`、`TC-API-PRC-001`、`TC-INTEG-PRC-001`、`TC-E2E-PRC-001` |
| `DATA-STREAM-001` | Turn 事件保留、撤回与删除 | CAP-002/007/008/013 | `Specified` | [SRS 跨域规则](SRS.md#srs-data-stream)、[流式协议](STREAMING_PROTOCOL.md#5-重连保留与断点恢复) | `AC-DATA-STREAM-001-01～02` | `TC-PRIV-STREAM-001`、`TC-INTEG-STREAM-RET-001`；[逐帧来源查询](../../packages/repositories/test/stream-event-disclosure.test.ts)、[API 跨进程删除/背压](../../apps/api/test/conversation-stream-bounded.test.ts)，仅部分删除切片，保留与完整授权待验收 |
| `DATA-DEL-001` | 删除传播与账本 | CAP-005/009/013/026/027 | `Specified` | [删除 SLA](DATA_PRIVACY.md#privacy-deletion-sla) | `AC-DATA-DEL-001` | `TC-PRIV-DEL-001` |
| `BR-CTRL-001` | 独立恢复控制账本一致性 | CAP-001～035 | `Specified` | [SRS 控制规则](SRS.md#srs-br-ctrl) | `AC-BR-CTRL-001-01～03` | `TC-RES-LEDGER-001`、`TC-SEC-REVOKE-001` |
| `SEC-PLG-001` | 插件最小权限/沙箱 | CAP-020/031 | `Mapped` | [架构插件边界](ARCHITECTURE.md#arch-ai-security) | `AC-SEC-PLG-001` | `TC-SEC-PLUG-001` |
| `SEC-LOC-001` | 本地单用户数据与 API 边界 | CAP-001～035 | `Specified` | [SRS 本地单用户边界](SRS.md#srs-sec-local)、`CR-030`（已归档） | `AC-SEC-LOC-001-01～05` | `TC-SEC-LOCAL-API-001`、`TC-SEC-LOCAL-FS-001`、`TC-SEC-PLUG-001`、[浏览器/Host 回归](../../apps/api/test/auth.test.ts) |
| `SEC-TEN-001` | 工作区/数据主体/组织隔离 | CAP-001～035 | `Deprecated` | [SRS 租户隔离（已替代）](SRS.md#srs-sec-ten)、`CR-030`（已归档）；替代：`SEC-LOC-001` | — | 历史 `TC-SEC-TENANT-001`、`TC-INTEG-RLS-001` 仅保留为迁移期旧 Schema 证据 |
| `PRIV-CONS-001` | 分 purpose 同意与撤销 | CAP-009/020/023/027 | `Specified` | [同意与偏好](DATA_PRIVACY.md#privacy-consent) | `AC-PRIV-CONS-001` | `TC-PRIV-CONSENT-001` |
| `PRIV-RET-001` | 召回/历史/备份期限分离 | CAP-005/009/013 | `Specified` | [召回与保留](DATA_PRIVACY.md#privacy-retention) | `AC-PRIV-RET-001` | `TC-PRIV-RET-001` |
| `OPS-QUEUE-001` | 至少一次队列与 DLQ | CAP-005/009/012/020 | `Mapped` | [架构运行约束](ARCHITECTURE.md#arch-consistency) | `AC-OPS-QUEUE-001` | `TC-RES-QUEUE-001` |
| `OPS-REL-001` | 模型/队列/存储降级与回滚 | CAP-002/005/009 | `Mapped` | [AI 回滚](AI_QUALITY_SAFETY.md#ai-rollback) | `AC-OPS-REL-001` | `TC-RES-DEGRADE-001` |

占位的 `AC-*` 和 `TC-*` 是稳定追踪 ID，不代表测试已经实现；目标版本的 G1 门禁必须把它们替换为可点击的用例、CI 任务或人工证据。若需求被取消，保留 ID 并标记 `Deprecated`，不能删除行。

反向必须能够从任一失败测试定位到 `AC-*`、原子需求、`CAP-*` 和对应产品目标。测试不得只引用需求标题或自然语言章节名。

### 8.3 验证证据

验证策略与测试分层见[测试策略](TEST_STRATEGY.md)。证据直接链接用例、CI、人工验收或生产验证；包含代码版本、环境和结果，避免再维护一张“最近运行结果”表。安全、删除、迁移和权限不能只凭一次人工体验通过。

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

<a id="privacy-gates"></a>
<a id="security-gates"></a>

### 9.1 专项发布门禁

| 专项 | 必须闭合的证据 | 规则来源 |
|---|---|---|
| AI/人格/Prompt | 固定版本评估集、可重放输入、标注协议/样本与置信区间；教学、记忆、日记和安全阈值；对抗样本、灰度与回滚条件 | [AI 质量](AI_QUALITY_SAFETY.md) |
| 数据与同意 | 发布内实体用途/分类/责任/保留规则；同意界面、撤权、历史影响与默认值；导出独立可读且保留来源/缺失状态；分析字段最小化 | [数据隐私](DATA_PRIVACY.md) |
| 删除与恢复 | 消息、摘要、记忆、日记、索引、缓存、附件与外部处理者的全链 E2E；全局 deny 下校验独立恢复账本签名/连续 sequence/最老备份覆盖/业务水位并按序重放；零召回/零越权后恢复 | [删除 SLA](DATA_PRIVACY.md#privacy-deletion-sla)、[恢复账本](SRS.md#srs-br-ctrl) |
| SQLite 破坏性迁移 | 停写、一致性可读备份、显式数据范围、冲突拒绝、staging 完整性、原子换库、可用 rollback 包与恢复演练 | [迁移演练](../how-to/run-database-migration-drill.md) |
| 安全/供应链 | Critical/High 威胁的自动化测试、告警与残余风险批准；ASVS L2、依赖/Secret/SBOM/许可证；loopback/Token、文件 ACL、插件/附件/Prompt injection、Electron IPC 与供应商故障演练 | [威胁模型](THREAT_MODEL.md) |
| CAP-033 | 签名 Host/OS Broker、全来源/授权修订、本地 Provider/存储/出网故障注入、七天+提炼、后台恢复通知、全动作快照、撤权零召回/零动作、可读导出；控制面、原文、确认记忆、触发与 ContextManifest 均证明不出本机 | [主动智能阻断项](#proactive-blockers) |
| CAP-034/035 | HA SSRF/私网白名单/重连与版本矩阵、凭据零回显、真实小米厂商沙箱/账号资格、健康连接级删除；本地集成测试不能代替厂商审批和生产安全评审 | [ADR-019](adr/ADR-019-proactive-integrations-local-gateway.md) |
| 后续高风险范围 | 未成年人、社区、市场、支付、机构及新增设备捕获先扩展数据/威胁与专项评审，未完成保持禁用 | [PRD 范围](PRD.md#23-mvp-边界不是产品终局) |

## 10. 风险登记

风险保留稳定 ID、影响、缓解和状态；接受或关闭时链接证据，注明有效期和重评条件。P/I 评分沿用原基线，发布前按实际范围复核。

### 10.1 风险基线

以下评分为立项初值，应在阶段启动时复核。

| 风险 ID | 风险 | 关联能力 | P | I | 分数 | 初始缓解措施 | 状态 |
|---|---|---|---:|---:|---:|---|---|
| `RISK-001` | 教学幻觉、错误答案或不可验证题目进入掌握数据 | `CAP-002/003/007/011/012` | 4 | 5 | 20 | 标准题评估集、来源标注、不可验证结果禁止入库、模型回滚 | Open |
| `RISK-002` | 高风险情绪漏判、错误响应或人格覆盖安全规则 | `CAP-008/019` | 3 | 5 | 15 | 固定安全响应、独立分类、对抗集、地区化求助和审计 | Open |
| `RISK-003` | 记忆过度压缩、错误晋升、冲突合并或虚假关系 | `CAP-005/015` | 4 | 5 | 20 | 分层版本、来源链、关键约束评估、用户确认和回滚 | Open |
| `RISK-004` | 删除未传播到摘要、日记、记忆树、索引或缓存 | `CAP-005/009/013/026/027` | 3 | 5 | 15 | 删除依赖图、异步补偿、审计任务和端到端删除测试 | Open |
| `RISK-005` | 日记虚构用户经历、言论或敏感情绪并形成错误记忆 | `CAP-009` | 3 | 4 | 12 | 段落级来源、禁止无来源生成、纠错阻断晋升 | Open |
| `RISK-006` | 插件越权、恶意依赖、升级破坏或供应链攻击 | `CAP-020/031` | 3 | 5 | 15 | 沙箱、签名、最小权限、版本锁定、SBOM 和一键撤权 | Open |
| `RISK-007` | 未来跨设备同步若引入多个可写副本，冲突可能造成数据丢失或权限泄露 | `CAP-023/027` | 3 | 4 | 12 | 冲突模型、不可变事件、备份恢复、加密和迁移演练 | Open |
| `RISK-008` | 未成年人、情绪/健康内容和监护可见范围不合规 | `CAP-008/028/032` | 3 | 5 | 15 | 成人首发边界、独立年龄方案、最小可见和法务评审 | Open |
| `RISK-009` | 参考代码、生成内容、题库、论文或市场内容侵权 | `CAP-011/020/021/023/024/029/031` | 3 | 4 | 12 | 许可证清单、来源记录、版权审核、下架和申诉流程 | Open |
| `RISK-010` | 模型延迟、调用成本或供应商故障破坏核心体验 | `CAP-002/003/005/009/012` | 4 | 4 | 16 | 模型路由、预算、缓存、超时降级、限流和供应商替换 | Open |
| `RISK-011` | P0-P3 范围持续扩张，导致核心闭环和安全基础延期 | `CAP-001`～`CAP-035` | 5 | 4 | 20 | 阶段基线、DoR、变更控制、容量预算和退出条件 | Open |
| `RISK-012` | 完全访问被误开启，或自动授权在关闭后被跨模式复用，导致未确认写操作 | `CAP-002/007/020/033` | 3 | 5 | 15 | 默认关闭、风险确认、Turn 级快照、CAP-033 独立全动作授权快照、授权关闭后排除、双端可见状态 | Open |
| `RISK-013` | 广域设备/应用捕获、私人文档或画像推断未经独立授权被记录，或经远程存储/模型/向量/日志离开本机；全动作授权被滥用或原始副本未按七天/提炼规则清理 | `CAP-002/005/007/008/009/012/013/018/020/022/023/024/026/027/030/033` + Agent Host/Inbox 基础设施 | 4 | 5 | 20 | 版本化完整画像与动作 Consent、OS Permission Broker 与签名 Host、强制本地私密存储与 Provider 校验、未授权来源 fail closed、`local_only` 传播、七天捕获提炼门、动作目标/修订审计、撤权零召回、导出/删除门禁 | Open |

风险关闭必须提供风险已经消失或降低到可接受级别的证据。接受风险必须记录接受理由、有效期限和重新评估触发条件。

## 11. 未决项与决定索引

未决项只在本节维护，推进顺序由 [plan.md](../../plan.md) 决定。已确认方向回链 ADR 或 SRS；部分确认仅允许已确认范围，不能借文档迁移扩大实现或授权。日期、修改人和讨论过程由 Git/PR 保存。

### 11.1 产品待验证问题

`EXP-001～003` 的价值假设与指标仍在 [PRD](PRD.md#13-核心假设)。以下从原 PRD 待验证问题收拢；新增 `DEC-PRD-*` 仅提供追踪身份，不表示新增产品承诺。现行日记视角、空素材处理、记忆期限等已定义行为以 SRS/数据隐私为准，研究结果改变它们时另行决策。

| ID | 待验证问题 | 边界 |
|---|---|---|
| `EXP-001` | 用户是否真的愿意使用“桌宠式入口”，还是只需要一个轻量学习工作台？ | 待验证；不改变现行需求 |
| `EXP-001` | 提示而非答案是否提高学习效果，还是增加了挫败感？ | 待验证；不改变现行需求 |
| `DEC-PRD-003` | 用户愿意保存哪些学习和情绪信息，哪些信息必须默认不保存？ | 待验证；不改变现行需求 |
| `DEC-PRD-004` | 复习提醒的频率和主动程度如何平衡价值与打扰？ | 待验证；不改变现行需求 |
| `DEC-PRD-005` | Web 版在验证阶段是否足够，桌面常驻是否能带来可测量增益？ | 待验证；不改变现行需求 |
| `DEC-PRD-006` | 会话地图是否能帮助用户回到关键推理节点，还是会增加学习认知负担？ | 待验证；不改变现行需求 |
| `DEC-PRD-007` | 在永久本地单用户真源下，是否需要受控跨设备体验；独立端与同步须先裁决所有权、删除及授权传播，不重启云端多租户目标。 | 待验证；不改变现行需求 |
| `DEC-PRD-008` | 外部题库、插件、社区和机构模式分别能否带来足够价值，抵消权限、审核和运营成本？ | 待验证；不改变现行需求 |
| `DEC-PRD-009` | 未成年人版本是否应作为独立产品线，而不是在成人版本上简单打开年龄开关？ | 待验证；不改变现行需求 |
| `DEC-PRD-010` | 四段记忆的默认 AI 召回期限、用户历史保留期限、压缩程度和晋升阈值如何在“记得足够”和“不过度保存”之间平衡？ | 待验证；不改变现行需求 |
| `DEC-PRD-011` | 系统记忆已采用树状投影视图和跨主题关系边；仍需验证哪些关系类型默认展示、何时折叠，以及怎样避免视图复杂度增加认知负担？ | 待验证；不改变现行需求 |
| `DEC-PRD-012` | 每日日记的默认视角应是桌宠第一人称、客观学习日报，还是由用户首次选择？ | 待验证；不改变现行需求 |
| `DEC-PRIV-001` | 原账户删除的可撤销等待期如何映射到纯本地单用户删除；具体期限须按上线地区评审，不能静默改为无等待或无限保留 | 待裁决；立即 deny 与已承诺删除 SLA 仍有效 |
| `DEC-PRD-013` | 无互动日是生成简短日记、邀请补充，还是默认跳过，哪种方式更少打扰且更有陪伴感？ | 待验证；不改变现行需求 |

<a id="proactive-decisions"></a>

### 11.2 主动智能决定与未决细节

| 决策 ID | 待确认问题 | 当前基线 | 状态与权威需求 |
|---|---|---|---|
| `DEC-PRO-001` | 完整画像授权包的实际清单是否包含应用/窗口、浏览器、键鼠/剪贴板、屏幕、音视频、位置和其他来源，以及原始内容的粒度 | 全部列入版本化 manifest，用户可一次确认；受保护输入和凭据仍不持久化 | 已确认  [SRS](SRS.md#srs-pro-001-全量画像授权与激活) |
| `DEC-PRO-002` | 授权包是否允许设备重启、开机自启、应用退出后持续和休眠恢复 | 允许；启用、恢复和异常必须告知用户 | 已确认  [SRS](SRS.md#fr-pro-004-后台生命周期与恢复) |
| `DEC-PRO-003` | 关闭后默认保留还是删除本地数据 | 立即停止使用，由用户在保留/导出/删除中显式选择 | 部分确认  [SRS](SRS.md#fr-pro-006-暂停撤权与删除) |
| `DEC-PRO-004` | 文件是一次性导入、持续 watcher 还是两者同时支持 | 支持用户明确授权的持续 watcher，并显示每个来源状态 | 已确认  [SRS](SRS.md#fr-pro-002-全量来源观察) |
| `DEC-PRO-005` | 源文件离线后是否保留加密原文副本，原始屏幕/音频/输入缓冲保留多久 | 原始捕获副本保留 7 天，且完成记忆提炼后才可删除；用户主动删除可提前触发 | 已确认  [SRS](SRS.md#br-pro-004-原始副本保留与提炼) |
| `DEC-PRO-006` | 「本地」是否允许局域网模型/自托管主机 | 首版只允许同机 loopback/本地进程 | 待确认  [SRS](SRS.md#br-pro-003-本地处理边界) |
| `DEC-PRO-007` | Restricted 文档、健康/情绪内容是否进入主动分析 | 可纳入专用 `restricted.profile` scope，仅本地分析并单独展示高敏风险提示；不做商业定向、临床诊断或操控 | 部分确认  [SRS](SRS.md#priv-pro-001-全量画像同意) |
| `DEC-PRO-008` | 是否允许习惯推断自动持久化并参与个性化，什么状态才叫 verified | 允许自动保存 `inferred` 并参与本地个性化；`verified` 仍需用户确认 | 部分确认  [SRS](SRS.md#aiq-pro-001-画像推断质量) |
| `DEC-PRO-009` | 主动输出是否包含后台自动执行普通本地操作 | 允许全部声明动作，包括本地、外部、浏览器/家居、特权和不可逆动作；均以用户确认的 `FullProfileActionGrant` 为授权来源 | 已确认  [SRS](SRS.md#br-pro-005-全动作授权快照) |
| `DEC-PRO-010` | 导出是否包含原文件/绝对路径，是否增加密码加密包 | 默认只导出可读结构化数据和来源清单，不包含密钥 | 部分确认  [SRS](SRS.md#fr-pro-007-主动画像导出) |
| `DEC-PRO-011` | 哪个设备/安装实例拥有主动激活权，多窗口/Web+桌面如何仲裁，后台 helper 是否保持常驻 | 设备级 `FullProfileGrant` + activation epoch；只允许用户可见的受信 Host 持有 | 部分确认  [SRS](SRS.md#sec-pro-001-受信-host-与-os-权限) |
| `DEC-PRO-012` | OS/iCloud/OneDrive 自动备份和用户将导出写入云同步目录是否违反「不上传云端」 | 主动存储不进入自动云备份；用户显式导出是独立行为，目标清单与提示待冻结 | 部分确认  [SRS](SRS.md#priv-pro-002-本地持久化与不出云) |
| `DEC-PRO-013` | 非用户原因的 `suspended` 在前置恢复后是否自动继续，哪些原因必须重新确认 | 允许在用户已授权的自启/休眠/重启设置下自动恢复并告知用户；显式暂停仍需手动恢复 | 已确认  [SRS](SRS.md#br-pro-006-后台恢复与通知) |
| `DEC-PRO-014` | 继续作为现有 CAP Overlay，还是新建「全域感知与个人画像」 CAP | 新建 `CAP-033`，并与既有 CAP 建立显式关联 | 已确认  [SRS](SRS.md#8-cap-033-全域感知与个人画像主动智能模式) |
| `DEC-PRO-015` | 当前平台的 mandatory 权限不完整时，是否禁止模式，还是显示「主动智能模式受限」 | 纳入当前平台全部可用能力；缺失 OS 能力必须显示缺口，不静默声称已获得该能力 | 已确认  [SRS](SRS.md#br-pro-001-激活前置与状态) |

<a id="proactive-blockers"></a>
<a id="11-当前实现阻断项"></a>

### 11.3 主动智能实现阻断

以下保留原 `PRO-BLOCK-001～012` 的问题与关闭条件；这是既有证据边界，本轮文档整理未重新执行平台或生产验证。关闭需要对应 PR/测试证据，不能仅改计划状态。剩余门禁关闭前，可继续文档、静态原型、契约骨架和无用户数据测试，不扩大真实广域采集或对未授权来源执行后台动作。

| 阻断 ID | 已记录缺口 | 进入实现前的最少处置 |
|---|---|---|
| `PRO-BLOCK-001` | `aervox_memory_store` 仍是普通工具注册表路径，尚未完成与 CAP-033 `profile_observation/profile_action` grant 的全链路一致性校验 | 记忆工具执行前校验 purpose/scope；推断只写未验证候选和证据，不直接成为长期事实；已接入的本地提炼器先写 CAP-033 claim |
| `PRO-BLOCK-002` | CAP-033 已使用独立本地 Vault 和加密 Port，但生产部署仍需证明连接不会回退到远程 `DATABASE_URL`，并完成全量实体准入 | 建立强制本地的私密存储 Port 和连接准入校验，覆盖正文、控制面、确认后记忆与触发历史 |
| `PRO-BLOCK-003` | CAP-033 确定性本地提炼器已接入；通用 LLM/Embedding/OCR/ASR Provider 仍可指向远端 | 在 ContextBuilder 和处理器入口校验 Provider 身份/进程/传输与出网策略，禁止 redirect/代理转发，非本地 Provider fail closed |
| `PRO-BLOCK-004` | 当前附件以 `objectKey` 键建模并落盘本地附件目录（无远程对象存储依赖），但尚无面向私人文档的独立适配层 | 为私人文档提供独立本地文件适配器，禁止隐式进入远程对象存储 |
| `PRO-BLOCK-005` | 已建立独立的 CAP-033 observation/claim 数据面，但 `aervox_memory_store` 与普通分析/审计旁路的隔离仍需验证 | 在 `CAP-022` 下建立用途受限的本地行为来源，不复用分析/审计旁路 |
| `PRO-BLOCK-006` | 当前桌面端已具备本地 Host、后台 helper/heartbeat 和部分生命周期控制，但系统级观察适配器、生产签名、OS entitlement、功耗和崩溃恢复仍不完整 | 完成受信首方 helper、操作系统 entitlement/usage description、权限降级、后台生命周期和平台测试 |
| `PRO-BLOCK-007` | CAP-033 已增加 owner-only loopback token；测试注入可显式关闭，生产配置与代理/redirect 禁止仍需部署验证 | 本地私密模式需绑定受信 IPC/loopback + 本地身份，不以开发默认值作为产品边界 |
| `PRO-BLOCK-008` | Turn 级 `full_access` 仍是 CreateTurn 请求快照；现有实现已覆盖本地 ProfileRevision/activation lease/heartbeat/token，但 Web+Host 多窗口/设备所有权与断连收敛未完整验证 | 完成 `FullProfileGrant`/激活 epoch/heartbeat/expiry、多窗口/设备所有权与断连收敛；不以该状态代替 Turn 级 ToolApproval |
| `PRO-BLOCK-009` | 广域捕获可包含 symlink/path escape、隐藏凭据、压缩炸弹、未知类型、Secure Input 或旁观者数据 | 冻结 canonical path/time-of-read 复验、symlink 边界、类型/大小/解压比、secret/Secure Input filter、旁观者处理、未知分类 fail closed 和分类测试 |
| `PRO-BLOCK-010` | 当前已接入 Aervox activity/operation、剪贴板、屏幕、浏览器历史元数据、显式文件根、HA 授权实体事件和小米健康每日指标；应用活动正文、通信、音视频、位置及其它平台传感器尚未完成 | 为剩余来源建立签名 provider、权限状态机、收集失败降级和功耗/磁盘配额测试；HA/健康仍须生产兼容门禁 |
| `PRO-BLOCK-011` | 当前已建立原始捕获、行为观察、画像声明、权限回执和导出模型；全量来源时间线、外部动作历史和生产迁移仍未完整验证 | 完成 `RawCaptureSegment` 七天/提炼门、`ProfileClaim` 证据链、画像版本和导出 manifest/checksum 验证 |
| `PRO-BLOCK-012` | 当前已建立本地 Vault、动作授权器和确定性提炼器；全链 `local_only`、Provider 本地证明、远端旁路隔离和零外传故障注入仍待验证 | 完成全链 provenance 传播、本地 Provider 证明、控制面隔离和零外传故障注入 |

上述阻断未关闭前，主动智能模式不得进入 `Ready`，也不得通过改 UI 文案对外声称已满足「不上传云端」。

<a id="mobile-decisions"></a>

### 11.4 移动端提案

原 CR-055 的移动端方案由 [ADR-022](adr/ADR-022-mobile-runtime-access.md) 承接，保持 Proposed。M0 尚须裁决配套/独立优先级、平台顺序、认证与跨设备可见范围；[M-AC-01～09](SRS.md#mobile-proposal-acceptance) 仍是建议，原生签名、真机网络、生命周期、`local_only` 拒绝和发布证据不得由 Web 构建或本地 API 测试代替。

## 12. 变更与维护

日常修复只更新受影响的行为/契约和测试；新增或调整能力时更新 SRS 与本表受影响行。重大架构、数据、权限或已发布承诺的变更先形成可评审决定，流程见[贡献指南](../../CONTRIBUTING.md)。不用为每次提交新增交付日志或重复登记表；具体测试结果留在 PR，公开发布状态须有目标环境证据。

<a id="operational-decisions"></a>

### 本地发布与成本目标待复审

- 云端月可用性及 RPO/RTO 指标不能直接作为本地桌面发布目标，需结合设备、分发和备份恢复形态重估；保留 SRS 的历史目标及暂缓说明，备份/删除/恢复账本责任不因此暂停。
- 进入相关架构与数据发布验收前，产品/技术/财务须批准每有效学习会话成本、每活跃用户月成本 P50/P95 和总月预算。当前数值未定；成本降级策略见架构，不能用降低安全或删除能力达标。
