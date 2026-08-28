# CR-012 Agent Harness Loop 目标规范与迁移基线

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-28

> 文档编号：CR-012  
> 类型：Reference  
> 版本：v0.2
> 更新日期：2026-08-28  
> 状态：Review Candidate  
> 关联：[Agent Harness Loop 规范](../agent-harness-loop.md)、[架构设计](../ARCHITECTURE.md)、[流式协议](../STREAMING_PROTOCOL.md)、[ADR-009](../adr/ADR-009-electron-plugin-sandbox.md)、[ADR-010](../adr/ADR-010-dsh-pi-adapters.md)、[能力组合规范](../capability-composition.md)、[需求追踪](../REQUIREMENTS_TRACEABILITY.md)

## 变更

- **原因**：当前 Turn 路由只完成幂等落库并返回固定 `done` SSE；ToolRuntime、TurnAttempt、ModelRun、ContextManifest 和目标 Port 尚未被一个可恢复的 Agent 执行循环串联，无法支持真实模型流、Tool request、多 Step、取消恢复和外部 Loop Driver。
- **关联能力与需求**：`CAP-002/005/007/008/019/020/027`、`FR-STREAM-001`、`DATA-STREAM-001`、`NFR-REL-001`、`SEC-PLG-001`、`RISK-001/002/003/006/010`。
- **目标行为**：建立版本化 AgentLoop Definition、Native/Replay Loop Driver、ModelProviderPort、Turn/Attempt/Step 状态机、模型流式安全门、工具权限执行管线、租约/fencing、恢复和 Profile 替换边界；工具批次采用非空且全量终止策略；客户端继续使用现有 Turn/SSE 契约。
- **迁移约束**：当前 Outbox 仍产生 `turn.created`，目标事件为 `agent.turn.requested`；迁移期必须双读、幂等去重和兼容回放。工具副作用或结果未知时不自动重放，必须按 `replay: never/safe` 与幂等声明收敛。
- **范围外**：本 CR 不批准直接引入 DSH/pi 作为应用内核，不批准任意高权限工具，不改变 Aervox Session/Message/学习数据所有权，也不承诺本次立即完成代码实现。

## 影响文档

- 新增 [AVX-HAR-001](../agent-harness-loop.md)；
- 文档索引、从哪开始、生命周期登记表和术语表增加 Agent Harness Loop 入口；
- 参考设计迁移文档登记 `DSH-01` 与 `PI-01`；
- 需求追踪 §4.2 登记本轮规范文档化，后续按实施阶段继续登记代码和验证证据。

## 验证与回滚

- **验证**：`mise tasks run ci-docs`；相对链接存在；Reference、CR、索引、登记表和追踪关系一致。
- **回滚**：删除新增 Reference/CR 及其导航、术语和登记项即可；不涉及数据库或运行时行为变更。
- **批准后续**：代码实施前新增 ADR，冻结部署形态、数据实体和默认限额；每个阶段单独通过代码门禁、契约测试和安全评审。
