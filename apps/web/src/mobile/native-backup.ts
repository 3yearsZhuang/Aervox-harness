/** Mobile backup envelope: self-describing, hash-verified, schema-strict.
 *
 * The export carries each table's column shape alongside its rows so the
 * importer can verify the file against the live database without trusting the
 * sender: exact column match or a hard refusal, never a silent partial write.
 * The digest covers the payload only, so transport metadata cannot be swapped
 * without detection.
 */

export const BACKUP_FORMAT = 'aervox-mobile-backup';
export const BACKUP_FORMAT_VERSION = 1;

export interface BackupTable {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
}

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: string;
  tableCounts: Record<string, number>;
  tables: BackupTable[];
  sha256: string;
}

/** Driver values must survive JSON round-trips (bigint, blobs). */
export function normalizeBackupValue(value: unknown): unknown {
  if (typeof value === 'bigint') return { __bigint: value.toString() };
  if (value instanceof Uint8Array) {
    let binary = '';
    for (const byte of value) binary += String.fromCharCode(byte);
    return { __blob: btoa(binary) };
  }
  return value;
}

export function denormalizeBackupValue(value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.__bigint === 'string') return BigInt(record.__bigint);
    if (typeof record.__blob === 'string') {
      const binary = atob(record.__blob);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }
  }
  return value;
}

export function buildBackupFile(
  tables: BackupTable[],
  digest: (value: unknown) => string,
  createdAt = new Date().toISOString(),
): BackupFile {
  const tableCounts: Record<string, number> = {};
  for (const table of tables) tableCounts[table.name] = table.rows.length;
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt,
    tableCounts,
    tables,
    sha256: digest({ tables }),
  };
}

export type BackupParseFailure =
  | 'BACKUP_MALFORMED'
  | 'BACKUP_FORMAT_UNKNOWN'
  | 'BACKUP_CORRUPTED'
  | 'BACKUP_SCHEMA_MISMATCH';

export class BackupParseError extends Error {
  constructor(readonly code: BackupParseFailure, message?: string) { super(message ?? code); }
}

/** Parse and verify a backup text; throws a fixed code on any doubt. */
export function parseBackupFile(text: string, digest: (value: unknown) => string): BackupFile {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new BackupParseError('BACKUP_MALFORMED'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new BackupParseError('BACKUP_MALFORMED');
  const file = parsed as Partial<BackupFile>;
  if (file.format !== BACKUP_FORMAT || typeof file.formatVersion !== 'number') throw new BackupParseError('BACKUP_FORMAT_UNKNOWN');
  if (file.formatVersion !== BACKUP_FORMAT_VERSION) throw new BackupParseError('BACKUP_FORMAT_UNKNOWN');
  if (!Array.isArray(file.tables)) throw new BackupParseError('BACKUP_MALFORMED');
  const names = new Set<string>();
  for (const table of file.tables) {
    if (!table || typeof table.name !== 'string' || !Array.isArray(table.columns) || !Array.isArray(table.rows)) {
      throw new BackupParseError('BACKUP_MALFORMED');
    }
    if (names.has(table.name)) throw new BackupParseError('BACKUP_MALFORMED');
    names.add(table.name);
    if (!table.columns.length || table.columns.some(column => typeof column !== 'string')
      || new Set(table.columns).size !== table.columns.length) throw new BackupParseError('BACKUP_MALFORMED');
    for (const row of table.rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new BackupParseError('BACKUP_MALFORMED');
      if (Object.keys(row).length !== table.columns.length) throw new BackupParseError('BACKUP_MALFORMED');
      for (const column of table.columns) {
        if (!Object.hasOwn(row, column)) throw new BackupParseError('BACKUP_MALFORMED');
      }
    }
  }
  if (digest({ tables: file.tables }) !== file.sha256) throw new BackupParseError('BACKUP_CORRUPTED');
  return file as BackupFile;
}

/**
 * The importer is strict by design: the backup's column set for every table
 * must match the live schema exactly. A schema drift is a refusal to write,
 * never a best-effort merge.
 */
export function verifyBackupShape(
  file: BackupFile,
  liveColumns: Map<string, string[]>,
): void {
  const backupNames = new Set(file.tables.map(table => table.name));
  for (const name of liveColumns.keys()) {
    if (!backupNames.has(name)) throw new BackupParseError('BACKUP_SCHEMA_MISMATCH', `backup misses table: ${name}`);
  }
  for (const table of file.tables) {
    const live = liveColumns.get(table.name);
    if (!live) throw new BackupParseError('BACKUP_SCHEMA_MISMATCH', `unknown table: ${table.name}`);
    const backupColumns = [...table.columns].sort();
    const expected = [...live].sort();
    if (backupColumns.length !== expected.length || backupColumns.some((column, index) => column !== expected[index])) {
      throw new BackupParseError('BACKUP_SCHEMA_MISMATCH', `column mismatch: ${table.name}`);
    }
  }
}
