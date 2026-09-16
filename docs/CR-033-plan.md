---
id: AVX-PLAN-033
type: reference
scope: temporary-plan
owner: maintainers
doc_status: draft
decision_status: not-applicable
delivery_status: not-applicable
version: 0.1.0
updated_at: 2026-09-16
reviewed_at: 2026-09-16
review_interval_days: 30
review_triggers:
  - docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
  - packages/contracts/**
  - packages/schema/**
  - packages/repositories/**
  - apps/worker/**
  - apps/api/src/modules/proactive/proactive/**
  - apps/desktop/**
sources:
  - docs/reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md
  - docs/reference/changes/CR-032-proactive-intelligence-plugin-ecosystem.md
  - docs/reference/changes/CR-023-proactive-local-intelligence-mode.md
  - docs/reference/ARCHITECTURE.md
  - docs/reference/REQUIREMENTS_TRACEABILITY.md
  - docs/reference/adr/ADR-009-electron-plugin-sandbox.md
  - docs/reference/adr/ADR-018-proactive-local-privacy-host.md
  - docs/reference/adr/ADR-019-proactive-integrations-local-gateway.md
---

# AVX-PLAN-033 临时计划：CR-033 态势内核与预算化干预实施拆分

- 提出人：3yearszhuang · 2026-09-14
- 修改人：3yearszhuang · 2026-09-16

> [!WARNING]
> 本文件是临时执行计划，不是新的产品、架构或 API 事实源。原始提案 [CR-033](reference/changes/CR-033-proactive-endgame-situation-core-and-budgeted-intervention.md) 仍是北极星基线；本文件不改变 CR-033、CAP-033 或任何 ADR 的状态。正式实施前必须拆分子 CR，并以子 CR 的实现级契约替代本文件。

## 1. 结论与实施边界

CR-033 的方向与本地 SQLite、独立 Worker、插件插槽和本地 Privacy Host 架构相容，技术上可行；但不能作为一个批次整体开工。当前实施决策应为 `More Evidence Required`，原 CR 保持 `Proposed / Planned`。

实施范围拆为：

| 子片 | 目标 | 依赖 | 交付性质 |
|---|---|---|---|
| E1 | `SituationModel v1` 投影与旧规则影子对比 | 共享契约 | 行为保持不变的重构 |
| E2a | 受限规则 DSL | E1 | 数据化规则 |
| E2b | 注意力预算与决策回执 | E1、E2a 的候选输出 | 行为增量 |
| P5 | 人格、安全、记忆同源 | 共享 Persona/Safety Port | 生成路径替换 |
| E3 | 感知事件流与订阅者 | 共享事件契约、E1 | 架构迁移 |
| O1 | 结构化操作目录与工具授权 | ADR-009/018/019 | 独立能力 CR |
| O2 | 提议、确认、执行、回执闭环 | E1、E2b、P5、O1 | 独立能力 CR |

依赖顺序：

```text
F0/G0-G1 → 共享契约 → E1 → E2a → E2b → E3
                         └→ P5（可与 E1 并行，启用新生成前必须完成）
O1 可与 E2 并行；O2 等待 E1、E2b、P5、O1
```

O4 像素级自主操作继续明确排除。

## 2. 开工前阻断项（F0）

1. 统一 [CAP-033 追踪状态](reference/REQUIREMENTS_TRACEABILITY.md) 与 [ADR-018](reference/adr/ADR-018-proactive-local-privacy-host.md) 的决策状态；在 signed Privacy Host、OS Permission Broker、本地出网证明、撤权删除和恢复证据闭合前，不得声称 CAP-033 `Ready`。
2. 解决 P2“SituationModel 是唯一视野”和 P5“复用 persona、记忆、安全管线”的语义冲突：唯一视野只指主动信号视图，persona revision、safety policy 和获准记忆引用走独立的 `ContextManifest`。
3. 补充 CR-033 未列全的依赖来源：CR-024、ADR-004、ADR-012、ADR-017、ADR-018、ADR-019，并为每个子 CR 分配 owner、AC/TC、成本、SLO、风险、用户通知和灰度负责人。
4. 建立独立 flag：`situation_projection`、`proactive_dsl`、`attention_budget`、`proactive_persona`、`perception_events`、`operation_catalog`、`operation_proposals`。

F0 退出条件：G0 范围/指标/风险明确，G1 需求、AC/TC、数据生命周期和阻塞决策全部 `Ready`。

## 3. 共享契约与不变量（F1）

先写契约和测试，不改变运行时行为。

- `situation_model_v1`：字段白名单、类型与 `unknown/null` 语义、来源授权修订、provenance、freshness、redaction、最大大小和可重建 watermark。
- 感知事件 envelope：`eventId`、幂等键、source/device/activation epoch、source grant、`occurredAt`/`ingestedAt`、SQLite ingestion sequence、schema version、payload digest 和因果信息。
- DSL：语言版本、AST、规范化序列化、canonical hash、字段/类型系统、深度/节点/字符串/步数/时间配额和未知节点行为。
- 预算与回执：全局/插件预算状态、反馈事件、`reserve → dispatch → settle/refund`、并发 CAS/幂等键、预算前后值、证据摘要、策略版本和审计引用。
- 操作 descriptor：工具身份/version、scope、目标白名单、参数 schema、可逆性、超时、补偿和确认方式。
- `ProactiveTurnContextPort`：API 与 Worker 共享的 persona revision、memory reference、safety policy version 和不可信插件层；Worker 不直接导入 `apps/api`。

所有契约生成 JSON/OpenAPI schema，并建立未知字段、未知版本和超限输入的 fail-closed 契约测试。

## 4. E1：SituationModel 影子投影

1. 在 proactive Vault 中以 additive 方式增加投影快照、字段 provenance 和 rebuild watermark 的 schema/repository Port。
2. 从现有 captures、observations、十二类派生表构建确定性投影；回填记录标记为 `backfill`，禁止静默合并或以 `MAX(rowid)` 选胜者。
3. 所有读取按 active revision、source grant、`local_only` 和 deny watermark 过滤；撤权、删除、导出和重建覆盖投影及索引。
4. 新旧规则并行求值，比较命中、抑制原因和证据摘要；内置规则要求 100% parity，例外必须有批准记录。
5. 影子期只写观测和差异指标，不改变用户可见结果；通过后才切换读取 flag。

退出条件：投影契约、重建、删除/撤权、写者快照、回放 parity 和故障恢复测试通过。

## 5. P5：人格与安全同源

1. 将对话侧 persona revision、允许技能、记忆召回引用和 safety policy 封装成共享 Port；不跨进程直接复用 API service 实例。
2. 插件 `SKILL.md` 只作为不可信场景叠加层，不能覆盖系统指令、身份、授权或安全策略。
3. 主动生成前执行安全分类，生成后执行输出检查；危机内容进入固定安全响应，安全服务不可用时保守拒绝。
4. 保留 CR-032 模板降级，设置独立主动生成延迟和成本预算；主动输出是否进入普通 Turn、记忆和日记必须先冻结语义。

退出条件：人格 revision 一致性、Prompt injection、危机拦截、策略版本审计、超时/Provider 失败和模板降级测试通过。

## 6. E2a：受限规则 DSL

- 仅允许比较、布尔、算术和有界时间窗函数；禁止 IO、循环、动态属性访问、任意函数和模型执行。
- 安装期静态检查字段白名单、类型、语言版本、深度、节点数、字符串长度和规范化 hash；运行期超时、未知节点和资源耗尽一律不命中。
- 旧五类 `triggerType` 保留读取兼容层；内置规则先编译为 DSL，再逐步允许插件声明 DSL。
- 通过 golden corpus、property/fuzz、恶意表达式、版本协商和 replay 等价性测试后再开放安装。

## 7. E2b：注意力预算与回执

1. 首版采用可复现的全局 + 插件预算模型；静态冷却、静音时段和全局硬上限永远是安全底线。
2. 预算扣减、派发、结算和失败退款在同一写者事务内完成，使用幂等键/CAS 防止并发超发；反馈来自打开、回复、忽略和操作生命周期。
3. 回执只保存必要的证据摘要、规则/策略版本、抑制原因、预算变化和审计引用，不保存无必要的原始敏感内容。
4. 先以 shadow/advisory 模式与 CR-032 静态裁决器比较，再进行小范围 canary；保留手动锁定和静态回退。

退出条件：确定性模拟、并发争用、饥饿/误静默、反馈删除/导出和 canary 指标满足 G3/G4。

## 8. E3：本地感知事件流

- 使用 SQLite 追加式事件流作为跨进程真源，采用原子 sequence、唯一幂等键、consumer offset、ACK、重放、过期 cursor、背压、DLQ、保留与压缩策略。
- 桌面端在源头做边沿聚合；连续活动必须保留 start/end/heartbeat 或区间事实，不能将 60 秒采样简单替换为无语义事件。
- ingest 前校验 source grant、activation lease、revision、`local_only` 和本地处理证明；事件流不进入普通远程数据面。
- 旧 capture→distill→polling 与新事件管线双跑，明确一个最终事实写者；以 p50/p95/p99 延迟、重复/丢失率、洪水压缩率、积压和资源占用作为切换门槛。
- 不把现有主动表现 SSE 当作感知总线；表现层只消费独立的、可重放的事件投影。

## 9. O1/O2 结构化操作域

O1 单独立 CR，先做可逆、本地、白名单原语。每个工具明确 `action.local`、`action.external`、`action.privileged` 或 `action.irreversible`，并定义目标实体、参数、幂等、超时、补偿、授权修订、OS grant 和 kill switch。第三方插件不能继承 Privacy Host 信任。

O2 只允许以下状态链：

```text
proposal → user_confirm / deny / expire / revoke → execute → result_receipt
```

提议可被预算静默；不可逆操作永不自动执行；桌宠确认与弹窗确认语义等价；未知执行结果不得自动重放，必须依靠幂等和人工 reconciliation。

## 10. 测试、指标与发布门禁

每个子 CR 独立通过：

- G2：架构、数据生命周期、威胁模型、迁移、成本和回滚评审；
- G3：build/typecheck、schema/OpenAPI、单测、集成、并发、重放、迁移和 E2E；
- G4：AI 安全、Prompt injection、隐私、性能、无障碍和恢复证据；
- G5/G6：灰度、仪表板、值班手册、备份恢复、回滚演练和发布后冒烟。

必须埋点：投影 lag、事件 p50/p95/p99、重复/丢失/积压、DSL 拒绝与超时、预算抑制/误静默、删除零召回、local boundary、操作授权竞态和未知结果率。具体阈值在 F0 冻结，不能用“秒级”或“测试通过”替代。

## 11. 迁移、回滚与文档闭环

各 flag 独立回退：E1 回旧表/evaluator；DSL 停止新声明并使用旧枚举；预算回静态裁决；P5 回 CR-032 composer；E3 停止 consumer/ingest 并恢复轮询；O1/O2 撤销 grants/全局 kill switch。新增 schema 一律 additive/expand-first；若必须换库，遵守“停写→备份→选择范围→staging→校验（含 FTS）→原子换库→保留回滚包”。

正式子 CR 实施后，需同步 PRD/SRS、ARCHITECTURE、DATABASE、DATA_PRIVACY、THREAT_MODEL、AI_QUALITY_SAFETY、TEST_STRATEGY、operations，并在 [REQUIREMENTS_TRACEABILITY.md §4.2](reference/REQUIREMENTS_TRACEABILITY.md#42-落地实现登记) 登记 CAP、路径、日期、验证方式和来源编号。

本临时计划在子 CR 建立并通过 G1 后失效，届时应迁移或删除，不得继续作为实现事实源。
