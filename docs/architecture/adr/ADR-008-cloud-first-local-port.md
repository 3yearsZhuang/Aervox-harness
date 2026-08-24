# ADR-008 Cloud-first 与本地/自托管 Port

- 状态：Proposed（待技术/隐私负责人批准）
- 日期：2026-08-23
- Owner：待指定
- 关联：`CAP-027`、`NFR-PRIV-001`、`RISK-007`

## Context

本地优先可提升数据控制，但 MVP 还未验证多端同步、冲突、加密密钥和运维成本。BaiShou-Next 的 SQLite/Markdown 实践适合后续参考，不应迫使首发承担双真源。

## Decision drivers

- MVP 需要先验证云端多端同步与运维成本；
- 首发不应同时维护云端/本地双数据真源；
- 数据控制是长期价值，需保留未来本地/自托管路径；
- 迁移需要可逆、可验证的中间格式。

## Considered options

1. **Cloud-first，R4 通过 Repository/Sync Port 增加本地模式**：首发简单，路径清晰（选定）。
2. **首发本地优先 + 云同步**：数据控制最强，但双真源、冲突与密钥/运维成本高。
3. **纯云端、无本地迁移路径**：最简单，但放弃数据控制与离线价值。

## Decision

R1/R1.5 使用 Web 账户与 SQLite 业务库（基于仓储抽象层）；领域仓储、导出、同步事件和版本模型不绑定云厂商。R4 通过 Repository/Sync Port 增加 SQLite/Markdown、自托管和快照恢复，明确单主/冲突规则。

## Positive consequences

- 首发交付和监控简单，单一真源；
- 领域边界不绑定云厂商，保留本地迁移路径；
- 数据控制能力可持续演进。

## Negative consequences and risks

- 后续本地模式需要密钥、迁移、冲突 UI、离线队列与不同数据地区评审；
- 双真源期间的同步/冲突实现成本集中在 P2。

## Migration / rollback

导出 manifest/checksum 作为迁移中间格式；本地模式可禁用同步并保留本地数据，失败时不静默覆盖云端。格式向后兼容，迁移可重试。

## Verification evidence

状态改为 `Accepted` 前至少提供：

- 导出/导入与断网、冲突测试（`TC-INTEG-SYNC-001`）；
- 快照恢复、权限隔离与删除传播演练（`TC-PRIV-DEL-001`）；
- 本地模式迁移不静默覆盖云端的数据完整性检查。
