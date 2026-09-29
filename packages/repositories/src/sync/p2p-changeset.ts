/**
 * Aervox｜思隅 @aervox/repositories — P2P SQLite 增量 Changeset 提取、对齐与冲突自愈引擎（ITER-028）
 *
 * 设计依据：
 * - 增量追踪采用**行时间戳水位线**（非 SQLite Session Extension，也无 LSN/逻辑时钟游标）；
 * - 纯本地去中心化同步：无中心权威服务器，双端基于 LWW（Last-Write-Wins）结合确定性 Tiebreaker 裁决；
 * - 领域适配：
 *   - 学习事实（question_attempts）为不可变事件流，采用 Append-Only（`INSERT OR IGNORE`）策略；
 *   - 学习进度与错题本（learning_goals、mistake_dispositions、knowledge_items、sessions、turns）采用 LWW 状态覆盖；
 *   - 保证双端离线变更在重新连网同步后达成最终一致性（Strong Eventual Consistency）。
 *
 * 裁决与元数据（`sync_row_state`）：
 * - 每个被同步的行在 `sync_row_state` 中登记权威来源 `(origin_timestamp, origin_device_id)`；
 * - LWW 一律比较这对**持久化元组**，绝不比较“本次中继设备 ID”，因此结果与同步拓扑、同步次数无关：
 *   同一份数据第二次同步产生零次 UPDATE，经第三方设备中继也不会来回震荡；
 * - 元数据缺失时按 `(行时间戳列, bundle.sourceDeviceId)` 惰性播种（seed），随后由合并写入权威元数据。
 *
 * 删除传播（墓碑，Tombstone）：
 * - 调用方通过 `installSyncTriggers` 显式安装 `AFTER INSERT/UPDATE/DELETE` 触发器，
 *   由 SQLite 侧维护 `sync_row_state`：INSERT/UPDATE 盖章来源设备与行时间戳，DELETE 写入墓碑（`deleted_at`）；
 * - `initDatabaseSchema` **不会**自动安装触发器；未安装触发器的库只做“行级”同步，删除不会传播；
 * - 合并顺序是显式的：先写业务行（本地触发器会盖成本机章），再在同一事务内写入权威来源元数据覆盖，
 *   因此来源归属与墓碑始终以真正的原设备为准（见 `applyMergeItem` / `writeRowState`）；
 * - 写入 vs 墓碑**不设特例**：两条路径共用 `incomingWinsLww` 比较同一个
 *   `(比较时钟, origin_device_id)` 元组——时间戳大者胜、时间戳相等时来源设备 ID 字典序大者胜，
 *   因此删除只能被**严格更新**的写入（含设备 ID 决胜）撤销，更旧的远端写入绝不复活较新的本地墓碑。
 *
 * 明确的取舍与已知边界：
 * - 级联删除：外键声明 `ON DELETE CASCADE` 且子表装了触发器时，SQLite 级联删除会触发子表的
 *   `AFTER DELETE` 触发器并写入墓碑（实测 `DELETE FROM sessions` 会级联到 `turns` 并留下墓碑）；
 *   但本模块**不承诺**级联顺序，也不会为未装触发器的子表补墓碑，“父行删除后子行复活”的风险
 *   只在覆盖了触发器时才被消除。
 *
 * 写入与原子性（重要 trade-off）：
 * - 合并按 `SYNC_MERGE_CHUNK_SIZE`（500）行一批切分，每批一个短写事务，避免长时间持有写锁；
 * - 代价是**整包不再原子**：中途失败时已提交的批次不会回滚，调用方必须按批重放（每行都是幂等 upsert）；
 * - 分批未跑完时抛 `SyncPartialMergeError`，其 `partialResult.appliedChunks`/`partial` 明确标出
 *   “前 N 批已提交且无法回滚”，成功返回时 `partial` 也标出是否存在被拒绝/被跳过的内容；
 * - 单行遇到非主键 UNIQUE 冲突（如 `mistake_dispositions.question_id`、`question_attempts(question_id, idempotency_key)`）
 *   时只跳过该行并计入 `uniqueConflicts`，绝不中断整包；
 * - 单行遇到**缺列 / 绑定失败 / 其它约束失败**（schema 漂移）时同样逐行隔离，分别计入
 *   `schemaDriftRows` / `constraintViolations`，同样绝不中断整批（更不会连带回滚同批的正常行）；
 * - 只有基础设施级错误（`SQLITE_BUSY`/`SQLITE_IOERR`/`SQLITE_FULL`、元数据写入失败等）才会中断批次；
 * - 每批内的每行写入都是单条语句（无 SELECT-then-INSERT 竞态）；本地既有状态在批开始前一次性预取。
 *
 * 接收端权威性（安全边界）：
 * - `applyP2PSyncBundle` 的有效白名单一律取 `options.tables ?? DEFAULT_SYNC_TABLES`，
 *   **绝不采用对端包内的表清单**；白名单外的表整表拒绝（`rejectedTables`，一行都不写）；
 * - 对端声明的 `primaryKey` / `strategy` / `timestampColumn` 只用于与本地定义比对，
 *   不一致即整表拒绝并显式上报，实际写入一律使用本地定义（绝不信任对端表身份与列元数据）；
 * - 合并顺序按**本地白名单顺序**（即本地外键拓扑）重排，并在接收端再次调用
 *   `assertSyncTableOrder` 看护，绝不按对端包顺序落库。
 *
 * 版本门禁：
 * - changeset 协议版本 `SYNC_CHANGESET_PROTOCOL_VERSION` 与结构版本 `SYNC_CHANGESET_SCHEMA_VERSION`
 *   同时写入 bundle，并在构建端与应用端 fail-closed 校验，不兼容抛出 `SyncVersionMismatchError`。
 *
 * 水位线与载荷形状（调用方须知）：
 * - `sinceWatermark` 语义为「已包含」：时间戳**等于**水位线的行/墓碑仍会被提取，
 *   否则恰好落在水位上的变更（尤其“插入后立刻删除”的墓碑）会被永久漏掉；
 * - `TableChangeset.records` 除业务列外还会携带两个内部哨兵列：
 *   `__aervox_ts`（有效时间戳，优先取权威元数据）与 `__aervox_origin_device`（真正的来源设备，
 *   中继同步时不可被中继者覆盖）。合并端会剔除它们，调用方不应依赖或改写。
 *
 * 明确**尚未**实现（保持诚实，勿默认已覆盖）：
 * - 未同步 schema 迁移本身：只传行数据与墓碑；目标端缺表时整表记入 `skippedTables`（schema 漂移显式暴露），
 *   目标端缺列时该行被逐行隔离并计入 `schemaDriftRows`，**同批正常行照常落库**；
 * - 未实现字段级三向合并与 CRDT（如 OR-Set）；也未实现级联删除的**保证**（见上文“级联删除”边界）；
 * - 未实现基于 LSN / 逻辑时钟的精确增量游标，仍按行时间戳水位线过滤；
 * - 未实现同步层的认证/授权与重放保护（由 `p2p-pairing.ts` 的加密通道与其上层协议承担）；
 * - 每批写入是短事务但**非跨批原子**：失败后调用方必须按批重放，没有统一的回滚点
 *   （中断时会抛 `SyncPartialMergeError` 并携带已提交批次的报告）；
 * - 未实现冲突的人工仲裁队列：LWW 落败方直接丢弃，不保留双版本供用户选择；
 * - 未实现初始全量基线协商（首次同步依赖调用方传入 `sinceWatermark` 或全量提取）；
 * - 触发器维护的元数据不区分“本机仓储写入”与“外部直接 SQL 写入”，任何绕过仓储层的写也会被盖章；
 * - 触发器只覆盖白名单表；白名单外的表既不登记来源也不产生墓碑。
 */
import type { Client, InValue } from "@libsql/client";
import {
  P2P_PROTOCOL_VERSION,
  type EstablishedP2PSession,
  encryptSyncPayload,
  decryptSyncPayload,
  type EncryptedSyncPayload,
} from "./p2p-pairing.js";

function toInValue(v: unknown): InValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return v;
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return new Uint8Array(v);
  return JSON.stringify(v);
}

/** 合并策略：lww 为状态覆盖，append_only 为不可变事实流 */
export type SyncMergeStrategy = "lww" | "append_only";

/** 同步表定义与冲突合并策略 */
export interface SyncTableDefinition {
  tableName: string;
  primaryKey: string;
  timestampColumn?: string; // 用于 LWW 比对的时间列，默认 "updated_at"
  strategy: SyncMergeStrategy;
}

/**
 * 默认预置的个人学习与错题本同步表白名单。
 *
 * 顺序即合并顺序，**必须满足外键拓扑（父表在前）**：`knowledge_items` 先于 `questions`，
 * `questions` 先于 `question_attempts` / `mistake_dispositions`，`sessions` 先于 `turns`。
 * 该约束由 `assertSyncTableOrder` 与单元测试共同看护；顺序被破坏时整包合并会撞上 FK 约束。
 */
export const DEFAULT_SYNC_TABLES: SyncTableDefinition[] = [
  {
    tableName: "sessions",
    primaryKey: "id",
    timestampColumn: "updated_at",
    strategy: "lww",
  },
  {
    tableName: "knowledge_items",
    primaryKey: "id",
    timestampColumn: "updated_at",
    strategy: "lww",
  },
  {
    tableName: "learning_goals",
    primaryKey: "id",
    timestampColumn: "updated_at",
    strategy: "lww",
  },
  {
    tableName: "questions",
    primaryKey: "id",
    timestampColumn: "updated_at",
    strategy: "lww",
  },
  {
    tableName: "question_attempts",
    primaryKey: "id",
    timestampColumn: "created_at",
    strategy: "append_only",
  },
  {
    tableName: "mistake_dispositions",
    primaryKey: "id",
    timestampColumn: "updated_at",
    strategy: "lww",
  },
  {
    // turns 是可变状态机（status/last_sequence/error/accepted_at/cancelled_at/completed_at），
    // 属于 LWW 状态覆盖，绝不是 append_only：否则 Completed 永远不会传播。
    tableName: "turns",
    primaryKey: "id",
    timestampColumn: "updated_at",
    strategy: "lww",
  },
];

/** 同步元数据表名（墓碑与来源戳） */
export const SYNC_ROW_STATE_TABLE = "sync_row_state";

/** 同步行元数据 */
export interface SyncRowState {
  tableName: string;
  primaryKey: string;
  originDeviceId: string;
  originTimestamp: string;
  deletedAt: string | null;
  updatedAt: string;
}

/** 单表增量变更集中的墓碑条目 */
export interface DeletedRowChangeset {
  primaryKeyValue: string;
  originDeviceId: string;
  originTimestamp: string;
  deletedAt: string;
}

/** 单表增量变更集（仿 SQLite Session Changeset 结构） */
export interface TableChangeset {
  tableName: string;
  primaryKey: string;
  strategy: SyncMergeStrategy;
  /** 提取时实际使用的 LWW 时间列；合并端按同一列裁决，保证提取与合并不漂移 */
  timestampColumn: string;
  records: Array<Record<string, unknown>>;
  /** 已删除主键的墓碑（仅当调用方安装了同步触发器时才会出现） */
  deleted: DeletedRowChangeset[];
}

/**
 * changeset 传输协议版本（与 `p2p-pairing.ts` 的 P2P 协议版本对齐）。
 * 通过解析式声明读取，避免与其工作流的常量形成双源漂移。
 */
export const SYNC_CHANGESET_PROTOCOL_VERSION: string = P2P_PROTOCOL_VERSION;
/** changeset 结构版本：records/deleted/timestampColumn 布局变化时递增 */
export const SYNC_CHANGESET_SCHEMA_VERSION = "v1";

/** 支持的 changeset 版本集合（fail-closed：仅接受显式列出的版本） */
export const SUPPORTED_SYNC_CHANGESET_VERSIONS = {
  protocol: [SYNC_CHANGESET_PROTOCOL_VERSION],
  schema: [SYNC_CHANGESET_SCHEMA_VERSION],
} as const;

/** 完整端到端同步包 */
export interface P2PSyncBundle {
  bundleId: string;
  protocolVersion: string;
  changesetSchemaVersion: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  sinceWatermark?: string;
  generatedAt: string;
  tables: TableChangeset[];
}

/** 表被整表拒绝的原因（接收端权威白名单与本地元数据校验） */
export type SyncTableRejectionReason =
  /** 对端声明了本地白名单（`options.tables ?? DEFAULT_SYNC_TABLES`）之外的表 */
  | "not_in_whitelist"
  /** 对端声明的主键列与本地定义不一致 */
  | "primary_key_mismatch"
  /** 对端声明的合并策略与本地定义不一致 */
  | "strategy_mismatch"
  /** 对端声明的 LWW 时间列与本地解析结果不一致 */
  | "timestamp_column_mismatch"
  /** 载荷结构非法（records/deleted 不是数组） */
  | "malformed_payload";

/** 被整表拒绝的同步表（该表的任何行/墓碑都不会写入本地） */
export interface RejectedSyncTable {
  tableName: string;
  reason: SyncTableRejectionReason;
  /** 人类可读的对端声明 vs 本地定义差异说明 */
  detail: string;
}

/**
 * 同步合并结果报告。
 *
 * 计数自洽不变量（被拒绝的表不参与计数）：
 * `insertedCount + updatedCount + skippedCount + uniqueConflicts + schemaDriftRows + constraintViolations + tombstonesApplied`
 * ≡ 本次被受理的行与墓碑总数（`tombstonesApplied >= deletedCount`）。
 */
export interface SyncMergeResult {
  /** 本地此前不存在该行并成功写入的数量 */
  insertedCount: number;
  /** 本地已存在该行且被远端版本覆盖的数量（含撤销本地墓碑的“复活”） */
  updatedCount: number;
  /** 因幂等（append_only 已存在、元组完全相等）或 LWW 落败而主动跳过的行/墓碑数；不含被逐行拒绝的行 */
  skippedCount: number;
  /** 时间戳完全相同、由来源设备 ID 决胜分出胜负的次数（行与墓碑两条路径合并统计） */
  conflictsResolvedCount: number;
  /** 实际从本地业务表物理删除的行数（DELETE 生效行数）；本地本就不存在该行时只记墓碑、不计入此字段 */
  deletedCount: number;
  /** 被接受并写入本地墓碑元数据的墓碑条目数（含“本地无行可删”的墓碑）；恒有 `tombstonesApplied >= deletedCount` */
  tombstonesApplied: number;
  /** 因主键/非主键 UNIQUE 冲突被逐行隔离的行数（不中断整包，也不重复计入 `skippedCount`） */
  uniqueConflicts: number;
  /** 因本地表缺列 / 参数绑定失败 / 行缺主键值而被逐行隔离的行数（schema 漂移，同批正常行照常落库） */
  schemaDriftRows: number;
  /** 因 FOREIGN KEY / NOT NULL / CHECK / 类型等约束失败被逐行隔离的行数（不中断整批） */
  constraintViolations: number;
  /** 白名单内但本地不存在的表：schema 漂移必须显式暴露，不再静默跳过 */
  skippedTables: string[];
  /** 被整表拒绝的表（白名单外或对端元数据与本地定义不符）：一行都不写 */
  rejectedTables: RejectedSyncTable[];
  /** 已提交的批次数（成功返回时等于 `totalChunks`；抛 `SyncPartialMergeError` 时为已提交数） */
  appliedChunks: number;
  /** 计划提交的批次数 */
  totalChunks: number;
  /**
   * 结果不完整：存在被整表拒绝/本地缺表的表，或存在被逐行隔离的 schema 漂移/约束行，
   * 或分批未能跑完。LWW 落败与 UNIQUE 冲突隔离属于预期的冲突裁决结果，不计入 `partial`
   * （UNIQUE 冲突请单独检查 `uniqueConflicts`）。
   */
  partial: boolean;
}

/** changeset 传输时的单表载荷结构 */
export interface SyncBundleTable {
  tableName: string;
  primaryKey: string;
  strategy: SyncMergeStrategy;
  timestampColumn: string;
  records: Array<Record<string, unknown>>;
  deleted: DeletedRowChangeset[];
}

/** 同步包版本不兼容错误（fail-closed） */
export class SyncVersionMismatchError extends Error {
  readonly code = "SYNC_VERSION_MISMATCH";
  readonly details: {
    protocolVersion?: string;
    changesetSchemaVersion?: string;
    supportedProtocolVersions: readonly string[];
    supportedChangesetSchemaVersions: readonly string[];
  };

  constructor(message: string, details: SyncVersionMismatchError["details"]) {
    super(message);
    this.name = "SyncVersionMismatchError";
    this.details = details;
  }
}

/** 同步元数据表缺失（schema 漂移）错误 */
export class SyncMetadataTableMissingError extends Error {
  readonly code = "SYNC_METADATA_TABLE_MISSING";
  readonly tableName: string;

  constructor(tableName: string) {
    super(`同步元数据表缺失：${tableName}（请先执行 initDatabaseSchema 或对齐 schema）`);
    this.name = "SyncMetadataTableMissingError";
    this.tableName = tableName;
  }
}

/**
 * 部分合并错误：分批合并中某一批失败，但此前批次**已提交且无法回滚**。
 *
 * 抛出该错误即代表本地库处于“部分应用”状态，调用方必须按批重放（每行幂等）。
 * `partialResult.appliedChunks` / `partialResult.totalChunks` 给出进度，`partialResult.partial === true`。
 * 当第一批就失败（无任何已提交内容）时不包装，直接抛出原始错误。
 */
export class SyncPartialMergeError extends Error {
  readonly code = "SYNC_PARTIAL_MERGE";
  /** 失败前已提交批次的部分合并报告（`partial: true`） */
  readonly partialResult: SyncMergeResult;

  constructor(message: string, partialResult: SyncMergeResult, cause?: unknown) {
    super(message);
    this.name = "SyncPartialMergeError";
    this.partialResult = partialResult;
    if (cause !== undefined) this.cause = cause;
  }
}

/** 同步表白名单违反外键拓扑顺序错误 */
export class SyncTableOrderError extends Error {
  readonly code = "SYNC_TABLE_ORDER_VIOLATION";
  readonly violations: Array<{ child: string; parent: string }>;

  constructor(violations: Array<{ child: string; parent: string }>) {
    super(
      `同步表白名单违反外键拓扑顺序（父表必须在前）：${violations
        .map((v) => `${v.parent} → ${v.child}`)
        .join(", ")}`,
    );
    this.name = "SyncTableOrderError";
    this.violations = violations;
  }
}

/** 合并每批处理的行数：短事务上界，避免长时间持有写锁 */
export const SYNC_MERGE_CHUNK_SIZE = 500;

/** 内部时间戳哨兵列（仅出现在提取结果里，合并端消费后不会写回业务表） */
const EFFECTIVE_TS_ALIAS = "__aervox_ts";

/** 内部来源设备哨兵列：中继同步时必须携带真正的原设备，否则中继者会篡改来源归属 */
const ORIGIN_DEVICE_ALIAS = "__aervox_origin_device";

/** 检查 SQLite 表是否存在 */
async function tableExists(client: Client, tableName: string): Promise<boolean> {
  const res = await client.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [tableName],
  });
  return res.rows.length > 0;
}

/** 读取表的列名集合 */
async function tableColumns(client: Client, tableName: string): Promise<Set<string>> {
  const res = await client.execute(`PRAGMA table_info("${tableName}")`);
  return new Set(res.rows.map((row) => String(row.name)));
}

/** 解析实际可用的 LWW 时间列：定义列 → updated_at → created_at → 主键（防御性兜底） */
function resolveTimestampColumn(def: SyncTableDefinition, columns: Set<string>): string {
  const candidates = [def.timestampColumn, "updated_at", "created_at", def.primaryKey];
  for (const candidate of candidates) {
    if (candidate && columns.has(candidate)) return candidate;
  }
  return def.primaryKey;
}

/** 当前 UTC ISO-8601 时间戳 */
function nowIso(): string {
  return new Date().toISOString();
}

/** 取两个时间戳中较晚者（null/空字符串视为不存在） */
function maxTimestamp(a: string | null | undefined, b: string | null | undefined): string {
  const left = a ?? "";
  const right = b ?? "";
  if (left === "") return right;
  if (right === "") return left;
  return left >= right ? left : right;
}

/**
 * LWW 权威元组：`(比较时钟, origin_device_id)`。
 *
 * - 行的比较时钟 = 该行的权威时间戳（优先 `origin_timestamp`，退化取行时间戳列）；
 * - 墓碑的比较时钟 = `MAX(origin_timestamp, deleted_at)`（删除不推进业务行时间戳，
 *   只看 `origin_timestamp` 会让“删除后立刻同步”的删除落败）。
 *
 * 两条路径（行写入 / 墓碑）**必须**用同一个元组与同一个比较函数裁决，否则会出现
 * “更旧的远端写入复活更新的本地墓碑”这类 LWW 违例。
 */
interface LwwTuple {
  timestamp: string;
  deviceId: string;
}

/**
 * 统一的 LWW 裁决：`incoming` 是否**严格新于** `local`。
 *
 * 时间戳大者胜；时间戳完全相等时来源设备 ID 字典序大者胜；两者都相等 → 落败（幂等跳过，零写入）。
 * 传入的两侧都必须是**持久化的权威元组**，绝不包含“本次中继设备 ID”。
 */
function incomingWinsLww(incoming: LwwTuple, local: LwwTuple): boolean {
  if (incoming.timestamp !== local.timestamp) return incoming.timestamp > local.timestamp;
  return incoming.deviceId > local.deviceId;
}

/** 解析对端携带的来源设备：空值退化到本次发包设备（仅作兜底，绝不覆盖非空权威值） */
function resolveIncomingDevice(raw: unknown, fallback: string): string {
  const value = raw === null || raw === undefined ? "" : String(raw);
  return value !== "" ? value : fallback;
}

/** 读取 libsql 错误的 code 字段 */
function sqliteErrorCode(err: unknown): string {
  return (err as { code?: string } | null)?.code ?? "";
}

/** 读取 libsql 错误的 message 字段 */
function sqliteErrorMessage(err: unknown): string {
  return (err as { message?: string } | null)?.message ?? "";
}

/**
 * 行级可隔离失败的分类（逐行跳过、不中断整批）。
 * 返回 `"fatal"` 表示基础设施级错误（BUSY/IOERR/FULL/未知错误），必须上抛并回滚当前批。
 */
type RowRejectionClassification = "unique_conflict" | "schema_drift" | "constraint_violation";

/**
 * 判断是否为“对端行与本地 schema 不兼容”的语句错误：
 * 本地表缺列（`table X has no column named Y` / `no such column`）、
 * 列数与值数不匹配、参数绑定越界（`SQLITE_RANGE`）、严格表类型不匹配。
 */
function isSchemaDriftStatementError(code: string, message: string): boolean {
  return (
    message.includes("has no column named") ||
    message.includes("no such column") ||
    message.includes("values were supplied") ||
    message.includes("columns but") ||
    message.includes("datatype mismatch") ||
    code.startsWith("SQLITE_RANGE")
  );
}

/** 判断是否为行级约束失败（FOREIGN KEY / NOT NULL / CHECK / DATATYPE 等，UNIQUE 单独归类） */
function isRowConstraintViolation(code: string, message: string): boolean {
  return code.startsWith("SQLITE_CONSTRAINT") || message.includes("constraint failed");
}

/** 把行级 SQL 失败归类：只有与“该行内容”相关的错误才逐行隔离，基础设施错误一律上抛 */
function classifyRowLevelError(err: unknown): RowRejectionClassification | "fatal" {
  const code = sqliteErrorCode(err);
  const message = sqliteErrorMessage(err);
  if (isUniqueConstraintError(err)) return "unique_conflict";
  if (isSchemaDriftStatementError(code, message)) return "schema_drift";
  if (isRowConstraintViolation(code, message)) return "constraint_violation";
  return "fatal";
}

/** 版本校验：不兼容立即抛错，绝不“尽力合并” */
export function assertSyncBundleVersionCompatible(bundle: {
  protocolVersion?: string;
  changesetSchemaVersion?: string;
}): void {
  const supportedProtocol = SUPPORTED_SYNC_CHANGESET_VERSIONS.protocol as readonly string[];
  const supportedSchema = SUPPORTED_SYNC_CHANGESET_VERSIONS.schema as readonly string[];

  if (!bundle.protocolVersion || !supportedProtocol.includes(bundle.protocolVersion)) {
    throw new SyncVersionMismatchError(
      `不兼容的同步协议版本：${bundle.protocolVersion ?? "(缺失)"}，支持：${supportedProtocol.join(", ")}`,
      {
        protocolVersion: bundle.protocolVersion,
        changesetSchemaVersion: bundle.changesetSchemaVersion,
        supportedProtocolVersions: supportedProtocol,
        supportedChangesetSchemaVersions: supportedSchema,
      },
    );
  }

  if (!bundle.changesetSchemaVersion || !supportedSchema.includes(bundle.changesetSchemaVersion)) {
    throw new SyncVersionMismatchError(
      `不兼容的 changeset 结构版本：${bundle.changesetSchemaVersion ?? "(缺失)"}，支持：${supportedSchema.join(", ")}`,
      {
        protocolVersion: bundle.protocolVersion,
        changesetSchemaVersion: bundle.changesetSchemaVersion,
        supportedProtocolVersions: supportedProtocol,
        supportedChangesetSchemaVersions: supportedSchema,
      },
    );
  }
}

/**
 * 校验白名单是否满足外键拓扑顺序（父表必须在子表之前）。
 * 通过只读 PRAGMA 探测真实外键，无外键或表不存在时视为无约束。
 */
export async function assertSyncTableOrder(
  client: Client,
  tables: SyncTableDefinition[] = DEFAULT_SYNC_TABLES,
): Promise<void> {
  const whitelist = new Set(tables.map((t) => t.tableName));
  const position = new Map(tables.map((t, index) => [t.tableName, index]));
  const violations: Array<{ child: string; parent: string }> = [];

  for (const def of tables) {
    if (!(await tableExists(client, def.tableName))) continue;
    const fkRes = await client.execute(`PRAGMA foreign_key_list("${def.tableName}")`);
    for (const row of fkRes.rows) {
      const parent = String(row.table);
      if (!whitelist.has(parent)) continue;
      const childIndex = position.get(def.tableName) ?? -1;
      const parentIndex = position.get(parent) ?? -1;
      if (parentIndex > childIndex) violations.push({ child: def.tableName, parent });
    }
  }

  if (violations.length > 0) throw new SyncTableOrderError(violations);
}

/** 从 SQLite 提取单表增量数据（含墓碑） */
export async function extractTableChangeset(
  client: Client,
  def: SyncTableDefinition,
  options: { sinceWatermark?: string; deviceId?: string } = {},
): Promise<TableChangeset> {
  if (!(await tableExists(client, def.tableName))) {
    return {
      tableName: def.tableName,
      primaryKey: def.primaryKey,
      strategy: def.strategy,
      timestampColumn: def.timestampColumn ?? "updated_at",
      records: [],
      deleted: [],
    };
  }

  const columns = await tableColumns(client, def.tableName);
  const timeCol = resolveTimestampColumn(def, columns);
  const stateReady = await tableExists(client, SYNC_ROW_STATE_TABLE);

  const args: InValue[] = [];
  // 有效时间戳优先取权威元数据 origin_timestamp，其次取行自身时间列，
  // 保证“提取端判定的新旧”与“合并端比较的元组”同源。
  const stateJoin = stateReady
    ? `LEFT JOIN ${SYNC_ROW_STATE_TABLE} s
         ON s.table_name = '${def.tableName}' AND s.primary_key = CAST(r."${def.primaryKey}" AS TEXT)`
    : "";
  const tsExpr = stateReady
    ? `COALESCE(s.origin_timestamp, r."${timeCol}", '')`
    : `COALESCE(r."${timeCol}", '')`;
  // 来源设备哨兵：有元数据时用真正的原设备，否则退化为“本机即来源”。
  // 设备 ID 来自调用方，一律走参数绑定，绝不拼进 SQL 文本（避免引号/注入破坏语句）。
  const deviceExpr = stateReady ? `COALESCE(s.origin_device_id, ?)` : `?`;
  args.push(options.deviceId ?? "");

  let sql =
    `SELECT r.*, ${tsExpr} AS "${EFFECTIVE_TS_ALIAS}", ${deviceExpr} AS "${ORIGIN_DEVICE_ALIAS}" ` +
    `FROM "${def.tableName}" r ${stateJoin}`;
  if (options.sinceWatermark) {
    // 水位线语义为「已包含」，因此等于水位线的行仍会被提取：
    // 否则恰好落在水位上的行会被永久漏掉（尤其是“插入后立刻删除”产生的墓碑）。
    sql += ` WHERE ${tsExpr} >= ? ORDER BY ${tsExpr} ASC`;
    args.push(options.sinceWatermark);
  } else {
    sql += ` ORDER BY r."${def.primaryKey}" ASC`;
  }

  const res = await client.execute({ sql, args });
  const records = res.rows.map((row) => ({ ...row }));

  // 墓碑：元数据中 deleted_at 非空且“比较时间”不早于水位线。
  // 比较时间取 MAX(origin_timestamp, deleted_at)：删除后不再有业务行时间戳推进，
  // 若只看 origin_timestamp 会出现“恰好等于水位的删除永远不传播”。
  const deleted: DeletedRowChangeset[] = [];
  if (stateReady) {
    const tombstoneTsExpr = `MAX(origin_timestamp, deleted_at)`;
    let tombstoneSql = `SELECT primary_key, origin_device_id, origin_timestamp, deleted_at
                        FROM ${SYNC_ROW_STATE_TABLE}
                        WHERE table_name = ? AND deleted_at IS NOT NULL`;
    const tombstoneArgs: InValue[] = [def.tableName];
    if (options.sinceWatermark) {
      tombstoneSql += ` AND ${tombstoneTsExpr} >= ?`;
      tombstoneArgs.push(options.sinceWatermark);
    }
    tombstoneSql += ` ORDER BY ${tombstoneTsExpr} ASC`;
    const tombstoneRes = await client.execute({ sql: tombstoneSql, args: tombstoneArgs });
    for (const row of tombstoneRes.rows) {
      deleted.push({
        primaryKeyValue: String(row.primary_key),
        originDeviceId: String(row.origin_device_id),
        originTimestamp: String(row.origin_timestamp),
        deletedAt: String(row.deleted_at),
      });
    }
  }

  return {
    tableName: def.tableName,
    primaryKey: def.primaryKey,
    strategy: def.strategy,
    timestampColumn: timeCol,
    records,
    deleted,
  };
}

/** 构建完整的点对点增量同步包 */
export async function buildP2PSyncBundle(
  client: Client,
  options: {
    sourceDeviceId: string;
    targetDeviceId: string;
    sinceWatermark?: string;
    tables?: SyncTableDefinition[];
  },
): Promise<P2PSyncBundle> {
  const tableDefs = options.tables ?? DEFAULT_SYNC_TABLES;
  const tables: TableChangeset[] = [];

  for (const def of tableDefs) {
    const cs = await extractTableChangeset(client, def, {
      sinceWatermark: options.sinceWatermark,
      deviceId: options.sourceDeviceId,
    });
    if (cs.records.length > 0 || cs.deleted.length > 0) {
      tables.push(cs);
    }
  }

  const bundle: P2PSyncBundle = {
    bundleId: `sync_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    protocolVersion: SYNC_CHANGESET_PROTOCOL_VERSION,
    changesetSchemaVersion: SYNC_CHANGESET_SCHEMA_VERSION,
    sourceDeviceId: options.sourceDeviceId,
    targetDeviceId: options.targetDeviceId,
    sinceWatermark: options.sinceWatermark,
    generatedAt: nowIso(),
    tables,
  };

  // 构建端同样 fail-closed：产出的包必须自洽，避免把不兼容包发到网络上
  assertSyncBundleVersionCompatible(bundle);
  return bundle;
}

/** 单行的合并工作项 */
type MergeWorkItem =
  | { kind: "row"; table: TableChangeset; row: Record<string, unknown> }
  | { kind: "tombstone"; table: TableChangeset; tombstone: DeletedRowChangeset };

/** 合并统计累加器 */
interface MergeCounters {
  insertedCount: number;
  updatedCount: number;
  skippedCount: number;
  conflictsResolvedCount: number;
  deletedCount: number;
  tombstonesApplied: number;
  uniqueConflicts: number;
  schemaDriftRows: number;
  constraintViolations: number;
}

/** 本地既有状态快照（一行一次预取，避免逐行 SELECT） */
interface LocalRowSnapshot {
  exists: boolean;
  /** 比较时钟：活跃行为 origin_timestamp，墓碑为 max(origin_timestamp, deleted_at) */
  timestamp: string;
  deviceId: string;
  deletedAt: string | null;
}

/** 事务/客户端的最小执行接口 */
interface SqlExecutor {
  execute(stmt: {
    sql: string;
    args: InValue[];
  }): Promise<{ rows: Array<Record<string, unknown>>; rowsAffected?: number }>;
}

/** 写入权威同步元数据（覆盖本地触发器盖上的本机章） */
async function writeRowState(
  tx: SqlExecutor,
  state: SyncRowState,
): Promise<void> {
  await tx.execute({
    sql: `INSERT INTO ${SYNC_ROW_STATE_TABLE}
            (table_name, primary_key, origin_device_id, origin_timestamp, deleted_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(table_name, primary_key) DO UPDATE SET
            origin_device_id = excluded.origin_device_id,
            origin_timestamp = excluded.origin_timestamp,
            deleted_at = excluded.deleted_at,
            updated_at = excluded.updated_at`,
    args: [
      state.tableName,
      state.primaryKey,
      state.originDeviceId,
      state.originTimestamp,
      state.deletedAt,
      state.updatedAt,
    ],
  });
}

/**
 * 预取一批工作项的本地既有状态。
 *
 * 每张表 2 条 SELECT（业务行存在性 + 同步元数据），替代逐行 SELECT；
 * 之后的实际写入都是单条语句（INSERT/UPDATE），不存在 SELECT-then-INSERT 竞态。
 */
async function prefetchLocalSnapshots(
  tx: SqlExecutor,
  tableName: string,
  primaryKeys: string[],
  primaryKeyColumn: string,
  timestampColumn: string,
): Promise<Map<string, LocalRowSnapshot>> {
  const snapshots = new Map<string, LocalRowSnapshot>();
  if (primaryKeys.length === 0) return snapshots;

  const placeholders = primaryKeys.map(() => "?").join(", ");
  const tsAlias = EFFECTIVE_TS_ALIAS;
  const deviceAlias = ORIGIN_DEVICE_ALIAS;
  const rowsRes = await tx.execute({
    sql:
      `SELECT r."${primaryKeyColumn}" AS pk, r."${timestampColumn}" AS ${tsAlias}, ` +
      `(SELECT origin_device_id FROM ${SYNC_ROW_STATE_TABLE} ` +
      ` WHERE table_name = ? AND primary_key = CAST(r."${primaryKeyColumn}" AS TEXT)) AS ${deviceAlias} ` +
      `FROM "${tableName}" r WHERE r."${primaryKeyColumn}" IN (${placeholders})`,
    args: [tableName, ...primaryKeys],
  });
  for (const row of rowsRes.rows) {
    snapshots.set(String(row.pk), {
      exists: true,
      timestamp: String(row[tsAlias] ?? ""),
      deviceId: row[deviceAlias] === null || row[deviceAlias] === undefined ? "" : String(row[deviceAlias]),
      deletedAt: null,
    });
  }

  const stateRes = await tx.execute({
    sql: `SELECT primary_key, origin_device_id, origin_timestamp, deleted_at
          FROM ${SYNC_ROW_STATE_TABLE}
          WHERE table_name = ? AND primary_key IN (${placeholders})`,
    args: [tableName, ...primaryKeys],
  });
  for (const row of stateRes.rows) {
    const pk = String(row.primary_key);
    const existing = snapshots.get(pk) ?? {
      exists: false,
      timestamp: "",
      deviceId: "",
      deletedAt: null,
    };
    const deletedAt =
      row.deleted_at === null || row.deleted_at === undefined ? null : String(row.deleted_at);
    snapshots.set(pk, {
      ...existing,
      // 墓碑的比较时钟必须含 deleted_at，否则“删除后立刻同步”会因时间戳相等而落败
      timestamp: maxTimestamp(String(row.origin_timestamp), deletedAt),
      deviceId: String(row.origin_device_id),
      deletedAt,
    });
  }

  return snapshots;
}

/** 判断是否为 UNIQUE 约束冲突（含主键冲突） */
function isUniqueConstraintError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code ?? "";
  const message = (err as { message?: string } | null)?.message ?? "";
  return (
    code.startsWith("SQLITE_CONSTRAINT_UNIQUE") ||
    code.startsWith("SQLITE_CONSTRAINT_PRIMARYKEY") ||
    message.includes("UNIQUE constraint failed")
  );
}

/** 业务行写入结果：`rejected` 表示该行可被逐行隔离地跳过（不中断整批） */
type RowWriteOutcome =
  | { kind: "inserted" }
  | { kind: "updated" }
  | { kind: "skipped" }
  | { kind: "rejected"; classification: RowRejectionClassification };

/**
 * 执行一条“携带对端行内容”的语句，并把失败归类。
 *
 * 与 `writeRowState` 的区别：这里的失败可能来源于对端行的列/值与本地 schema 不兼容
 * （缺列、绑定失败、约束冲突），属于**单行问题**，必须逐行隔离而不是炸掉整批；
 * 基础设施级错误（BUSY/IOERR/FULL/未知）归类为 `fatal` 并原样返回，由调用方上抛回滚当前批。
 */
async function executeRowStatement(
  tx: SqlExecutor,
  sql: string,
  args: InValue[],
): Promise<
  | { ok: true; rowsAffected: number | undefined }
  | { ok: false; classification: RowRejectionClassification | "fatal"; error: unknown }
> {
  try {
    const res = await tx.execute({ sql, args });
    return { ok: true, rowsAffected: res.rowsAffected };
  } catch (err) {
    return { ok: false, classification: classifyRowLevelError(err), error: err };
  }
}

/**
 * 写入业务行并随后写权威元数据。
 *
 * 顺序不可颠倒：业务行写入会触发本地同步触发器盖本机章，只有最后写的 `sync_row_state`
 * 才能把真正的来源设备/时间戳固化下来（墓碑同理，见 `applyMergeItem` 的删除分支）。
 *
 * 注意：**本函数不做 LWW 裁决**。调用方（`applyMergeItem`）已用统一的权威元组比对过，
 * 走到这里就意味着本次写入胜出；若本地存在墓碑，则在这里完成“复活”
 * （先物理删行再插入，最后把 `deleted_at` 清空写入权威元数据）。
 */
async function writeBusinessRow(
  tx: SqlExecutor,
  options: {
    tableName: string;
    primaryKey: string;
    timestampColumn: string;
    strategy: SyncMergeStrategy;
    row: Record<string, unknown>;
    effectiveTimestamp: string;
    local: LocalRowSnapshot;
    originDeviceId: string;
  },
): Promise<RowWriteOutcome> {
  const { tableName, primaryKey, timestampColumn, strategy, local, originDeviceId } = options;
  const pkValue = options.row[primaryKey];

  // 行内时间列必须与权威元数据严格同源：既保证“下次同步判定为无变化”，
  // 也保证实体时间戳语义不落后于元数据（否则会反复产生无意义的 UPDATE）。
  const row: Record<string, unknown> = { ...options.row };
  const rowHasTimestampColumn = strategy === "lww" && timestampColumn in row;
  if (rowHasTimestampColumn) {
    // 无有效时间戳时才退化为本地当前时间，并让元数据使用同一个值
    row[timestampColumn] = options.effectiveTimestamp || nowIso();
  }
  const appliedTimestamp = String(row[timestampColumn] ?? options.effectiveTimestamp ?? "");
  const cols = Object.keys(row).filter(
    (col) => col !== EFFECTIVE_TS_ALIAS && col !== ORIGIN_DEVICE_ALIAS,
  );

  const origin: SyncRowState = {
    tableName,
    primaryKey: String(pkValue),
    originDeviceId,
    originTimestamp: appliedTimestamp || nowIso(),
    deletedAt: null,
    updatedAt: nowIso(),
  };

  // 本地存在墓碑且本次写入（已通过元组裁决）胜出：复活该行
  const resurrect = local.deletedAt !== null;
  const existed = local.exists || resurrect;

  if (!local.exists || resurrect) {
    if (resurrect) {
      // 物理行仍在（墓碑与行并存）或需要覆盖：先物理删除再插入，保证行内容完全来自远端
      await tx.execute({
        sql: `DELETE FROM "${tableName}" WHERE "${primaryKey}" = ?`,
        args: [toInValue(pkValue)],
      });
    }
    const insert = await executeRowStatement(
      tx,
      `INSERT INTO "${tableName}" (${cols.map((c) => `"${c}"`).join(", ")})
       VALUES (${cols.map(() => "?").join(", ")})`,
      cols.map((col) => toInValue(row[col])),
    );
    if (!insert.ok) {
      if (insert.classification === "fatal") throw insert.error;
      return { kind: "rejected", classification: insert.classification };
    }
    await writeRowState(tx, origin);
    return existed ? { kind: "updated" } : { kind: "inserted" };
  }

  if (strategy === "append_only") {
    // 不可变事实流：已存在即幂等忽略，且不得覆盖既有事实
    return { kind: "skipped" };
  }

  const updateCols = cols.filter((col) => col !== primaryKey);
  if (updateCols.length === 0) {
    // 没有可更新列（只有主键）时退化为写元数据
    await writeRowState(tx, origin);
    return { kind: "updated" };
  }
  const update = await executeRowStatement(
    tx,
    `UPDATE "${tableName}" SET ${updateCols.map((c) => `"${c}" = ?`).join(", ")}
     WHERE "${primaryKey}" = ?`,
    [...updateCols.map((col) => toInValue(row[col])), toInValue(pkValue)],
  );
  if (!update.ok) {
    if (update.classification === "fatal") throw update.error;
    return { kind: "rejected", classification: update.classification };
  }
  await writeRowState(tx, origin);
  return { kind: "updated" };
}

/** 按分类累计被逐行隔离的行数（彼此互斥，绝不重复计数） */
function countRowRejection(counters: MergeCounters, classification: RowRejectionClassification): void {
  if (classification === "unique_conflict") counters.uniqueConflicts++;
  else if (classification === "schema_drift") counters.schemaDriftRows++;
  else counters.constraintViolations++;
}

/**
 * 应用单个合并工作项（在已打开的事务内）。
 *
 * 两条路径（行写入 / 墓碑）**共用同一个** `incomingWinsLww` 元组裁决：
 * - 行 vs 行、行 vs 墓碑、墓碑 vs 行、墓碑 vs 墓碑一律走同一规则，
 *   因此“删除只能被严格更新的写入（含设备 ID 决胜）撤销”，更旧的远端写入绝不复活较新的本地墓碑；
 * - 本地既无业务行也无元数据（惰性播种）时不做比较，直接写入。
 */
async function applyMergeItem(
  tx: SqlExecutor,
  item: MergeWorkItem,
  bundle: P2PSyncBundle,
  counters: MergeCounters,
  prefetched: LocalRowSnapshot | undefined,
  localDeviceId: string,
): Promise<void> {
  const table = item.table;
  const sourceDeviceId = bundle.sourceDeviceId;
  const strategy = table.strategy ?? "lww";
  const timestampColumn = table.timestampColumn ?? "updated_at";

  /** 本地权威元组：元数据缺失时设备退化到本机（惰性播种），但绝不使用“本次中继设备”做 tiebreak */
  const localTupleFor = (snapshot: LocalRowSnapshot): LwwTuple => ({
    timestamp: snapshot.timestamp,
    deviceId: snapshot.deviceId || localDeviceId,
  });

  if (item.kind === "tombstone") {
    const { primaryKeyValue, originDeviceId, originTimestamp, deletedAt } = item.tombstone;
    // 比较时钟取 max(origin_timestamp, deleted_at)：删除不会推进业务行时间戳，
    // 只比较 origin_timestamp 会导致“删除后立刻同步”时删除落败。
    const incomingTs = maxTimestamp(originTimestamp, deletedAt);
    const incomingDevice = resolveIncomingDevice(originDeviceId, sourceDeviceId);
    const incomingTuple: LwwTuple = { timestamp: incomingTs, deviceId: incomingDevice };

    // 本地存在持久化状态时按权威元组裁决：本地不落后 → 幂等跳过（墓碑已存在，或删除落败于更新的写入）
    if (prefetched !== undefined) {
      const localTuple = localTupleFor(prefetched);
      if (!incomingWinsLww(incomingTuple, localTuple)) {
        counters.skippedCount++;
        return;
      }
      if (incomingTuple.timestamp === localTuple.timestamp) counters.conflictsResolvedCount++;
    }

    const deleted = await executeRowStatement(
      tx,
      `DELETE FROM "${table.tableName}" WHERE "${table.primaryKey}" = ?`,
      [toInValue(primaryKeyValue)],
    );
    if (!deleted.ok) {
      if (deleted.classification === "fatal") throw deleted.error;
      countRowRejection(counters, deleted.classification);
      return;
    }
    // 必须后写权威墓碑：DELETE 触发器会先盖成本机章
    await writeRowState(tx, {
      tableName: table.tableName,
      primaryKey: primaryKeyValue,
      originDeviceId: incomingDevice,
      originTimestamp: originTimestamp || incomingTs || nowIso(),
      deletedAt: deletedAt || incomingTs || nowIso(),
      updatedAt: nowIso(),
    });
    counters.tombstonesApplied++;
    // 只有真的删掉了本地业务行才计入 deletedCount；本地本就不存在该行时只是登记墓碑
    const physicallyDeleted =
      deleted.rowsAffected !== undefined ? deleted.rowsAffected > 0 : (prefetched?.exists ?? false);
    if (physicallyDeleted) counters.deletedCount++;
    return;
  }

  const row = item.row;
  const pkValue = row[table.primaryKey];
  if (pkValue === undefined || pkValue === null) {
    // 对端行缺少主键值 → 无法定位本地行，逐行隔离并计入 schema 漂移
    counters.schemaDriftRows++;
    return;
  }
  const incomingDevice = resolveIncomingDevice(row[ORIGIN_DEVICE_ALIAS], sourceDeviceId);
  const incomingTs = maxTimestamp(
    row[EFFECTIVE_TS_ALIAS] as string | undefined,
    row[timestampColumn] as string | undefined,
  );
  // 元数据缺失时的播种基准：行自身时间戳 + 本机设备（而不是中继设备）
  const local: LocalRowSnapshot =
    prefetched ?? {
      exists: false,
      timestamp: incomingTs,
      deviceId: localDeviceId,
      deletedAt: null,
    };

  const incomingTuple: LwwTuple = { timestamp: incomingTs, deviceId: incomingDevice };

  // 本地无任何持久化状态（既无行也无墓碑）：惰性播种，不做 LWW 比较，直接写入
  if (prefetched !== undefined) {
    if (strategy === "append_only" && local.exists) {
      // 不可变事实流：主键已存在即幂等忽略，绝不覆盖既有事实
      counters.skippedCount++;
      return;
    }
    const localTuple = localTupleFor(local);
    if (!incomingWinsLww(incomingTuple, localTuple)) {
      counters.skippedCount++;
      return;
    }
    if (incomingTuple.timestamp === localTuple.timestamp) counters.conflictsResolvedCount++;
  }

  const outcome = await writeBusinessRow(tx, {
    tableName: table.tableName,
    primaryKey: table.primaryKey,
    timestampColumn,
    strategy,
    row,
    effectiveTimestamp: incomingTs,
    local,
    originDeviceId: incomingDevice,
  });

  if (outcome.kind === "rejected") {
    countRowRejection(counters, outcome.classification);
    return;
  }
  if (outcome.kind === "inserted") counters.insertedCount++;
  else if (outcome.kind === "updated") counters.updatedCount++;
  else counters.skippedCount++;
}

/**
 * 应用一批合并工作项（一个短写事务，绝不在事务内做慢 I/O）。
 */
async function applyTableBatch(
  client: Client,
  items: MergeWorkItem[],
  bundle: P2PSyncBundle,
  counters: MergeCounters,
  localDeviceId: string,
): Promise<void> {
  const tx = await client.transaction("write");
  try {
    // 按表分组预取本地状态：每表 2 条 SELECT，替代逐行 SELECT
    const grouped = new Map<string, { primaryKey: string; timestampColumn: string; keys: string[] }>();
    for (const item of items) {
      const table = item.table;
      const group = grouped.get(table.tableName) ?? {
        primaryKey: table.primaryKey,
        timestampColumn: table.timestampColumn ?? "updated_at",
        keys: [],
      };
      const key =
        item.kind === "row"
          ? String(item.row[table.primaryKey] ?? "")
          : item.tombstone.primaryKeyValue;
      if (key !== "") group.keys.push(key);
      grouped.set(table.tableName, group);
    }

    const snapshots = new Map<string, LocalRowSnapshot>();
    for (const [tableName, group] of grouped) {
      const tableSnapshots = await prefetchLocalSnapshots(
        tx,
        tableName,
        group.keys,
        group.primaryKey,
        group.timestampColumn,
      );
      for (const [key, snapshot] of tableSnapshots) {
        snapshots.set(`${tableName}\u0000${key}`, snapshot);
      }
    }

    for (const item of items) {
      const key =
        item.kind === "row"
          ? String(item.row[item.table.primaryKey] ?? "")
          : item.tombstone.primaryKeyValue;
      const scoped = snapshots.get(`${item.table.tableName}\u0000${key}`);
      await applyMergeItem(tx, item, bundle, counters, scoped, localDeviceId);
    }

    await tx.commit();
  } catch (err) {
    await tx.rollback();
    throw err;
  }
}

/**
 * 解析对端包中的同步表，并按**本地**白名单与元数据校验后重排。
 *
 * 安全边界（F1）：接收端绝不信任对端声明的表身份与列元数据——
 * - 白名单外（`options.tables ?? DEFAULT_SYNC_TABLES`）的表整表拒绝，一行都不写；
 * - 对端 `primaryKey` / `strategy` / `timestampColumn` 与本地定义不符时整表拒绝并显式上报；
 * - 输出的顺序**一律是本地白名单顺序**（即本地外键拓扑顺序），绝不沿用对端包的顺序；
 * - 输出条目的 `primaryKey` / `strategy` / `timestampColumn` 全部取自本地定义。
 */
async function resolveIncomingTables(
  client: Client,
  bundle: P2PSyncBundle,
  tableDefs: SyncTableDefinition[],
  skippedTables: string[],
  rejectedTables: RejectedSyncTable[],
): Promise<TableChangeset[]> {
  const defsByName = new Map(tableDefs.map((def) => [def.tableName, def]));
  const accepted = new Map<
    string,
    {
      records: Array<Record<string, unknown>>;
      deleted: DeletedRowChangeset[];
      localTimestampColumn: string;
    }
  >();
  const missing = new Set<string>();

  for (const table of bundle.tables) {
    const def = defsByName.get(table.tableName);
    if (!def) {
      rejectedTables.push({
        tableName: table.tableName,
        reason: "not_in_whitelist",
        detail: `对端声明了本地同步白名单之外的表，整表拒绝（白名单：${
          tableDefs.map((t) => t.tableName).join(", ") || "(空)"
        }）`,
      });
      continue;
    }
    if (missing.has(def.tableName)) continue;
    if (!(await tableExists(client, def.tableName))) {
      // 白名单表本地缺失 = schema 漂移，显式上报而不是静默 continue
      missing.add(def.tableName);
      skippedTables.push(def.tableName);
      continue;
    }
    if (!Array.isArray(table.records) || !Array.isArray(table.deleted ?? [])) {
      rejectedTables.push({
        tableName: def.tableName,
        reason: "malformed_payload",
        detail: "对端载荷的 records/deleted 不是数组，整表拒绝",
      });
      continue;
    }

    const columns = await tableColumns(client, def.tableName);
    const localTimestampColumn = resolveTimestampColumn(def, columns);
    const mismatch = describeIncomingMetadataMismatch(table, def, localTimestampColumn);
    if (mismatch) {
      rejectedTables.push({ tableName: def.tableName, ...mismatch });
      continue;
    }

    const bucket = accepted.get(def.tableName) ?? {
      records: [],
      deleted: [],
      localTimestampColumn,
    };
    bucket.records.push(...table.records);
    bucket.deleted.push(...table.deleted);
    accepted.set(def.tableName, bucket);
  }

  // 按本地白名单顺序输出：外键父表必须排在子表之前，绝不采用对端包顺序
  const resolved: TableChangeset[] = [];
  for (const def of tableDefs) {
    const bucket = accepted.get(def.tableName);
    if (!bucket) continue;
    resolved.push({
      tableName: def.tableName,
      primaryKey: def.primaryKey,
      strategy: def.strategy,
      timestampColumn: bucket.localTimestampColumn,
      records: bucket.records,
      deleted: bucket.deleted,
    });
  }
  return resolved;
}

/** 比对对端声明的表元数据与本地定义；不一致时返回拒绝原因与说明 */
function describeIncomingMetadataMismatch(
  table: TableChangeset,
  def: SyncTableDefinition,
  localTimestampColumn: string,
): { reason: SyncTableRejectionReason; detail: string } | null {
  if (table.primaryKey !== def.primaryKey) {
    return {
      reason: "primary_key_mismatch",
      detail: `对端声明主键 ${String(table.primaryKey)}，本地定义为 ${def.primaryKey}`,
    };
  }
  if (table.strategy !== def.strategy) {
    return {
      reason: "strategy_mismatch",
      detail: `对端声明策略 ${String(table.strategy)}，本地定义为 ${def.strategy}`,
    };
  }
  // 旧包可能省略 timestampColumn：缺省时以本地定义为准；一旦声明就必须与本地解析结果一致
  if (
    table.timestampColumn !== undefined &&
    table.timestampColumn !== null &&
    table.timestampColumn !== "" &&
    table.timestampColumn !== localTimestampColumn
  ) {
    return {
      reason: "timestamp_column_mismatch",
      detail: `对端声明时间列 ${String(table.timestampColumn)}，本地解析为 ${localTimestampColumn}`,
    };
  }
  return null;
}

/**
 * 将远端同步包应用合并到本地 SQLite 数据库中。
 *
 * 接收端权威性（F1）：有效白名单取 `options.tables ?? DEFAULT_SYNC_TABLES`，对端包内的表清单
 * 只用于比对与上报，绝不作为写入依据；表元数据（主键/策略/时间列）与合并顺序也一律以本地为准。
 *
 * 写入被切成 `SYNC_MERGE_CHUNK_SIZE` 行的短事务：整包**不是**原子的（trade-off 见模块头注释），
 * 但每一行都是幂等写入，可按批重放；分批跑不完时抛 `SyncPartialMergeError` 并附带已提交批次的报告。
 */
export async function applyP2PSyncBundle(
  client: Client,
  bundle: P2PSyncBundle,
  localDeviceId: string,
  options: { tables?: SyncTableDefinition[]; chunkSize?: number } = {},
): Promise<SyncMergeResult> {
  // 版本门禁：不兼容直接拒绝，绝不尝试“尽力合并”
  assertSyncBundleVersionCompatible(bundle);

  const counters: MergeCounters = {
    insertedCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    conflictsResolvedCount: 0,
    deletedCount: 0,
    tombstonesApplied: 0,
    uniqueConflicts: 0,
    schemaDriftRows: 0,
    constraintViolations: 0,
  };
  const skippedTables: string[] = [];
  const rejectedTables: RejectedSyncTable[] = [];

  if (!(await tableExists(client, SYNC_ROW_STATE_TABLE))) {
    // 墓碑与 LWW 元组都依赖该表；缺失说明 schema 漂移，fail-closed 而不是悄悄降级
    throw new SyncMetadataTableMissingError(SYNC_ROW_STATE_TABLE);
  }

  // 接收端权威白名单：缺省即本地默认白名单，绝不读取对端声明的表清单
  const tableDefs = options.tables ?? DEFAULT_SYNC_TABLES;
  // F5：接收端同样按本地外键拓扑看护，避免“对端包顺序”决定合并顺序而撞 FK
  await assertSyncTableOrder(client, tableDefs);

  const tables = await resolveIncomingTables(
    client,
    bundle,
    tableDefs,
    skippedTables,
    rejectedTables,
  );

  const chunkSize = Math.max(1, options.chunkSize ?? SYNC_MERGE_CHUNK_SIZE);
  const work: MergeWorkItem[] = [];
  for (const table of tables) {
    for (const row of table.records) work.push({ kind: "row", table, row });
    for (const tombstone of table.deleted) work.push({ kind: "tombstone", table, tombstone });
  }

  const totalChunks = Math.ceil(work.length / chunkSize);
  let appliedChunks = 0;

  const buildResult = (partial: boolean): SyncMergeResult => ({
    ...counters,
    skippedTables: [...skippedTables],
    rejectedTables: [...rejectedTables],
    appliedChunks,
    totalChunks,
    partial,
  });

  try {
    for (let offset = 0; offset < work.length; offset += chunkSize) {
      const batch = work.slice(offset, offset + chunkSize);
      await applyTableBatch(client, batch, bundle, counters, localDeviceId);
      appliedChunks++;
    }
  } catch (err) {
    if (appliedChunks > 0) {
      // 已提交的批次无法回滚：必须让调用方明确知道“本地已经是部分应用状态”
      throw new SyncPartialMergeError(
        `同步合并部分应用后失败：已提交 ${appliedChunks}/${totalChunks} 批且无法回滚，` +
          `调用方必须按批重放（每行幂等）`,
        buildResult(true),
        err,
      );
    }
    throw err;
  }

  const partial =
    appliedChunks < totalChunks ||
    rejectedTables.length > 0 ||
    skippedTables.length > 0 ||
    counters.schemaDriftRows > 0 ||
    counters.constraintViolations > 0;

  return buildResult(partial);
}

/**
 * 完整模拟两台设备（如 Node A: Electron 桌面端, Node B: Capacitor 移动端）
 * 通过加密通道进行双向 P2P 增量同步与数据对齐。
 *
 * 水位线方向：A 的包用 A 自己的 since 水位（`aSince`），B 的包用 B 自己的（`bSince`）；
 * 反了会让双方互相回传对方已有的数据（既浪费带宽，也会触发无意义的重复合并）。
 *
 * 会话方向：必须传入**两端各自持有的会话**。分向密钥按方向派生，且 AAD 绑定方向与序号，
 * 因此同一个会话对象既加密又解密会因方向不符而被拒绝。旧实现用单会话承担双向通信，
 * 依赖双方共享同一把对称密钥，属于已修复的设计缺陷。
 */
export async function executeP2PBidirectionalSync(options: {
  nodeA: { client: Client; deviceId: string };
  nodeB: { client: Client; deviceId: string };
  /** `nodeA` 为 A 端会话（A→B 加密、B→A 解密）；`nodeB` 为 B 端会话 */
  sessions: { nodeA: EstablishedP2PSession; nodeB: EstablishedP2PSession };
  tables?: SyncTableDefinition[];
  watermarks?: { aSince?: string; bSince?: string };
}): Promise<{
  aToBResult: SyncMergeResult;
  bToAResult: SyncMergeResult;
  syncTimestamp: string;
}> {
  const syncTimestamp = nowIso();

  // 1. Node A 提取自身增量 Changeset（用 A 自己的水位）并加密发送给 Node B
  const bundleA = await buildP2PSyncBundle(options.nodeA.client, {
    sourceDeviceId: options.nodeA.deviceId,
    targetDeviceId: options.nodeB.deviceId,
    sinceWatermark: options.watermarks?.aSince,
    tables: options.tables,
  });

  const encryptedAtoB: EncryptedSyncPayload = encryptSyncPayload(options.sessions.nodeA, bundleA);

  // 2. Node B 解密（版本门禁）并应用 Node A 的 Changeset
  const decryptedAtoB = decryptSyncPayload<P2PSyncBundle>(options.sessions.nodeB, encryptedAtoB);
  assertSyncBundleVersionCompatible(decryptedAtoB);
  const aToBResult = await applyP2PSyncBundle(
    options.nodeB.client,
    decryptedAtoB,
    options.nodeB.deviceId,
    { tables: options.tables },
  );

  // 3. Node B 提取自身增量 Changeset（用 B 自己的水位）并加密发送给 Node A
  const bundleB = await buildP2PSyncBundle(options.nodeB.client, {
    sourceDeviceId: options.nodeB.deviceId,
    targetDeviceId: options.nodeA.deviceId,
    sinceWatermark: options.watermarks?.bSince,
    tables: options.tables,
  });

  const encryptedBtoA: EncryptedSyncPayload = encryptSyncPayload(options.sessions.nodeB, bundleB);

  // 4. Node A 解密（版本门禁）并应用 Node B 的 Changeset
  const decryptedBtoA = decryptSyncPayload<P2PSyncBundle>(options.sessions.nodeA, encryptedBtoA);
  assertSyncBundleVersionCompatible(decryptedBtoA);
  const bToAResult = await applyP2PSyncBundle(
    options.nodeA.client,
    decryptedBtoA,
    options.nodeA.deviceId,
    { tables: options.tables },
  );

  return {
    aToBResult,
    bToAResult,
    syncTimestamp,
  };
}

/** 同步触发器后缀：INSERT / UPDATE / DELETE */
export const SYNC_TRIGGER_SUFFIXES = ["ai", "au", "ad"] as const;

/** 同步触发器名称 */
export function triggerName(
  tableName: string,
  suffix: (typeof SYNC_TRIGGER_SUFFIXES)[number],
): string {
  return `aervox_sync_${tableName}_${suffix}`;
}

/** 生成单表同步触发器 SQL */
export function buildSyncTriggerSql(def: SyncTableDefinition, deviceId: string): string[] {
  const tsCol = def.timestampColumn ?? "updated_at";
  const nowExpr = `strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
  const rowTs = `COALESCE(NEW."${tsCol}", ${nowExpr})`;
  const pk = `CAST(NEW."${def.primaryKey}" AS TEXT)`;
  const stamp = (rowTsExpr: string) => `INSERT INTO ${SYNC_ROW_STATE_TABLE}
        (table_name, primary_key, origin_device_id, origin_timestamp, deleted_at, updated_at)
      VALUES ('${def.tableName}', ${pk}, '${deviceId}', ${rowTsExpr}, NULL, ${nowExpr})
      ON CONFLICT(table_name, primary_key) DO UPDATE SET
        origin_device_id = excluded.origin_device_id,
        origin_timestamp = excluded.origin_timestamp,
        deleted_at = NULL,
        updated_at = excluded.updated_at`;

  return [
    `CREATE TRIGGER IF NOT EXISTS ${triggerName(def.tableName, "ai")}
      AFTER INSERT ON "${def.tableName}"
      FOR EACH ROW
      BEGIN
        ${stamp(rowTs)};
      END`,
    // UPDATE 只在“更晚写入”时推进来源；并且必须清空旧墓碑（复活），
    // 否则一次删除会让该行此后再也无法本地更新。
    `CREATE TRIGGER IF NOT EXISTS ${triggerName(def.tableName, "au")}
      AFTER UPDATE ON "${def.tableName}"
      FOR EACH ROW
      BEGIN
        INSERT INTO ${SYNC_ROW_STATE_TABLE}
          (table_name, primary_key, origin_device_id, origin_timestamp, deleted_at, updated_at)
        VALUES ('${def.tableName}', ${pk}, '${deviceId}', ${rowTs}, NULL, ${nowExpr})
        ON CONFLICT(table_name, primary_key) DO UPDATE SET
          origin_device_id = excluded.origin_device_id,
          origin_timestamp = excluded.origin_timestamp,
          deleted_at = NULL,
          updated_at = excluded.updated_at
        WHERE excluded.origin_timestamp > ${SYNC_ROW_STATE_TABLE}.origin_timestamp;
      END`,
    // DELETE 保留原始写入时间戳作为 origin_timestamp，删除时刻单独记入 deleted_at：
    // 提取端的比较时钟取 max(origin_timestamp, deleted_at)，既保证幂等也保证删除能传播。
    `CREATE TRIGGER IF NOT EXISTS ${triggerName(def.tableName, "ad")}
      AFTER DELETE ON "${def.tableName}"
      FOR EACH ROW
      BEGIN
        INSERT INTO ${SYNC_ROW_STATE_TABLE}
          (table_name, primary_key, origin_device_id, origin_timestamp, deleted_at, updated_at)
        VALUES ('${def.tableName}', CAST(OLD."${def.primaryKey}" AS TEXT), '${deviceId}',
                COALESCE((SELECT origin_timestamp FROM ${SYNC_ROW_STATE_TABLE}
                          WHERE table_name = '${def.tableName}'
                            AND primary_key = CAST(OLD."${def.primaryKey}" AS TEXT)),
                         COALESCE(OLD."${tsCol}", ${nowExpr})),
                ${nowExpr}, ${nowExpr})
        ON CONFLICT(table_name, primary_key) DO UPDATE SET
          deleted_at = excluded.deleted_at,
          updated_at = excluded.updated_at;
      END`,
  ];
}

/**
 * 为白名单表安装同步触发器（调用方显式 opt-in；`initDatabaseSchema` 不会自动安装）。
 *
 * 触发器只负责**本机写入**的登记：INSERT/UPDATE 盖章来源设备与行时间戳，DELETE 写墓碑。
 * 远端合并写入的权威元数据由 `applyP2PSyncBundle` 在同一事务内覆盖。
 */
export async function installSyncTriggers(
  client: Client,
  tables: SyncTableDefinition[],
  deviceId: string,
): Promise<void> {
  for (const def of tables) {
    if (!(await tableExists(client, def.tableName))) continue;
    await removeSyncTriggers(client, [def]);
    for (const sql of buildSyncTriggerSql(def, deviceId)) {
      await client.execute(sql);
    }
  }
}

/** 卸下同步触发器（幂等，可重复调用） */
export async function removeSyncTriggers(
  client: Client,
  tables: SyncTableDefinition[],
): Promise<void> {
  for (const def of tables) {
    if (!(await tableExists(client, def.tableName))) continue;
    for (const suffix of SYNC_TRIGGER_SUFFIXES) {
      await client.execute(`DROP TRIGGER IF EXISTS ${triggerName(def.tableName, suffix)}`);
    }
  }
}

/** 读取整库同步元数据（测试与诊断用；墓碑包含在内） */
export async function readSyncRowStates(
  client: Client,
  tableName?: string,
): Promise<SyncRowState[]> {
  if (!(await tableExists(client, SYNC_ROW_STATE_TABLE))) return [];
  const sql = tableName
    ? `SELECT table_name, primary_key, origin_device_id, origin_timestamp, deleted_at, updated_at
       FROM ${SYNC_ROW_STATE_TABLE} WHERE table_name = ? ORDER BY primary_key ASC`
    : `SELECT table_name, primary_key, origin_device_id, origin_timestamp, deleted_at, updated_at
       FROM ${SYNC_ROW_STATE_TABLE} ORDER BY table_name ASC, primary_key ASC`;
  const res = await client.execute({ sql, args: tableName ? [tableName] : [] });
  return res.rows.map((row) => ({
    tableName: String(row.table_name),
    primaryKey: String(row.primary_key),
    originDeviceId: String(row.origin_device_id),
    originTimestamp: String(row.origin_timestamp),
    deletedAt:
      row.deleted_at === null || row.deleted_at === undefined ? null : String(row.deleted_at),
    updatedAt: String(row.updated_at),
  }));
}
