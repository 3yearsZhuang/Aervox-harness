# CR-012 Agent Harness Loop 目标规范与迁移基线

- 提出人：3yearszhuang · 2026-08-28
- 修改人：3yearszhuang · 2026-08-28

> 文档编号：CR-012  
> 类型：Reference  
> 版本：v0.3
> 更新日期：2026-08-28  
> 状态：Review Candidate  
> 关联：[Agent Harness Loop 规范](../agent-harness-loop.md)、[架构设计](../ARCHITECTURE.md)、[流式协议](../STREAMING_PROTOCOL.md)、[ADR-009](../adr/ADR-009-electron-plugin-sandbox.md)、[ADR-010](../adr/ADR-010-dsh-pi-adapters.md)、[能力组合规范](../capability-composition.md)、[需求追踪](../REQUIREMENTS_TRACEABILITY.md)

## 变更

- **原因**：初始 Turn 路由只有固定 `done` SSE，缺少可恢复 Loop。阶段 0/1/2a-2e/3a/3b-A/3b-B 已逐步补齐原生执行器、真实 OpenAI 兼容 Provider、只读/写工具审批、持久化 SSE、工具账本、lease TTL/续租、过期抢占、fencing 单一终态和 Worker 恢复；本 CR 继续记录 3c+ 生产级安全补强、异步 Driver、独立 Host、外部 Adapter 和完整上下文持久化缺口。
- **关联能力与需求**：`CAP-002/005/007/008/019/020/027`、`FR-STREAM-001`、`DATA-STREAM-001`、`NFR-REL-001`、`SEC-PLG-001`、`RISK-001/002/003/006/010`。
- **目标行为**：建立版本化 AgentLoop Definition、Native/Replay Loop Driver、ModelProviderPort、Turn/Attempt/Step 状态机、模型流式安全门、工具权限执行管线、租约/fencing、恢复和 Profile 替换边界；工具批次采用 Aervox `all-results-conclude`（非空且全量终止）策略；客户端继续使用现有 Turn/SSE 契约。
- **迁移约束**：当前 Outbox 仍产生 `turn.created`，目标事件为 `agent.turn.requested`；迁移期必须双读、幂等去重和兼容回放。工具副作用或结果未知时不自动重放，必须按 `replay: never/safe` 与幂等声明收敛。
- **参考实现约束**：DSH 固定版本使用 any/OR 工具终止，pi 低层 Loop 使用 every/all；两者均须由 Adapter 翻译为 Aervox `all-results-conclude`。pi `AgentHarness` v2 在固定版本仍是 scaffold，不得标记为已接入。
- **范围外**：本 CR 不批准直接引入 DSH/pi 作为应用内核，不批准任意高权限工具，不改变 Aervox Session/Message/学习数据所有权；DSH/pi 仍只作为后续可选 Adapter 或受限 Contribution。

## 影响文档

- 新增 [AVX-HAR-001](../agent-harness-loop.md)；
- 文档索引、从哪开始、生命周期登记表和术语表增加 Agent Harness Loop 入口；
- 参考设计迁移文档登记 `DSH-01` 与 `PI-01`；
- 需求追踪 §4.2 登记本轮规范文档化，后续按实施阶段继续登记代码和验证证据。
- 阶段 2e/3a/3b-A/3b-B 的代码落地和验证继续登记在需求追踪 §4.2；本文的“当前/目标”分界随每个阶段更新。

## 验证与回滚

- **验证**：`mise tasks run ci-docs`；相对链接存在；Reference、CR、索引、登记表和追踪关系一致。
- **回滚**：本次只修订 Reference/CR 的当前状态与目标边界，不回滚已落地的 Native Loop、持久 SSE、工具审批、租约或 Worker 恢复代码；未来阶段按 AVX-HAR-001 §17 保留已提交证据并切回 Replay/保守响应。
- **批准后续**：继续推进 3c+ 生产级安全补强，再建设独立 Host 与 DSH/pi Adapter；3c+ 必须补齐所有事件/工具写边界的 fencing、终端工具批次测试和 unknown outcome 收敛，每个阶段单独通过代码门禁、契约测试、许可证检查和安全评审。
