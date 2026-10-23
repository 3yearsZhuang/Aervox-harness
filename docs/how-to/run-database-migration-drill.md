---
id: AVX-GUIDE-006
---

# 操作指南：执行 SQLite 本地数据库迁移与换库回滚演练

关联：[SQLite 本地单用户数据库契约](../reference/DATABASE.md) · `CR-030 纯本地 SQLite 变更`（已归档） · [运行、值班与演练手册](../reference/operations.md#10-演练与证据)

本文指导维护者与测试人员执行 CR-030 确立的 SQLite 本地单用户数据库破坏性迁移与原子换库回滚演练。现行架构契约以 [DATABASE.md](../reference/DATABASE.md#9-cr-030-破坏性迁移)为准，归档的 CR-030 仅供追溯。本页是维护操作清单；完整停写协调、范围选择、索引重建和故障恢复仍需按实际数据编排，不是可直接用于活动业务库的一键迁移脚本。

## 目标与前置条件

- **演练目标**：验证在真实单机环境下，从历史多租户/旧结构数据库向纯本地单用户数据库的无损迁移；验证在校验失败或异常时，能否 100% 确定性回滚至停写前的备份，不产生数据损坏或幽灵状态。
- **环境要求**：
  - 依赖：使用 `mise.toml` 锁定的工具链，命令从仓库根经 `./aervox` 或 `mise exec --` 执行；
  - 数据目录：确保待迁移数据库（`aervox.db`）处于非繁忙状态，且磁盘保留至少原数据库大小 3 倍的可用空间；
  - 工具链：支持 SQLite 3.45+ CLI 工具。

## 步骤

### 第一步：服务停写与不可变时间戳备份

破坏性迁移绝不允许在并发写入状态下执行。

#### 1. 终止活动服务进程

通过实际启动它们的终端、服务管理器或原生主管停止 API、Worker、后台 Host 与所有已知数据库消费者，等待在途任务和连接退出，再取得维护独占锁。不能用进程名称匹配结果代替停写证明；无法确认未知消费者、主管自动重启或文件锁状态时停止演练。

#### 2. 强制 WAL 检查点并执行只读不可变备份

```bash
set -euo pipefail
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_DIR="/absolute/selected-data" # 从实际 DATABASE_URL 核对，不推测默认目录
export SOURCE_DB="$DB_DIR/aervox.db"
BACKUP_DIR="$DB_DIR/backups/pre_migration_$TIMESTAMP"
test -f "$SOURCE_DB"
mkdir -p "$DB_DIR/backups"
mkdir -m 700 "$BACKUP_DIR"

# 强制 WAL 合并回主文件
sqlite3 "$SOURCE_DB" "PRAGMA wal_checkpoint(TRUNCATE);"

# 创建带有校验和的不可变快照副本
sqlite3 "$SOURCE_DB" ".backup '$BACKUP_DIR/aervox_source.db'"
shasum -a 256 "$BACKUP_DIR/aervox_source.db" > "$BACKUP_DIR/checksum.sha256"
```

逐项核对退出码，源文件不存在或时间戳目录已存在时停止，不让 SQLite 创建空源库或复用旧备份。检查 checkpoint 返回的 busy 值为 0；有忙读者或错误时不能继续。以上只演示主库一致性快照；完整回滚包还必须纳入 Vault、恢复控制账本、相关密钥与外部迁移状态，使用[备份清单服务](../../packages/repositories/src/migration/backup-manifest.ts)记录文件身份、SHA-256、Schema 版本和逐表行数，不能仅凭主库副本宣布备份完整。

#### 3. 验证备份完整性

```bash
sqlite3 "$BACKUP_DIR/aervox_source.db" "PRAGMA quick_check;"
# 必须输出: ok
```

### 第二步：从已验证备份选择数据范围

先调用 `scanLegacyScopes` 检查备份中的数据范围，再按 `selectLegacyScope` 的规则决定选择。零或单范围可按现行合同处理；多范围必须由用户显式选择并确认未选数据只保留在备份/导出包中，严禁使用 `MAX(rowid)` 等随机策略。记录选择与源库快照身份后，才能开始构建新库。

迁移器入口见 [`packages/repositories/src/migration/`](../../packages/repositories/src/migration/index.ts)。仓库未提供独立迁移 CLI，演练须编排一次性脚本，把已验证源快照、选定范围及新 staging 路径按服务签名传入；空库初始化不等于完成迁移。

### 第三步：在独立隔离目录构建 Staging 新库

迁移操作必须在隔离的 staging 数据库上进行，绝不允许直接在原数据库上执行破坏性原地 `ALTER` 或 `DROP`。

#### 1. 准备 staging 路径

```bash
set -euo pipefail
export STAGING_DB="$DB_DIR/staging/aervox_staging_$TIMESTAMP.db"
mkdir -p "$(dirname "$STAGING_DB")"
test ! -e "$STAGING_DB" && test ! -e "${STAGING_DB}-wal" && test ! -e "${STAGING_DB}-shm"
```

任一检查失败即停止，不删除或覆盖以前的 staging、WAL 或回滚材料。

#### 2. 在新库上初始化纯本地单用户 Schema

使用 `@aervox/repositories` 的建库入口初始化最新 DDL（无 `workspace_id` 与 `tenant_id`）。仓库未提供独立迁移 CLI，用一次性 Node 脚本调用编程入口：

```bash
mise exec -- pnpm exec turbo run build --filter=@aervox/repositories
mise exec -- node --input-type=module <<'JS'
import { pathToFileURL } from 'node:url';
import { createDatabase, initDatabaseSchema } from './packages/repositories/dist/index.js';
if (!process.env.STAGING_DB) throw new Error('STAGING_DB is required');
const { client } = await createDatabase({ url: pathToFileURL(process.env.STAGING_DB).href });
try {
  await initDatabaseSchema(client);
  console.log('staging schema initialized');
} finally { client.close(); }
JS
```

#### 3. 按已选范围抽取与重映射

使用 `buildCr030Staging` 从已验证源快照向新库复制已选数据，不重新猜测范围。将结果与备份清单的选中范围逐表比对，再调用 `validateCr030Staging` 校验；任何冲突、缺失或行数不符都停止，保留源快照与 staging 作为失败材料。

#### 4. 重建 FTS5 全文索引与向量存储

`messages_fts` 与 `memories_fts` 是自行保存索引内容的虚表；对空表执行 FTS `rebuild` 不会从业务表恢复正文。迁移编排须从选定范围内仍可召回、未删除的权威消息/记忆重建索引，经现有 `indexMessageFts` / `indexMemoryFts` 等仓储入口复验资格；向量索引同样按当前模型和来源重新生成。比较选中来源数量、索引数量与已删除来源零召回，不能把 SQL 执行成功当作索引完整证明。

### 第四步：迁移完整性双向校验

换库前必须执行严格的数据比对门禁：

#### 1. 核心实体行数核对

行数核对以迁移服务输出的逐表清单为准：manifest 记录源库选中范围行数与 staging 库行数，两者必须严格相等；核对会话、日记、记忆等关键表族。CR-030 后业务表无 `owner_id` 等租户列，不要在 SQL 中按用户列过滤。

#### 2. 外键与一致性检查

```bash
sqlite3 "$STAGING_DB" "PRAGMA foreign_key_check;"
sqlite3 "$STAGING_DB" "PRAGMA integrity_check;"
# 必须输出: ok 且无任何外键冲突
```

### 第五步：原子换库操作（Atomic Swap）

先关闭源库、staging 和验证工具的全部句柄，确认两库均已完成 checkpoint 且没有未处理的 WAL/SHM，再使用[现有换库服务](../../packages/repositories/src/migration/staging-migration.ts)执行同文件系统换库。残留 sidecar 须先查明原因，不能只移动 `.db` 或把新旧 WAL 混用：

```bash
export ROLLBACK_DB="$DB_DIR/aervox_archived_$TIMESTAMP.db"
mise exec -- node --input-type=module <<'JS'
import fs from 'node:fs/promises';
import { atomicSwapCr030Database } from './packages/repositories/dist/index.js';
const { SOURCE_DB, STAGING_DB, ROLLBACK_DB } = process.env;
if (!SOURCE_DB || !STAGING_DB || !ROLLBACK_DB) throw new Error('database paths are required');
for (const candidate of [ROLLBACK_DB, `${SOURCE_DB}-wal`, `${SOURCE_DB}-shm`, `${STAGING_DB}-wal`, `${STAGING_DB}-shm`]) {
  if (await fs.lstat(candidate).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; })) {
    throw new Error(`refusing swap with existing rollback or sidecar: ${candidate}`);
  }
}
await atomicSwapCr030Database({ sourcePath: SOURCE_DB, stagingPath: STAGING_DB, rollbackPath: ROLLBACK_DB });
JS
```

换库后先保持写入口关闭，使用只读验证确认业务行数、Schema、FTS 与删除/撤权水位。确认启动配置仍指向所选 `SOURCE_DB` 后，才通过原启动方式恢复服务并执行烟雾检查；不得以默认开发目录启动来代替目标库验收。换库服务会尝试回退失败的第二次 rename，但进程中断恢复仍依赖外部迁移状态与完整回滚包。

### 第六步：应急回滚演练（Rollback Drill）

演练必须包含对回滚路径的可执行性检验：

#### 1. 模拟切换失败并执行回滚

假设换库后服务无法启动，重新停止所有 API、Worker、Host 和自动重启来源，确认句柄已关闭。先为故障新库及其 WAL/SHM 保存独立失败副本，核对 checkpoint 和关闭状态，保留当前主文件供换库服务移入新的 rollback 路径；没有停写证明时不得移动活动文件。

从已验证回滚包在同文件系统构建恢复副本，逐项比较 manifest 中的 SHA-256、Schema、完整性与行数，随后按第五步的换库服务替换，使用新的且不存在的 rollback 路径。不能仅打印一个 checksum 就认定比较成功，也不能让故障新库的 sidecar 留在恢复路径旁。Vault、密钥和恢复控制账本按各自合同恢复；删除与撤权事实不得因业务库回退而降水位。

#### 2. 重启服务验证

先只读复验并按恢复账本重放 deny，再解除维护状态；确认所选业务库可读写且已删除内容零召回。回滚包至少保留 30 天或 10 次成功启动；新库已经接受新写入时，不能自动降级旧 Schema 或丢弃这些新增事实，须另行裁定恢复范围。

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
