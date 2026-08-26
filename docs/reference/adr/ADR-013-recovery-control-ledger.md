# ADR-013 独立恢复控制账本与撤权先行

- 提出人：3yearszhuang · 2026-08-26
- 修改人：3yearszhuang · 2026-08-26

- 状态：Proposed
- 日期：2026-08-24
- 关联：`NFR-DR-001`、`NFR-SEC-001`、`NFR-PRIV-001`、`RISK-004/005`、`ADR-004`、`ADR-011`、`ADR-012`

## Context

删除、同意撤销、插件撤权和外部同步权限撤销必须在 SQLite、缓存、索引、对象存储、模型上下文和恢复流程中形成不可绕过的 deny 控制。业务 SQLite 与灾备/恢复控制账本处于独立凭据和故障域，不能依赖跨数据库分布式事务，也不能把两者描述成“同时写入”。

如果业务库先提交而账本追加失败，PITR 或业务库回滚后可能重新开放已经撤销的内容；如果账本先写而业务库提交失败，则必须保证业务状态最终收敛，同时在收敛前继续拒绝受影响范围。

## Decision drivers

- `RecoveryControlLedger` 必须是删除、同意撤销、插件撤权和外部权限撤权的权威 deny 控制事实源；
- 账本追加必须可审计、不可变、可按 sequence 重放，并且请求重试不能生成第二个控制事件；
- 账本和业务 SQLite 任何一方不可用时，相关范围必须 fail closed；
- 恢复时必须先验证账本完整性和水位，再重放业务投影，最后完成零召回/零越权验证才能开放流量；
- 不把用户正文、密钥或可直接恢复的内容写入账本。

## Considered options

1. **跨业务库与账本的分布式事务**：依赖更强的基础设施和协调协议，无法覆盖独立故障域、PITR 与账本服务自身降级。
2. **先提交业务库，再异步追加账本**：业务状态可能在账本缺失窗口内被恢复或读取，违反撤权先行。
3. **业务库与账本“同时写入”**：无法定义先后、持久确认和部分失败后的收敛语义，容易把实现歧义误当成一致性保证。
4. **账本先行，业务库幂等投影**：账本先取得 durable ack，业务库和 Outbox 随后按确定性键幂等提交；失败时由 reconciler 按 sequence 重放，受影响范围在水位追平前保持 deny。

选择方案 4。

## Decision

### 1. 账本事实与追加协议

- `RecoveryControlLedger` 使用独立账号、凭据、备份和故障域，提供 append-only 记录、单调 `sequence`、完整性/防篡改证据和可验证的 durable ack。账本记录假名化 `workspaceRef`、`subjectRef`、`targetRef`、事件类型和时间，不含用户正文。
- 控制事件的 `controlEventId` 和 `idempotencyKey` 由请求目标、事件类型、授权主体、撤权版本和命令意图按规范化规则确定；同一键同一摘要重试返回原 sequence，不能追加第二条；同键不同摘要返回冲突并告警。
- 处理删除、同意撤销、插件撤权或外部权限撤销时，服务端必须：
  1. 完成目标与权限校验，生成确定性 `controlEventId/idempotencyKey`；
  2. 向账本追加 deny/revoke 事件并等待 durable ack；
  3. 只有在 ack 成功后，幂等提交 SQLite 的即时 deny 投影、`DeletionRequest`/撤权状态和 `OutboxEvent`；
  4. 返回成功前确认本地投影已提交，或明确返回“已受理、仍在收敛”，绝不声称下游清理已经完成。
- SQLite 的 `DeletionRequest`、权限投影和 Outbox 是账本事件的派生投影，不得反向覆盖、删除或修改账本事实。Outbox 的唯一键必须包含 `controlEventId`，清理与索引/缓存失效处理器按该键幂等。

### 2. 水位、租户范围与 fail closed

- 每个业务投影保存已应用的 ledger sequence/watermark、最后成功 controlEventId 和完整性校验结果；reconciler 按 sequence 顺序读取并重放，重复、乱序或已应用事件必须幂等，缺口必须暂停该范围而不能跳过。
- 账本不可用、完整性校验失败、检测到 sequence 缺口、业务投影水位落后于已确认事件，或恢复后水位未追平时，受影响 `workspace/subject/target` 的召回、流式传输、日记/记忆生成、导出和下游清理均 fail closed。不得用缓存、旧授权快照或业务库孤立状态放行。
- 账本的 deny 事实优先于业务库允许状态和所有历史权限快照。连接存续期间若发现新撤权事件，按 ADR-012 主动断流并追加可见性变更事件；在本地水位追平前不得重连恢复正文。
- 账本服务不需要获得业务正文读取权限；业务投影服务不能修改账本。运维恢复使用最小权限、双人审批和不可变审计。

### 3. 崩溃与恢复

- 账本追加前崩溃：调用方可以安全重试确定性命令；若无法证明是否已追加，先按 `controlEventId/idempotencyKey` 查询账本，再决定重试，不能直接生成新键。
- 账本 durable ack 后、SQLite 提交前崩溃：目标已经 deny；reconciler 依据 ledger sequence 重放即时投影、`DeletionRequest`/撤权状态和 Outbox。业务库不可用期间保持 fail closed。
- SQLite 提交后、Outbox 投递前崩溃：事务中的 Outbox 由重放器按 `controlEventId` 投递；任何下游重复执行必须由目标键和版本幂等收敛。
- 账本恢复或 SQLite 备份恢复后，系统先进入维护/全局 deny 模式，验证账本签名/哈希链、sequence 连续性、最新水位与业务投影水位，再按 sequence 幂等重放并执行零召回、零越权、撤权连接断流和导出隔离验证；所有证据齐全后才允许逐范围解除 deny。

## Positive consequences

- 撤权事实不会因业务库回滚、PITR 或缓存陈旧而复活；
- 账本和 SQLite 可独立扩展、备份和恢复，跨故障域语义明确；
- 重试、乱序、部分提交和恢复过程均可由 sequence、watermark 和确定性键审计；
- 流式、记忆、日记、导出和下游清理可以共享同一 deny 控制面。

## Negative consequences and risks

- 控制操作增加一次外部 durable ack，可能增加延迟并引入账本可用性依赖；
- reconciler、缺口检测、逐范围隔离和恢复演练需要额外运维能力；
- fail closed 会在账本或水位异常期间牺牲可用性，必须提供清晰的用户状态和告警；
- 账本只能证明控制事实，不能替代各下游清理、零召回验证和数据保留策略。

## Migration / rollback

- 先部署账本客户端、确定性键和只读水位监控，再为删除/撤权命令启用账本先行；旧业务命令在切换窗口内拒绝写入或经兼容适配器追加账本，禁止形成无账本的新撤权事实。
- 为已有 `DeletionRequest`、撤权状态和 tombstone 生成一次经过审计的基线事件；无法证明来源或顺序的记录进入人工复核和 fail-closed 隔离。
- 回滚应用版本不得关闭账本校验或删除已追加事件；旧版本只能读取已提交业务投影，账本水位异常时继续拒绝受影响范围，直到兼容 reconciler 追平。

## Verification evidence

状态改为 `Accepted` 前至少提供：

- 账本追加前崩溃、追加后崩溃、重复命令、同键不同摘要、乱序事件、sequence 缺口和 durable ack 丢失确认测试；
- 账本已写但业务数据库不可用、事务回滚、Outbox 重复投递和 reconciler 按 sequence 重放测试；
- 账本不可用、完整性失败、水位未追平时的召回/流式/日记/记忆/导出 fail-closed 测试；
- SQLite 备份恢复、账本恢复、跨故障域切换、零召回/零越权和现有 SSE 主动断流验证演练；
- 多 workspace/subject/target 并发撤权、最小权限、双人恢复审批和审计证据检查。
