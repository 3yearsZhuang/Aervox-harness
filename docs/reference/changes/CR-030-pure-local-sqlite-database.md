---
id: CR-030
type: reference
scope: change
owner: maintainers
doc_status: review-candidate
decision_status: accepted
delivery_status: implemented
version: 1.1.0
updated_at: 2026-09-11
reviewed_at: 2026-09-11
review_interval_days: 30
review_triggers:
  - packages/schema/**
  - packages/repositories/**
  - apps/api/src/shared/auth.ts
  - apps/api/src/index.ts
  - apps/worker/**
  - data/*.db
sources:
  - docs/reference/PRD.md
  - docs/reference/SRS.md
  - docs/reference/ARCHITECTURE.md
  - docs/reference/DATABASE.md
  - docs/reference/THREAT_MODEL.md
  - docs/reference/DATA_PRIVACY.md
  - docs/reference/TEST_STRATEGY.md
  - docs/reference/adr/ADR-003-postgres-retrieval.md
  - docs/reference/adr/ADR-008-cloud-first-local-port.md
  - docs/reference/changes/CR-003-sqlite-primary-pg-compat.md
---

# CR-030 确立 SQLite 为永久本地单用户真源并移除租户结构

- 提出人：3yearszhuang · 2026-09-10
- 修改人：3yearszhuang · 2026-09-11

本变更经维护者于 2026-09-10 明确批准。它替代 CR-003 中“保留 PostgreSQL
兼容和多租户结构”的方向，规定去租户化的产品边界、实现边界和破坏性迁移门禁。

## 1. 决策

1. Aervox 的持久化终态是单个操作系统用户配置目录内的 SQLite（LibSQL）数据库；
   不再规划 PostgreSQL 真源、云端多租户、组织级 RLS 或应用层租户模拟。
2. 最终 Schema、DDL、FTS、仓储接口和调用方移除 `workspace_id`、
   `subject_user_id` 与 `TenantContext`。`actorId`、设备、授权修订、来源和审计字段仍保留，
   它们表达操作者与证据，不承担租户隔离。
3. 保留 W-19 已落地的 `@aervox/schema` + `@aervox/repositories` 双包边界。
   去租户化不构成重新建立 `@aervox/database` 巨型兼容包的理由。
4. 旧数据库到新数据库的转换是明确的破坏性迁移：活动数据库最终只保留一个用户数据范围。
   破坏性只允许发生在已验证备份之后，不允许静默合并、静默删除或按 `MAX(rowid)` 任意择胜。

## 2. 产品范围与非目标

- 支持：单机桌面、本机 Web 工作台、本机 Worker、同一操作系统用户下的插件与本地连接器。
- 数据组织：会话、目标、标签和收藏可以继续提供用户可见的分类能力，但不再建模为安全租户。
- 不支持：一份数据库由多个不互信用户共享、组织管理员跨用户管理、云端 SaaS 多租户和
  PostgreSQL 双引擎切换。
- 多设备同步若未来重新进入范围，必须新建 CR/ADR，不能复用已移除的租户字段假装完成身份与冲突处理。

## 3. 本地安全边界

去租户化把安全边界从“数据库行级租户”改为“操作系统账户 + 本机 API + 应用授权”：

1. API 默认只监听 `127.0.0.1`/`::1`。`AERVOX_AUTH_MODE=open` 不得与非 loopback
   监听组合使用。
2. 非 loopback 监听必须同时具备显式远程开关、token 认证和启动期 fail-closed 校验；
   对公网或不可信局域网暴露仍属于范围外部署。
3. 数据目录默认仅当前操作系统用户可读写：目录权限目标为 `0700`，数据库、迁移状态、
   备份清单和本地 token 目标为 `0600`。Windows 使用等价的当前用户 ACL。
4. 插件、MCP、模型输出和外部内容仍是不可信输入；ToolPolicy、插件 Grant、来源撤权、
   Local Vault、RecoveryControlLedger 和审计要求不因去租户化而降低。

## 4. 破坏性迁移协议

### 4.1 状态机

迁移器使用独立 sidecar 状态清单，不依赖正在迁移的业务表：

```text
planned
  -> quiesced
  -> backup_verified
  -> scope_selected
  -> staging_built
  -> validated
  -> swapped
  -> completed
```

任一阶段失败都保留原数据库、备份和状态清单。启动器只接受 `completed`，或在原数据库
完全未被替换时继续旧版本；检测到中间态必须进入维护模式，不得把半迁移数据库当作成功。

### 4.2 停写与备份

1. 停止 API 写入口、Worker、Outbox 和主动智能后台任务，取得独占迁移锁；无法证明停写则拒绝迁移。
2. 对业务数据库、主动智能 Vault、RecoveryControlLedger 和相关 WAL 文件生成一致性备份；
   备份完成后记录大小、SHA-256、Schema 版本和表行数。
3. 目标磁盘可用空间必须覆盖原库、备份、staging 库及安全余量；不足时不得开始。
4. 迁移前执行 `PRAGMA integrity_check`、外键检查和迁移历史检查；源库损坏时先走恢复流程。

### 4.3 数据范围选择

迁移器先只读扫描所有包含旧租户列的表，生成 `(workspaceId, subjectUserId)` 数据范围清单
和逐表行数：

- 没有个人行：可自动迁移系统表。
- 恰好一个数据范围：可自动选择，但仍须生成备份和计划清单。
- 多于一个数据范围：必须由用户明确选择一个保留范围；CLI/维护界面展示各范围的行数、
  最近活动时间和导出位置，并要求 `--ack-destructive` 或等价确认。
- 未选择范围、范围在表间不一致或存在未知消费者时，迁移 fail closed。

未选范围不会进入新活动数据库，但必须保留在只读备份或独立导出包中。系统不得自动把多个
范围合并为一个用户；需要合并时，应在迁移完成后通过显式导入流程处理业务键冲突。

### 4.4 构建新库而非原地删列

1. 在同一文件系统创建 `<database>.cr030.staging`，使用最终无租户 DDL 初始化。
2. 按外键拓扑复制选中范围；复制时移除租户列，系统级表只复制一次。
3. 业务唯一键冲突、孤儿外键、无法解析的 JSON、未知枚举或行数不一致全部生成冲突报告并中止。
   禁止通过修改幂等键、撤销授权、归档记录、删除较旧行或 `MAX(rowid)` 静默消解。
4. staging 库必须通过 `integrity_check`、`foreign_key_check`、逐表预期行数、关键索引、
   FTS 重建和抽样内容校验。
5. 关闭全部数据库句柄并落盘后，在同一文件系统执行原子文件替换：原库改名为带时间戳的
   rollback 包，staging 库改名为正式路径。跨文件系统复制不得冒充原子替换。

### 4.5 回滚与保留

- `swapped` 后首次开放写流量前执行一次只读启动验证；失败立即换回 rollback 包。
- 新版本产生业务写入后，自动回滚会丢失新数据，因此只能停机并由用户确认恢复旧备份和旧二进制。
- rollback 包至少保留 30 天或 10 次成功启动，以较晚者为准；清理前再次确认存在其它已验证备份。
- 迁移日志不得包含消息正文、密钥、token 或原始主动画像内容。

## 5. 实现阶段

| 阶段 | 交付 | 退出条件 |
|---|---|---|
| D0 决策基线 | 本 CR 与 PRD/SRS/架构/安全/隐私/测试同步 | 文档门禁通过，决策为 Accepted |
| D1 迁移器与安全入口 | 预检、备份清单、范围选择、staging、校验、原子换库和 API loopback 守卫 | 迁移状态机、范围扫描、备份校验、staging/换库和启动 fail-closed 代码与定向测试已落地 |
| D2 Schema 与仓储去租户 | `packages/schema`、最终 DDL、Repository 和消费者删除租户列及查询条件 | Schema/DDL/Repository/Worker/API/Host Agent 构建与仓储 203 项测试通过；`LocalContext` 仅作为不参与持久化的兼容调用参数保留 |
| D3 清理与发布 | 静态审计、旧测试迁移、文档登记和发布前门禁说明 | 数据库边界已清理并完成文档登记；生产停写编排、跨故障点演练、rollback 保留策略和完整 DSH 环境验证仍是发布前门禁 |

每一阶段必须在需求追踪基线追加实现位置与机器证据；实现状态与发布状态必须分开登记，不得用未完成的发布演练替代实现证据。

## 6. 验证要求

- 单范围旧库：所有选中行和来源关系进入新库，租户列归零。
- 多范围旧库：无选择时拒绝；选择后只导入目标范围，未选范围存在可验证备份/导出。
- 故障注入：在每个状态转换、备份、复制、校验和文件替换点中断，再启动不会丢失原库或误报完成。
- 冲突夹具：重复业务键、孤儿外键和损坏 JSON 必须输出报告并保持原库不变。
- 网络安全：默认监听为 loopback；open auth + 非 loopback 组合启动失败。
- 回归：对话、日记、记忆、插件、主动智能、Outbox、删除传播、导出和恢复测试通过。

## 6.1 本次实现证据与剩余门禁

- 已验证：`@aervox/schema`、`@aervox/repositories`、`@aervox/api`、`@aervox/worker` 构建与定向测试；仓储 41 个测试文件共 203 项、API 48 个测试文件共 329 项通过（1 项 DSH 环境探测跳过）、Worker 4 个测试文件共 10 项通过；全仓 `turbo run build` 通过。
- 已落地：最终 Schema/DDL、FTS5 与内存向量适配器不再包含 `workspace_id`、`subject_user_id`、租户复合索引或租户分区 key；仓储查询和模型映射不再使用租户条件；旧库迁移输入仅在 CR-030 扫描和 staging 复制阶段读取。
- 兼容边界：`LocalContext` 与 `workspaceId`/`subjectUserId` 仍存在于部分 Port 和调用方签名，但只用于保持调用兼容或迁移范围输入，不构成数据库安全边界，也不写入最终库。
- 发布前门禁：当前临时工作树缺少 DSH 参考子模块，`host-agent` 的 DSH 探测测试无法执行；跨进程停写协调、生产 FTS 重建与 rollback 保留需要在完整运行编排中复核。上述限制不影响本次 Schema/Repository 去租户化实现，但阻止将 CR 标记为 `released`。

## 7. 替代关系

- CR-003：`decision_status` 改为 `superseded`，历史实现证据保留。
- ADR-003：保留 SQLite、FTS、递归查询、Vector Port 与 Repository 分层；删除 PostgreSQL
  演进目标，并由本 CR 修订其终态决策。
- ADR-008：Cloud-first、本地/云端双真源和自托管演进方向改为 Superseded。
- CR-030 不接受 #169 中重新合并 `@aervox/database`、原地逐表 `DROP COLUMN`、
  先去除来源再按 rowid 去重以及默认 `0.0.0.0 + open auth` 的实现方式。
