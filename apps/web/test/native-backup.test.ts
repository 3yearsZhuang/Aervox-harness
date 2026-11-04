import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT, BACKUP_FORMAT_VERSION, BackupParseError,
  buildBackupFile, denormalizeBackupValue, normalizeBackupValue, parseBackupFile, verifyBackupShape,
} from '../src/mobile/native-backup';

// Deterministic digest stub: hash the JSON shape so tests can tamper predictably.
const digest = (value: unknown) => `h_${JSON.stringify(value).length}`;

const sampleTables = [
  { name: 'sessions', columns: ['id', 'title'], rows: [{ id: 'ses_1', title: '新对话' }] },
  { name: 'turns', columns: ['id', 'sessionId'], rows: [{ id: 'turn_1', sessionId: 'ses_1' }] },
];

describe('backup envelope', () => {
  it('round-trips driver values that JSON cannot carry', () => {
    const value = normalizeBackupValue(42n);
    expect(JSON.parse(JSON.stringify(value))).toEqual({ __bigint: '42' });
    expect(denormalizeBackupValue({ __bigint: '42' })).toBe(42n);
    const bytes = new Uint8Array([1, 2, 255]);
    const blob = normalizeBackupValue(bytes);
    expect(denormalizeBackupValue(JSON.parse(JSON.stringify(blob)))).toEqual(bytes);
  });

  it('builds a hash-verified envelope and parses it back', () => {
    const file = buildBackupFile(sampleTables, digest, '2026-11-03T00:00:00.000Z');
    expect(file).toMatchObject({
      format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION,
      tableCounts: { sessions: 1, turns: 1 },
    });
    expect(parseBackupFile(JSON.stringify(file), digest)).toEqual(file);
  });

  it('refuses tampered payloads and unknown formats with fixed codes', () => {
    const file = buildBackupFile(sampleTables, digest);
    const tampered = { ...file, tables: [{ ...sampleTables[0], rows: [] }] };
    expect(() => parseBackupFile(JSON.stringify(tampered), digest)).toThrowError(
      expect.objectContaining({ code: 'BACKUP_CORRUPTED' }));
    expect(() => parseBackupFile('not json', digest)).toThrowError(
      expect.objectContaining({ code: 'BACKUP_MALFORMED' }));
    expect(() => parseBackupFile(JSON.stringify({ ...file, format: 'other' }), digest)).toThrowError(
      expect.objectContaining({ code: 'BACKUP_FORMAT_UNKNOWN' }));
    expect(() => parseBackupFile(JSON.stringify({ ...file, formatVersion: 99 }), digest)).toThrowError(
      expect.objectContaining({ code: 'BACKUP_FORMAT_UNKNOWN' }));
    const missingColumn = { ...file, tables: [{ name: 'sessions', columns: ['id', 'title'], rows: [{ id: 'x' }] }] };
    expect(() => parseBackupFile(JSON.stringify(missingColumn), digest)).toThrowError(
      expect.objectContaining({ code: 'BACKUP_MALFORMED' }));
  });

  it('rejects duplicate tables, duplicate columns and extra row fields before restore', () => {
    for (const tables of [
      [sampleTables[0]!, sampleTables[0]!],
      [{ name: 'sessions', columns: ['id', 'id'], rows: [{ id: 's' }] }],
      [{ name: 'sessions', columns: ['id'], rows: [{ id: 's', extra: 'hidden' }] }],
    ]) {
      const file = buildBackupFile(tables, digest);
      expect(() => parseBackupFile(JSON.stringify(file), digest)).toThrowError(
        expect.objectContaining({ code: 'BACKUP_MALFORMED' }));
    }
  });

  it('refuses schema drift in either direction', () => {
    const file = buildBackupFile(sampleTables, digest);
    const live = new Map([['sessions', ['id', 'title']], ['turns', ['id', 'sessionId']]]);
    expect(() => verifyBackupShape(file, live)).not.toThrow();
    // Backup misses a live table.
    expect(() => verifyBackupShape(file, new Map([...live, ['plans', ['id']]]))).toThrowError(
      expect.objectContaining({ code: 'BACKUP_SCHEMA_MISMATCH' }));
    // Columns drift.
    expect(() => verifyBackupShape(file, new Map([['sessions', ['id', 'title', 'extra']], ['turns', ['id', 'sessionId']]]))).toThrowError(
      expect.objectContaining({ code: 'BACKUP_SCHEMA_MISMATCH' }));
    // Unknown table in the backup.
    expect(() => verifyBackupShape(file, new Map([['sessions', ['id', 'title']]]))).toThrowError(
      expect.objectContaining({ code: 'BACKUP_SCHEMA_MISMATCH' }));
    expect(new BackupParseError('BACKUP_CORRUPTED').code).toBe('BACKUP_CORRUPTED');
  });
});
