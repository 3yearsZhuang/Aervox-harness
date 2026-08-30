# Aervox 架构决策记录（ADR）

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-31

> 状态：评审候选  
> 更新日期：2026-08-31
> 架构基线摘要：[ARCHITECTURE.md 第 11 节](../ARCHITECTURE.md#11-首批-adr)  
> ADR 文件编号与评审登记以本文件为准

ADR 记录难以逆转、影响多个模块或改变数据/运维边界的技术决策。编号一经分配不复用；被替代时保留原文并标记 `Superseded by ADR-###`。分类、状态维度和 canonical 元数据规则以[文档治理与事实源规范](../document-governance.md)为准，本文只维护 ADR 导航和决策摘要。

## 当前决策

| ADR | 状态 | 决策 | 独立记录 |
|---|---|---|---|
| ADR-001 | Proposed | 模块化单体 + Worker，而非 MVP 微服务 | [ADR-001](ADR-001-modular-monolith.md) |
| ADR-002 | Superseded by ADR-015 | React/Vite + Fastify + OpenAPI/SSE（Web 基线已改） | [ADR-002](ADR-002-web-api-contract.md) |
| ADR-003 | Proposed | 仓储抽象架构：SQLite 业务真源与 FTS5/Vector Port | [ADR-003](ADR-003-postgres-retrieval.md) |
| ADR-004 | Proposed | 业务状态 + Outbox + 幂等队列 | [ADR-004](ADR-004-outbox-idempotent-jobs.md) |
| ADR-005 | Proposed | 内部 Provider Port 包裹 AI SDK | [ADR-005](ADR-005-provider-port.md) |
| ADR-006 | Proposed | AI 召回期限与用户历史保留期限分离 | [ADR-006](ADR-006-recall-retention.md) |
| ADR-007 | Proposed | 系统记忆树是长期记忆的可重建投影 | [ADR-007](ADR-007-memory-tree-projection.md) |
| ADR-008 | Proposed | Cloud-first，P2 增加本地/自托管 Port | [ADR-008](ADR-008-cloud-first-local-port.md) |
| ADR-009 | Proposed | Electron 最小权限壳；插件进程外运行 | [ADR-009](ADR-009-electron-plugin-sandbox.md) |
| ADR-010 | Proposed | DSH/pi 仅为可选适配器 | [ADR-010](ADR-010-dsh-pi-adapters.md) |
| ADR-011 | Proposed | 日记周期、计划修订与连续窗口 | [ADR-011](ADR-011-diary-cycle-schedule-revision.md) |
| ADR-012 | Proposed | 可恢复流式协议、输出安全门与部分响应持久化 | [ADR-012](ADR-012-streaming-safety-persistence.md) |
| ADR-013 | Proposed | 独立恢复控制账本与撤权先行 | [ADR-013](ADR-013-recovery-control-ledger.md) |
| ADR-014 | Accepted | 演进式模块化单体：apps/api 按领域模块组织 | [ADR-014](ADR-014-modular-monolith-structure.md) |
| ADR-015 | Proposed | Vue 全栈单栈：Web 复用桌面端技术族，替代 ADR-002 Web 基线 | [ADR-015](ADR-015-vue-full-stack.md) |
| ADR-016 | Accepted | 底座边界冻结：Kernel Substrate 与能力层依赖边界，`scripts/import-boundary.mjs` 机器校验 | [ADR-016](ADR-016-base-boundaries.md) |
| ADR-017 | Proposed | ContextManifest/ModelRun/AgentStep 关联（ModelRun 唯一父级，新增 attemptId/stepId）+ AgentInboxItem 数据模型与 claim/ack 消费 | [ADR-017](ADR-017-context-manifest-modelrun-step.md) |
| ADR-018 | Proposed | CAP-033 本地私密存储、受信主动智能 Host、OS Permission Broker、全动作授权与后台生命周期 | [ADR-018](ADR-018-proactive-local-privacy-host.md) |
| ADR-019 | Accepted | 主动智能外部连接采用本地网关、加密凭据、受控工具和连接级撤销 | [ADR-019](ADR-019-proactive-integrations-local-gateway.md) |

`Proposed` 不代表已经批准。当前独立记录是评审输入，不是 G2 通过证据；每条 ADR 必须补齐备选方案、后果、迁移、回滚和验证证据并经过评审，状态才能改为 `Accepted`。

ADR-011/012 是 2026-08-24 架构一致性审查新增的评审记录；因其状态仍为 `Proposed`，架构设计中的摘要表在决策接受或通过对应 `CR-*` 时再同步，不能把本登记视为已批准实现承诺。

## 模板

```markdown
# ADR-### 标题

- 状态：Proposed / Accepted / Superseded / Rejected
- 日期：
- 提出人 / 日期：
- 关联：CAP / NFR / DATA / SEC / PRIV / RISK / CR

## Context
## Decision drivers
## Considered options
## Decision
## Positive consequences
## Negative consequences and risks
## Migration / rollback
## Verification evidence
```
