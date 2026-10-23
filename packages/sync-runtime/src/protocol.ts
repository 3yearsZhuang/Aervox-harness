export const P2P_PROTOCOL_VERSION = "v1";

/** 合并策略：lww 为状态覆盖，append_only 为不可变事实流 */
export type SyncMergeStrategy = "lww" | "append_only";

/** 同步表定义与冲突合并策略 */
export interface SyncTableDefinition {
  tableName: string;
  primaryKey: string;
  timestampColumn?: string; // 用于 LWW 比对的时间列，默认 "updated_at"
  strategy: SyncMergeStrategy;
}


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


/** Transport sees changesets only; persistence, table allowlists and transaction policy stay in the adapter. */
export interface SyncChangesetPort {
  build(input: { sourceDeviceId: string; targetDeviceId: string; sinceWatermark?: string }): Promise<P2PSyncBundle>;
  apply(bundle: P2PSyncBundle, localDeviceId: string): Promise<SyncMergeResult>;
}
