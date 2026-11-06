import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DomainConflictError, SqliteRecoveryLedgerRepository } from "../src/index.js";

let client: Client;
let ledger: SqliteRecoveryLedgerRepository;
beforeEach(async () => {
  client = createClient({ url: ":memory:" });
  await SqliteRecoveryLedgerRepository.init(client);
  ledger = new SqliteRecoveryLedgerRepository(client);
});
afterEach(() => client.close());

async function insert(sequence: number | string, id = "event"): Promise<void> {
  await client.execute({ sql: "INSERT INTO recovery_control_ledger (event_id, idempotency_key, event_type, occurred_at, sequence) VALUES (?, ?, 'delete', '2026-01-01', ?)",
    args: [id, id, sequence] });
}
const budgetError = new DomainConflictError("recovery_ledger_consistency_budget_exceeded");

describe("bounded read-only ledger diagnostics", () => {
  it.each(["number", "bigint", "string"] as const)("reads exact valid sequences through Client intMode=%s", async intMode => {
    const directory = mkdtempSync(join(tmpdir(), "aervox-ledger-mode-"));
    const url = `file:${join(directory, "ledger.db")}`;
    const initializer = createClient({ url });
    let reader: Client | undefined;
    try {
      // Schema setup retains its existing default-driver contract. This checks
      // diagnostics on the same persisted ledger through each accepted Client.
      await SqliteRecoveryLedgerRepository.init(initializer);
      await initializer.execute("INSERT INTO recovery_control_ledger (event_id, idempotency_key, event_type, occurred_at, sequence) VALUES ('a','a','delete','2026-01-01',1), ('b','b','delete','2026-01-01',3), ('c','c','delete','2026-01-01',1)");
      reader = createClient({ url, intMode });
      const report = new SqliteRecoveryLedgerRepository(reader);
      expect(await report.inspectConsistency()).toEqual({ eventCount: 3, maxSequence: 3, duplicatedSequences: [1], missingSequences: [2] });
      await initializer.execute("UPDATE recovery_control_ledger SET sequence = 9223372036854775807 WHERE event_id = 'b'");
      await expect(report.inspectConsistency()).rejects.toThrow(new DomainConflictError("recovery_ledger_sequence_invalid"));
    } finally {
      reader?.close(); initializer.close(); rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports empty and unordered small snapshots exactly without mutating rows", async () => {
    expect(await ledger.inspectConsistency()).toEqual({ eventCount: 0, maxSequence: 0, duplicatedSequences: [], missingSequences: [] });
    for (const [index, sequence] of [4, 1, 1].entries()) await insert(sequence, `event-${index}`);
    const before = (await client.execute("SELECT * FROM recovery_control_ledger ORDER BY event_id")).rows;
    expect(await ledger.inspectConsistency()).toEqual({ eventCount: 3, maxSequence: 4, duplicatedSequences: [1], missingSequences: [2, 3] });
    expect((await client.execute("SELECT * FROM recovery_control_ledger ORDER BY event_id")).rows).toEqual(before);
  });

  it.each([0, -1, 1.5, "invalid", "9007199254740992", "9223372036854775807"])("refuses invalid persisted sequence %j", async sequence => {
    await insert(sequence);
    await expect(ledger.inspectConsistency()).rejects.toThrow(new DomainConflictError("recovery_ledger_sequence_invalid"));
    expect((await client.execute("SELECT count(*) AS total FROM recovery_control_ledger")).rows[0]?.total).toBe(1);
  });

  it("refuses a safe but enormous gap before expanding it", async () => {
    await insert(Number.MAX_SAFE_INTEGER);
    await expect(ledger.inspectConsistency()).rejects.toThrow(budgetError);
  });

  it("returns the exact gap budget and refuses the next missing value", async () => {
    await insert(10_001);
    const exact = await ledger.inspectConsistency();
    expect(exact).toMatchObject({ eventCount: 1, maxSequence: 10_001, duplicatedSequences: [] });
    expect(exact.missingSequences).toHaveLength(10_000);
    expect(exact.missingSequences[0]).toBe(1);
    expect(exact.missingSequences.at(-1)).toBe(10_000);
    await client.execute("UPDATE recovery_control_ledger SET sequence = 10002");
    await expect(ledger.inspectConsistency()).rejects.toThrow(budgetError);
  });

  it("accumulates separate gaps against one diagnostic budget", async () => {
    await insert(5_001, "first");
    await insert(10_003, "second");
    await expect(ledger.inspectConsistency()).rejects.toThrow(budgetError);
  });

  it("refuses excessive duplicate diagnostics without returning a partial report", async () => {
    await client.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 20002) INSERT INTO recovery_control_ledger (event_id, idempotency_key, event_type, occurred_at, sequence) SELECT 'event-' || i, 'key-' || i, 'delete', '2026-01-01', (i+1)/2 FROM n");
    await expect(ledger.inspectConsistency()).rejects.toThrow(budgetError);
    expect((await client.execute("SELECT count(*) AS total FROM recovery_control_ledger")).rows[0]?.total).toBe(20_002);
  });

  it("accepts the row budget and refuses its next row without truncation", async () => {
    await client.execute("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i < 100000) INSERT INTO recovery_control_ledger (event_id, idempotency_key, event_type, occurred_at, sequence) SELECT 'event-' || i, 'key-' || i, 'delete', '2026-01-01', i FROM n");
    expect(await ledger.inspectConsistency()).toEqual({ eventCount: 100_000, maxSequence: 100_000, duplicatedSequences: [], missingSequences: [] });
    await insert(100_001);
    await expect(ledger.inspectConsistency()).rejects.toThrow(budgetError);
    expect((await client.execute("SELECT count(*) AS total FROM recovery_control_ledger")).rows[0]?.total).toBe(100_001);
  });
});
