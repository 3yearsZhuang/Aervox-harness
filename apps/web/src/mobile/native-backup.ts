/** Mobile backup envelope: self-describing, hash-verified, schema-strict.
 *
 * The export carries each table's column shape alongside its rows so the
 * importer can verify the file against the live database without trusting the
 * sender: exact column match or a hard refusal, never a silent partial write.
 * The digest covers table data. Transport metadata is checked separately and
 * counts must agree with the verified rows.
 */

export const BACKUP_FORMAT = 'aervox-mobile-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const MAX_BACKUP_BYTES = 16 * 1024 * 1024;

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
  | 'BACKUP_SCHEMA_MISMATCH'
  | 'BACKUP_TOO_LARGE'
  | 'BACKUP_RESTORE_BLOCKED';

export class BackupParseError extends Error {
  constructor(readonly code: BackupParseFailure, message?: string) { super(message ?? code); }
}

/** Parse and verify a backup text; throws a fixed code on any doubt. */
export function parseBackupFile(text: string, digest: (value: unknown) => string): BackupFile {
  if (new TextEncoder().encode(text).byteLength > MAX_BACKUP_BYTES) throw new BackupParseError('BACKUP_TOO_LARGE');
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
  if (typeof file.createdAt !== 'string' || !Number.isFinite(Date.parse(file.createdAt))
    || !file.tableCounts || typeof file.tableCounts !== 'object' || Array.isArray(file.tableCounts)
    || Object.keys(file.tableCounts).length !== file.tables.length
    || file.tables.some(table => !Object.hasOwn(file.tableCounts!, table.name)
      || file.tableCounts![table.name] !== table.rows.length)) throw new BackupParseError('BACKUP_MALFORMED');
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

interface ForeignKey { columns: string[]; target: string; targetColumns: string[] }
const restoreBlocked = (): never => { throw new BackupParseError('BACKUP_RESTORE_BLOCKED'); };

/** Parse only the canonical, trusted sqlite_master definitions, never backup DDL. */
function foreignKeys(definition: string): ForeignKey[] {
  const keys: ForeignKey[] = [];
  const identifier = (value: string) => {
    const name = value.trim().replace(/^"(.*)"$/, '$1');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return restoreBlocked();
    return name;
  };
  const pattern = /FOREIGN\s+KEY\s*\(([^)]+)\)\s+REFERENCES\s+("[^"]+"|[A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]+)\)/gi;
  for (const match of definition.matchAll(pattern)) {
    const columns = match[1]!.split(',').map(identifier);
    const targetColumns = match[3]!.split(',').map(identifier);
    if (!columns.length || columns.length !== targetColumns.length) return restoreBlocked();
    keys.push({ columns, target: identifier(match[2]!), targetColumns });
  }
  if ((definition.match(/\bREFERENCES\b/gi) ?? []).length !== keys.length) return restoreBlocked();
  return keys;
}

/** Plan dependency order before the first write. Native transaction failures
 * quarantine the connection, so rejected INSERTs must never be used as probes.
 * Cyclic dependencies which cannot be inserted with immediate FKs are refused.
 */
export function planBackupRestore(file: BackupFile, definitions: Map<string, string>): BackupTable[] {
  const tables = new Map(file.tables.map(table => [table.name, table]));
  const keys = new Map([...definitions].map(([name, ddl]) => [name, foreignKeys(ddl)]));
  const ordered: BackupTable[] = [], visiting = new Set<string>(), visited = new Set<string>();
  const key = (row: Record<string, unknown>, columns: string[]) => {
    const values = columns.map(column => {
      if (!Object.hasOwn(row, column)) return restoreBlocked();
      const value = row[column];
      if (value === null) return null;
      if (typeof value === 'string' || typeof value === 'number') return String(value);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        if (typeof record.__bigint === 'string') return BigInt(record.__bigint).toString();
        if (typeof record.__blob === 'string') return `blob:${record.__blob}`;
      }
      return restoreBlocked();
    });
    return values.some(value => value === null) ? null : JSON.stringify(values);
  };
  const indexes = new Map<string, Map<string, number>>();
  const indexFor = (table: BackupTable, columns: string[]) => {
    const name = JSON.stringify([table.name, columns]);
    let index = indexes.get(name);
    if (!index) {
      index = new Map();
      table.rows.forEach((row, position) => {
        const value = key(row, columns);
        if (value !== null) {
          if (index!.has(value)) return restoreBlocked();
          index!.set(value, position);
        }
      });
      indexes.set(name, index);
    }
    return index;
  };
  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) return restoreBlocked();
    const table = tables.get(name);
    if (!table || !definitions.has(name)) return restoreBlocked();
    visiting.add(name);
    for (const foreign of keys.get(name) ?? []) if (foreign.target !== name) visit(foreign.target);
    const rowOrder: number[] = [], rowVisiting = new Set<number>(), rowVisited = new Set<number>();
    const visitRow = (position: number) => {
      if (rowVisited.has(position)) return;
      if (rowVisiting.has(position)) return restoreBlocked();
      rowVisiting.add(position);
      for (const foreign of keys.get(name) ?? []) {
        const value = key(table.rows[position]!, foreign.columns);
        if (value === null) continue;
        const parent = tables.get(foreign.target);
        if (!parent) return restoreBlocked();
        const targetPosition = indexFor(parent, foreign.targetColumns).get(value);
        if (targetPosition === undefined) return restoreBlocked();
        if (foreign.target === name && targetPosition !== position) visitRow(targetPosition);
      }
      rowVisiting.delete(position); rowVisited.add(position); rowOrder.push(position);
    };
    table.rows.forEach((_, position) => visitRow(position));
    ordered.push({ ...table, rows: rowOrder.map(position => table.rows[position]!) });
    visiting.delete(name); visited.add(name);
  };
  for (const name of tables.keys()) visit(name);
  return ordered;
}
