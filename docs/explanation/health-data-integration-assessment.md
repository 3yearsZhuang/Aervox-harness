---
id: AVX-EXPL-007
type: explanation
scope: baseline
owner: platform
doc_status: draft
decision_status: not-applicable
delivery_status: not-applicable
version: 0.2.0
updated_at: 2026-08-29
reviewed_at: 2026-08-29
review_interval_days: 90
review_triggers:
  - Aervox 移动端形态或详情载体变化
  - DATA_PRIVACY / 未成年保护边界变化
  - 苹果或小米健康接入政策变更
sources:
  - docs/explanation/home-assistant-integration-assessment.md
  - docs/reference/agent-harness-loop.md
  - docs/reference/DATA_PRIVACY.md
  - docs/reference/changes/CR-025-proactive-intelligence-suite-integrations.md
  - docs/reference/adr/ADR-019-proactive-integrations-local-gateway.md
---

# 运动与健康数据接入评估

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-29

本文评估 Aervox｜思隅接入苹果（Apple Health）、小米（小米运动健康）运动与健康数据（步数、睡眠、情绪健康等）的可行性与方案取舍，作为 [Home Assistant 集成评估](home-assistant-integration-assessment.md)（AVX-EXPL-006）的姊妹评估。小米官方开放平台的“每日规范化指标 + 本地 Vault”路径已由 [CR-025](../reference/changes/CR-025-proactive-intelligence-suite-integrations.md) 与 [ADR-019](../reference/adr/ADR-019-proactive-integrations-local-gateway.md) 接受并实现；苹果、移动端聚合层和情绪健康仍只保留为评估输入。

## 一句话模型

健康数据是"个人状态"类外部事实：步数/活动为低敏，睡眠/心率/呼吸为中高敏，情绪/心理状态为最高敏。Aervox 当前无 iOS/Android 原生 App，苹果生态只开放设备侧 HealthKit 与手动导出、无公开云端 API，小米生态以官方开放平台云端 API 为主通道；因此实时接入两大生态均受限，R0 只能覆盖小米云 API 与本地文件导入，情绪健康默认拒绝。

## 1. 评估目标与边界

### 1.1 为什么此时评估

1. 与 Home Assistant 评估同源：桌宠"主动智能"需要感知用户状态（作息、活动、情绪趋势），运动健康数据是最直接的个人状态信号。
2. 学习场景高相关：睡眠与情绪状态和复习效率、专注度、提醒时机的关联（CAP-003/006 类能力可受益）。
3. 需要提前认定：健康数据的高敏性与未成年人保护红线会约束产品形态，评估应在立项前进行。

### 1.2 数据敏感分级（本评估的分类口径）

| 数据 | 来源 | 敏感级 | 初判用途 |
|---|---|---|---|
| 步数/活动/锻炼 | 手环/手表/手机 | 低敏 | 学习提醒参考、桌宠活力反馈 |
| 睡眠时长/阶段 | 手环/手表 | 中敏 | 复习调度与"免打扰"联动 |
| 心率/静息心率/HRV/压力 | 手环/手表 | 中高敏 | 状态感知（不承诺健康建议） |
| 血氧/体温/呼吸 | 手环/手表 | 高敏 | 默认不接入 |
| 情绪/心理状态（State of Mind 等） | 手动记录/派生 | 最高敏 | **默认拒绝**，除非单独同意并隔离 |

### 1.3 不变量（与 AVX-EXPL-006 §1.3 对齐，补充健康专属红线）

- 健康数据不是学习、记忆、日记或会话事实源；睡眠/情绪信号不得自动改写复习计划，只能作为建议输入；
- 高敏与最高敏数据默认 fail-closed：未显式授权不采集、不存储、不进模型上下文；
- 未成年人场景默认不接入健康数据（情绪与睡眠均属[未成年保护红线](../../AGENTS.md)范围内）；
- 数据不出本地优先边界：若经云端 API 拉取，须明示数据流经第三方云的事实并纳入 [DATA_PRIVACY](../reference/DATA_PRIVACY.md) 门禁。

## 2. 接入路径盘点

### 2.1 苹果生态（Apple Health）

| 路径 | 能力 | 限制 |
|---|---|---|
| HealthKit SDK（`HKHealthStore`） | 逐项授权读写步数/睡眠/心率/State of Mind 等 | **仅 iOS 原生 App** 可调用；无 Web/桌面 API |
| 健康 App 手动导出（`export.xml` / `export.zip`） | 一次性全量导出 | 手动、非实时；社区工具（如 apple-health-mcp）已可解析 |
| 共享/医疗连接（Health Records） | 与医生共享、支持平台 | 医疗场景，不适用第三方消费 |
| 公开云端读写 API | 不存在 | 苹果不以 OAuth Web API 对外提供实时健康数据 |

结论：**无 iOS 原生 App 则无实时路径**；本地文件导入是唯一不依赖移动端的接入方式。

### 2.2 小米生态（小米运动健康 / Mi Fitness / Zepp Life）

| 路径 | 能力 | 限制 |
|---|---|---|
| 小米开放平台（运动健康开放 API） | 官方 OAuth 2.0 + 云端健康数据接口（步数/睡眠/心率/血氧等） | 需开发者入驻与资质审核；数据经小米云；接口与审核以平台最新政策为准 |
| 写入 Apple Health / Health Connect 后读取 | 手环数据经 Mi Fitness app 写入系统健康聚合层 | 读取端仍需 iOS/Android 原生能力（HealthKit / Google Health Connect） |
| 直接 BLE 读手环 | 实时、本地 | 私有协议、兼容性差、非官方支撑 |
| 社区非官方接口/模拟客户端 | 各类社区步数同步工具 | **合规与稳定性风险，明确不采用** |

结论：**官方开放平台云 API 是小米侧唯一受控通道**；其余路径要么需原生移动端、要么不合规。

### 2.3 统一聚合视角

在手环/手表生态下，多数品牌（含小米）的设备数据会写入设备侧系统聚合层：iOS 汇入 Apple Health（HealthKit），Android 汇入 Google Health Connect。第三方只靠"读 Apple Health / Health Connect"即可覆盖多品牌（此为 Sahha 等 SaaS 的做法）。但该路径同样要求**原生移动端**，Aervox 落盘于 Web/Electron，短期不可达。

## 3. 与 Home Assistant 集成的关系

- Home Assistant 可桥接部分健康数据（iCloud 集成、Home Assistant Companion 的 HealthKit 实体、部分手环插件），但这依赖用户已有 HA 且接入质量与稳定性参差；
- 健康数据接入**不依赖** HA 立项，也不应被 HA 阻塞：两者共享工具/网关/SKM 授权框架（见 AVX-EXPL-006 §5），但数据源独立；
- 若两者均立项，可共用"外部数据源工具注册表 + 事件注入 Inbox"的同一接线点，避免平行基础设施。

## 4. 方案对比

| 方案 | 覆盖 | 实时性 | 成本 | 隐私 | 结论 |
|---|---|---|---|---|---|
| A. 小米开放平台云 API（OAuth 云端拉取） | 小米系设备 | 有（异步同步） | 中（入驻审核） | 数据经小米云，须披露 | R0 主通道 |
| B. Apple 健康导出文件导入（`export.xml` 解析为只读工具） | 苹果系设备 | 无（手动） | 低 | 全程本地 | R1 过渡通道 |
| C. HealthKit / Health Connect 原生桥 | 全部设备 | 有 | 高（需独立移动端） | 系统级授权模型最严格 | 远期（随移动端形态） |
| D. 第三方健康聚合 SaaS（如 Sahha） | 多品牌 | 有 | 低（接入简单） | 数据经第三方，违反本地优先 | 否决（除非未来本地优先条款放开） |
| E. 经 Home Assistant 桥接 iCloud/HealthKit 实体 | 部分 | 有 | 中 | HA 已授权域内 | 条件可选（依赖 HA 立项） |

**推荐**：R0 采用方案 A（小米云 API），方案 B（Apple 本地文件导入）作为不依赖云端即可体验的补充；方案 E 仅在 HA 立项后评估；方案 C 挂靠远期移动端；方案 D 否决。

## 5. 推荐设计要点

### 5.1 工具与数据面

- 只读工具集：`health_get_daily_steps`、`health_get_sleep_summary`（按天聚合），经只读白名单自动放行（对齐 AVX-HAR-001 §9）；
- 授权映射：低敏自动、中敏显式同意、高敏默认拒绝；情绪/心理最高敏默认拒绝，须独立开关且不进学习事实；
- 事件面（可选）：睡眠/异常心率变化可经事件订阅进 Inbox（与 AVX-EXPL-006 方案 B 同一机制），频控对齐 CAP-030。

### 5.2 凭据与数据治理

- 小米 OAuth 令牌按 AVX-EXPL-006 §5.2 相同口径：加密存储、租户隔离、不进日志与模型上下文；
- `export.xml` 导入为一次性解析为受限只读数据，不保留原始文件（解析后源文件即删）；
- 数据保留：派生摘要短保留（建议 ≤ 90 天），不进入学习事实；情绪数据如启用则单独存储与最短保留，并支持一键抹除。

### 5.3 风险共识（明确不做）

- 不做健康建议、诊断或"健康报告"（产品边界，非医疗产品）；
- 不自动改写复习/日程为主观依据：睡眠/情绪只作为建议输入，变更计划需用户确认；
- 不接入血氧/体温/呼吸等医疗敏感指标（R0/R1 均不启用）。

## 6. 分阶段路线

| 阶段 | 交付 | 准入 | 退出 |
|---|---|---|---|
| R0 | 方案 A：小米开放平台 OAuth + 只读步数/睡眠摘要工具 + 配置页 | 入驻资质确认、隐私评审 | 授权设备可查步数/睡眠，账本可查，撤权即停 |
| R1 | 方案 B：Apple 导出文件导入并解析为只读工具 | R0 证据、本地处理链路安全评审 | 导入可查、源文件即删、无云端残留 |
| R2 | 事件面：睡眠/活动变化订阅 → Inbox 注入（频控） | Inbox 与频控机制稳定 | 噪音受控、撤销即清 |
| R3 | 远期：原生移动端后评估 HealthKit / Health Connect 桥 | 移动端形态立项 | 系统级授权、数据隔离、未成年红线通过 |
| 未排期 | 情绪健康（State of Mind 等） | 单独 CR + 未成年保护专项评审 | 独立存储、最短保留、默认拒绝 |

## 7. 未决问题

1. 小米开放平台入驻资质与数据接口的准入条件，需以平台最新开发者文档为准（申请前需确认）；
2. 睡眠/活动信号参与复习调度（如"昨晚睡眠不足→推迟早间复习提醒"）的产品规则边界；
3. 情绪健康是否值得做（明显高于现阶段的隐私与未成年风险）；
4. 是否复用 AVX-EXPL-006 的事件订阅器代码路径，还是按数据敏感级独立实现。

## 8. 参考资料

- [在 iPhone 上的"健康"中共享你的数据（Apple 支持）](https://support.apple.com/zh-cn/guide/iphone/iph3e0ca2db/ios)
- [HealthKit · Apple Developer](https://developer.apple.com/documentation/healthkit)
- 仓库内架构框架：[Home Assistant 集成评估](home-assistant-integration-assessment.md)（AVX-EXPL-006）、[AVX-HAR-001 §9 工具执行管线](../reference/agent-harness-loop.md#9-工具执行管线)、[数据与隐私规范](../reference/DATA_PRIVACY.md)

外部资料只作产品与 API 事实参考；范围、权限、数据处理、威胁与门禁以仓库内 PRD、SRS、架构、隐私、威胁模型、ADR 与追踪基线为准。
