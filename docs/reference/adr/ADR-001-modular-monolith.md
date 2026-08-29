# ADR-001 模块化单体 + 独立 Worker

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-29

- 状态：Proposed
- 日期：2026-08-23

- 关联：`CAP-001～035`、`NFR-REL-001`、`NFR-SCALE-001`、`OPS-QUEUE-001`、`RISK-011`

## Context

Aervox 首发需要对话、学习、练习/复习、四段记忆、日记、安全和附件处理，同时保留 P2 插件/本地模式、P3 社区/组织的演进空间。团队规模、真实流量和合规边界尚未验证，过早拆成微服务会增加分布式事务、删除传播、可观测性和运维成本。

## Decision drivers

- 业务数据、来源链和删除要求强事务一致；
- TypeScript 全栈应复用契约和领域规则；
- AI/日记/记忆后台任务需要独立扩缩容和故障隔离；
- P2/P3 未来可能按合规、团队或流量边界拆分；
- MVP 必须能在没有 DSH/pi/参考运行时的情况下独立工作。

## Considered options

1. 模块化单体，Web/API/Worker 分进程部署。
2. 从 MVP 开始按领域微服务化。
3. Serverless 函数拼装全部业务。
4. 直接以 DSH/Cordis 或第三方 Agent runtime 为应用内核。

## Decision

选择模块化单体：同一 TypeScript monorepo 和 SQLite 业务库 + 仓储抽象，领域模块拥有各自服务/仓储边界；API 处理同步与流式交互，Worker/Scheduler 处理记忆、日记、OCR、Embedding、通知和删除。跨模块通过命令、领域事件和事务 Outbox，不允许直接写其他模块表。

## Positive consequences

- 核心业务状态和 Outbox 可在一个事务提交；
- 简化本地开发、测试、部署、备份和删除传播；
- Worker 可独立水平扩展且不改变领域所有权；
- 可通过公开接口和事件边界为未来拆分保留 seam。

## Negative consequences and risks

- 单库/单代码库需要严格执行模块边界；
- 部署包较大，团队并行时可能出现耦合；
- P3 高流量社区、市场或组织域未来可能需要拆分；
- 数据库是重要故障域，必须做好 HA、PITR 和容量管理。

## Migration / rollback

MVP 不存在从微服务回迁。若某模块需拆分，先定义数据所有权、Outbox 消费、双写禁止、历史迁移、删除契约和回滚窗口；采用 strangler 方式切流。若拆分未达到收益或可靠性目标，在数据格式仍兼容时切回模块化单体适配器。

## Verification evidence

- 架构边界测试与禁止跨模块仓储依赖；
- SQLite/Redis/S3 集成测试；
- 100 并发流式会话和 2 倍峰值压测；
- Redis 丢失后 Outbox 重建、重复投递幂等、数据库恢复和删除账本回放演练。
