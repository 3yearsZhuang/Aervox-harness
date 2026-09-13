---
id: AVX-GUIDE-006
type: how-to
scope: guide
owner: maintainers
doc_status: review-candidate
decision_status: not-applicable
delivery_status: not-applicable
version: 1.0.0
updated_at: 2026-09-13
reviewed_at: 2026-09-13
review_interval_days: 90
review_triggers:
  - docs/reference/DATABASE.md
  - docs/reference/changes/CR-030-pure-local-sqlite-database.md
  - packages/database/**
  - packages/repositories/**
sources:
  - docs/reference/DATABASE.md
  - docs/reference/changes/CR-030-pure-local-sqlite-database.md
  - docs/reference/operations.md
---

# 操作指南：执行 SQLite 本地数据库迁移与换库回滚演练

- 提出人：3yearszhuang · 2026-09-13
- 修改人：3yearszhuang · 2026-09-13

关联：[SQLite 本地单用户数据库契约](../reference/DATABASE.md) · [CR-030 纯本地 SQLite 变更](../reference/changes/CR-030-pure-local-sqlite-database.md) · [运行、值班与演练手册](../reference/operations.md#10-演练与证据)

本文档指导维护者与测试人员如何执行 CR-030 确立的 SQLite 本地单用户数据库破坏性迁移与原子换库回滚演练。破坏性迁移与原子换库的架构契约以 [DATABASE.md](../reference/DATABASE.md) 和 [CR-030](../reference/changes/CR-030-pure-local-sqlite-database.md) 为准，本页聚焦操作步骤。

## 目标与前置条件

- **演练目标**：验证在真实单机环境下，从历史多租户/旧结构数据库向纯本地单用户数据库的无损迁移；验证在校验失败或异常时，能否 100% 确定性回滚至停写前的备份，不产生数据损坏或幽灵状态。
- **环境要求**：
  - 依赖：Node.js 24 + pnpm 11（在 mise 环境内执行）；
  - 数据目录：确保待迁移数据库（`aervox.db`）处于非繁忙状态，且磁盘保留至少原数据库大小 3 倍的可用空间；
  - 工具链：支持 SQLite 3.45+ CLI 工具。

## 步骤

### 第一步：服务停写与不可变时间戳备份

破坏性迁移绝不允许在并发写入状态下执行。

#### 1. 终止活动服务进程

停止 API 实例与后台 Worker，切断所有写入者连接：

```bash
# 若为开发或本地运行环境
pkill -f "aervox.*api" || true
pkill -f "aervox.*worker" || true
```

#### 2. 强制 WAL 检查点并执行只读不可变备份

```bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_DIR="$HOME/Library/Application Support/aervox" # 或对应系统的 local data dir
BACKUP_DIR="$DB_DIR/backups/pre_migration_$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

# 强制 WAL 合并回主文件
sqlite3 "$DB_DIR/aervox.db" "PRAGMA wal_checkpoint(TRUNCATE);"

# 创建带有校验和的不可变快照副本
sqlite3 "$DB_DIR/aervox.db" ".backup '$BACKUP_DIR/aervox_source.db'"
shasum -a 256 "$BACKUP_DIR/aervox_source.db" > "$BACKUP_DIR/checksum.sha256"
```

#### 3. 验证备份完整性

```bash
sqlite3 "$BACKUP_DIR/aervox_source.db" "PRAGMA quick_check;"
# 必须输出: ok
```

### 第二步：在独立隔离目录建立 Staging 新库

迁移操作必须在隔离的 staging 数据库上进行，绝不允许直接在原数据库上执行破坏性原地 `ALTER` 或 `DROP`。

#### 1. 准备 staging 路径

```bash
STAGING_DB="$DB_DIR/staging/aervox_staging.db"
mkdir -p "$(dirname "$STAGING_DB")"
rm -f "$STAGING_DB" "${STAGING_DB}-wal" "${STAGING_DB}-shm"
```

#### 2. 在新库上初始化纯本地单用户 Schema

使用 `@aervox/schema` 当前最新的 DDL 脚本初始化新表结构（无 `workspace_id` 与 `tenant_id`）：

```bash
mise x -- pnpm --filter @aervox/schema run migrate:init --db "$STAGING_DB"
```

### 第三步：显式范围选择与数据导入

根据 CR-030 规定，历史多租户向单用户转换必须通过**显式用户范围指定**，严禁使用 `MAX(rowid)` 等随机策略。

#### 1. 执行单用户数据抽取与重映射

```bash
# 指定需要保留的目标用户 ID
TARGET_USER_ID="usr_primary_local"

# 运行数据迁移抽取器
mise x -- pnpm --filter @aervox/repositories run db:migrate-single-user \
  --source "$BACKUP_DIR/aervox_source.db" \
  --target "$STAGING_DB" \
  --user-id "$TARGET_USER_ID"
```

#### 2. 重建 FTS5 全文索引与向量存储

```bash
sqlite3 "$STAGING_DB" "INSERT INTO fts_messages(fts_messages) VALUES('rebuild');"
```

### 第四步：迁移完整性双向校验

换库前必须执行严格的数据比对门禁：

#### 1. 核心实体行数核对

比对源库指定用户的数据量与 staging 库的数据量：

```sql
-- 在源库核验
SELECT count(*) FROM sessions WHERE owner_id = 'usr_primary_local';
-- 在 staging 库核验
SELECT count(*) FROM sessions;
-- 两者行数必须严格相等！
```

#### 2. 外键与一致性检查

```bash
sqlite3 "$STAGING_DB" "PRAGMA foreign_key_check;"
sqlite3 "$STAGING_DB" "PRAGMA integrity_check;"
# 必须输出: ok 且无任何外键冲突
```

### 第五步：原子换库操作（Atomic Swap）

当 staging 库通过全部校验后，执行操作系统级的原子重命名：

```bash
# 1. 归档当前源文件
mv "$DB_DIR/aervox.db" "$DB_DIR/aervox_archived_$TIMESTAMP.db"
if [ -f "$DB_DIR/aervox.db-wal" ]; then mv "$DB_DIR/aervox.db-wal" "$DB_DIR/aervox_archived_$TIMESTAMP.db-wal"; fi
if [ -f "$DB_DIR/aervox.db-shm" ]; then mv "$DB_DIR/aervox.db-shm" "$DB_DIR/aervox_archived_$TIMESTAMP.db-shm"; fi

# 2. 原子移入 staging 库
mv "$STAGING_DB" "$DB_DIR/aervox.db"

# 3. 启动服务进行烟雾测试
./aervox dev
```

### 第六步：应急回滚演练（Rollback Drill）

演练必须包含对回滚路径的可执行性检验：

#### 1. 模拟切换失败并执行回滚

假设施行换库后服务报错无法启动，立即触发回滚：

```bash
# 1. 停机
pkill -f "aervox.*api" || true

# 2. 移除故障新库
mv "$DB_DIR/aervox.db" "$DB_DIR/aervox_failed_swap.db"

# 3. 从备份恢复原始数据库
cp "$BACKUP_DIR/aervox_source.db" "$DB_DIR/aervox.db"

# 4. 校验 checksum
shasum -a 256 "$DB_DIR/aervox.db"
```

#### 2. 重启服务验证

重启服务并确认业务可正常读写恢复。

## 验证与演练证据回填

演练完成后，在 [运行手册 §12 演练证据模板](../reference/operations.md#12-季度恢复演练证据模板) 填写以下证据项：

| 证据字段 | 填写要求 |
|---|---|
| **演练日期 / 环境** | 记录执行日期、操作系统及数据库大小（MB） |
| **RPO 达成值** | 停写点与不可变快照一致性，目标为 0 数据丢失（PASS） |
| **RTO 达成值** | 从停写到完成原子换库（或完成回滚）的总耗时，记录分钟数 |
| **校验报告** | `integrity_check` 结果与重要表（会话、日记、记忆）行数一致性比对 |

## 常见问题与陷阱

1. **WAL 检查点未刷盘导致备份缺失最新事务**：备份前必须执行 `PRAGMA wal_checkpoint(TRUNCATE);`。
2. **写快照冲突（Database is locked）**：严禁在未停机状态下直接操作正在使用的 SQLite 数据库文件。
3. **读快照滞后导致的单测断言失败**：SQLite/libsql 在事务提交后其它连接存在快照滞后，测试断言必须使用写者连接自身进行验证（见 ADR-003 与 `packages/repositories` 说明）。
