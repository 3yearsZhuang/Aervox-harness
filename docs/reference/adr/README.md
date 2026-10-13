# 架构决策记录

<a id="AVX-GUIDE-005"></a>

普通变更由 PR 说明问题、实现和验证。难以逆转、影响多个模块或改变数据、授权、部署边界的重大决定使用 ADR；修改既有决定时修订原 ADR，替代时保留原文并链接后继记录。未批准的建议保持 `proposed`，不能因文档整理自动变为已接受。

本索引手工维护主题链接；决策状态只在对应 ADR 的 `decision_status` 中维护，交付以 PR 和可复核验证为证，不在此复制状态矩阵。编号一经分配不复用；新增时核对已有编号。ADR-020 随 [PR #232](https://github.com/3yearsZhuang/Aervox-harness/pull/232) 回退退役，原文位于 `Aervox-docs-archive`，不得复用。

## 按主题查找

- [ADR-001](ADR-001-modular-monolith.md)：模块化单体 + 独立 Worker。
- [ADR-002](ADR-002-web-api-contract.md)：Web 端与 API 契约设计（已归档）。
- [ADR-003](ADR-003-postgres-retrieval.md)：仓储抽象架构：SQLite 业务真源与 FTS5/Vector Port。
- [ADR-004](ADR-004-outbox-idempotent-jobs.md)：业务状态 + Outbox + 幂等队列。
- [ADR-005](ADR-005-provider-port.md)：内部 Provider Port 包裹 AI SDK。
- [ADR-006](ADR-006-recall-retention.md)：AI 召回期限与历史保留期限分离。
- [ADR-007](ADR-007-memory-tree-projection.md)：系统记忆树作为可重建投影。
- [ADR-008](ADR-008-cloud-first-local-port.md)：Cloud-first 与本地/自托管 Port（已归档）。
- [ADR-009](ADR-009-electron-plugin-sandbox.md)：Electron 最小权限壳与进程外插件。
- [ADR-010](ADR-010-dsh-pi-adapters.md)：DSH/pi 仅为可选适配器。
- [ADR-011](ADR-011-diary-cycle-schedule-revision.md)：日记周期、计划修订与连续窗口。
- [ADR-012](ADR-012-streaming-safety-persistence.md)：可恢复 Turn 流式协议、输出安全门与部分响应持久化。
- [ADR-013](ADR-013-recovery-control-ledger.md)：独立恢复控制账本与撤权先行。
- [ADR-014](ADR-014-modular-monolith-structure.md)：演进式模块化单体：apps/api 目录结构。
- [ADR-015](ADR-015-vue-full-stack.md)：Vue 全栈单栈：Web 复用桌面端技术族。
- [ADR-016](ADR-016-base-boundaries.md)：底座边界冻结：Kernel Substrate 与能力层的依赖边界。
- [ADR-017](ADR-017-context-manifest-modelrun-step.md)：冻结 ContextManifest / ModelRun / AgentStep 关联与 Inbox 数据模型。
- [ADR-018](ADR-018-proactive-local-privacy-host.md)：CAP-033 本地私密存储与主动智能 Host。
- [ADR-019](ADR-019-proactive-integrations-local-gateway.md)：主动智能外部连接采用本地网关与受控工具。
- [ADR-021](ADR-021-aervox-core-standalone-package.md)：Aervox Core 独立内核包与最小发行边界。
- [ADR-022](ADR-022-mobile-runtime-access.md)：移动端运行与跨设备访问边界。
- [ADR-023](ADR-023-hls-research-execution.md)：隔离 HLS 研究执行边界。
- [ADR-024](ADR-024-native-runtime-boundaries.md)：原生计算、活动采集与进程边界。
- [ADR-025](ADR-025-ui-surface-hosts.md)：根界面插件与薄平台宿主。
- [ADR-026](ADR-026-ui-surface-open-ecosystem.md)：第三方界面开放与安装回滚提案。

## 原 CR 编号迁移索引

CR 流程已退役；下列编号只作为历史别名，不再创建独立 CR 正文。旧路径内容由 Git 历史保留，当前引用指向 ADR 锚点。

| 历史编号 | 当前决策 |
|---|---|
| CR-055 | [ADR-022：移动端边界](ADR-022-mobile-runtime-access.md#cr-055) |
| CR-057 | [ADR-023：HLS 研究](ADR-023-hls-research-execution.md#cr-057) |
| CR-060 | [ADR-016：插件与宿主分工](ADR-016-base-boundaries.md#cr-060) |
| CR-061 | [ADR-021：执行与恢复合同](ADR-021-aervox-core-standalone-package.md#cr-061) |
| CR-062 | [ADR-024：搜索与测量](ADR-024-native-runtime-boundaries.md#cr-062) |
| CR-063 | [ADR-024：原生运行](ADR-024-native-runtime-boundaries.md#cr-063)，[源码与 IPC 结构](ADR-024-native-runtime-boundaries.md#cr-063-layout) |

| CR-064 | [ADR-026：界面开放提案](ADR-026-ui-surface-open-ecosystem.md#cr-064) |
| CR-065 | [ADR-025：根界面装配](ADR-025-ui-surface-hosts.md#cr-065) |

## 最小记录格式

ADR 保留背景、备选方案、决定、后果、迁移/回退与验证方式。具体字段和接口仍在代码/契约，运行步骤在指南；不要把实施流水、测试计数或当前排期复制进 ADR。接受或替代决策时同步受影响契约和本索引的链接，评审与证据留在 PR。

```markdown
---
id: ADR-###
decision_status: proposed
---

# ADR-### 标题

## 背景
## 备选方案
## 决策
## 后果与回退
## 验证与证据
```

状态使用 `proposed`、`accepted`、`rejected` 或 `superseded`；被替代时添加 `superseded_by: ADR-###`。作者和日期由 Git 追踪。
| `ADR-025` | [根界面插件与薄平台宿主](ADR-025-ui-surface-hosts.md) | Accepted |
| `ADR-026` | [界面插件开放生态与安装回滚](ADR-026-ui-surface-open-ecosystem.md) | Proposed |
