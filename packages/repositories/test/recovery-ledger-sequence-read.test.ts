import { afterEach, beforeEach, expect, it } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { SqliteRecoveryLedgerRepository } from "../src/repositories/sqlite/recovery-ledger-repository.js";

let client: Client;
let ledger: SqliteRecoveryLedgerRepository;
beforeEach(async () => {
  client = createClient({url: ":memory:"});
  await SqliteRecoveryLedgerRepository.init(client);
  ledger = new SqliteRecoveryLedgerRepository(client);
  await ledger.appendEvent({eventId: "original", idempotencyKey: "original", eventType: "delete"});
});
afterEach(() => client.close());

it.each([0, -1, 1.5, "broken", 9007199254740992])("refuses persisted sequence %j at maximum, receipt and retry reads", async sequence => {
  await client.execute({sql: "UPDATE recovery_control_ledger SET sequence=? WHERE event_id='original'", args: [sequence]});
  for (const operation of [() => ledger.getMaxSequence(), () => ledger.getByIdempotencyKey("original"),
    () => ledger.appendEvent({eventId: "original", idempotencyKey: "original", eventType: "delete"})]) {
    await expect(operation()).rejects.toMatchObject({message: "recovery_ledger_sequence_invalid"});
  }
  expect((await client.execute("SELECT count(*) AS total FROM recovery_control_ledger")).rows[0]?.total).toBe(1);
});

it("does not let a higher valid maximum hide an invalid earlier sequence", async () => {
  await ledger.appendEvent({eventId: "later", idempotencyKey: "later", eventType: "delete"});
  await client.execute("UPDATE recovery_control_ledger SET sequence=-1 WHERE event_id='original'");
  await expect(ledger.getMaxSequence()).rejects.toMatchObject({message: "recovery_ledger_sequence_invalid"});
});

it.each(["invalid", "duplicate", "gap", "overflow"])("refuses a fresh append to a %s sequence history without adding a row", async kind => {
  if (kind === "duplicate") {
    await ledger.appendEvent({eventId: "later", idempotencyKey: "later", eventType: "delete"});
    await client.execute("UPDATE recovery_control_ledger SET sequence=1 WHERE event_id='later'");
  } else {
    await client.execute({sql: "UPDATE recovery_control_ledger SET sequence=? WHERE event_id='original'",
      args: [kind === "invalid" ? -1 : kind === "gap" ? 3 : 9007199254740991]});
  }
  const before = await client.execute("SELECT event_id, sequence FROM recovery_control_ledger ORDER BY event_id");
  await expect(ledger.appendEvent({eventId: "new", idempotencyKey: "new", eventType: "delete"}))
    .rejects.toMatchObject({message: "recovery_ledger_append_untrusted_sequence"});
  expect((await client.execute("SELECT event_id, sequence FROM recovery_control_ledger ORDER BY event_id")).rows).toEqual(before.rows);
});

it("refuses an ambiguous sequence without choosing a durable control event", async () => {
  await ledger.appendEvent({eventId: "later", idempotencyKey: "later", eventType: "consent_revoke"});
  await client.execute("UPDATE recovery_control_ledger SET sequence=1 WHERE event_id='later'");
  await expect(ledger.getBySequence(1)).rejects.toMatchObject({message: "recovery_ledger_sequence_ambiguous"});
  expect((await client.execute("SELECT count(*) AS total FROM recovery_control_ledger")).rows[0]?.total).toBe(2);
});

it.each([0, -1, 1.5, NaN, Infinity, 9007199254740992])("refuses invalid lookup sequence %j before querying SQLite", async sequence => {
  let reads = 0;
  const reader = new Proxy(client, {get(owner, property) {
    if (property === "execute") return (...args: Parameters<Client["execute"]>) => { reads++; return owner.execute(...args); };
    const value = Reflect.get(owner, property, owner);
    return typeof value === "function" ? value.bind(owner) : value;
  }});
  await expect(new SqliteRecoveryLedgerRepository(reader).getBySequence(sequence)).rejects.toMatchObject({message: "recovery_ledger_sequence_invalid"});
  expect(reads).toBe(0);
});

it("preserves valid receipts, gaps and the empty-ledger maximum without writing", async () => {
  const original = await ledger.getBySequence(1);
  expect(await ledger.getByIdempotencyKey("original")).toEqual(original);
  expect(await ledger.getBySequence(2)).toBeNull();
  expect(await ledger.getMaxSequence()).toBe(1);
  await client.execute("UPDATE recovery_control_ledger SET sequence=3 WHERE event_id='original'");
  expect(await ledger.getMaxSequence()).toBe(3);
  expect(await ledger.inspectConsistency()).toMatchObject({missingSequences: [1, 2]});
  await client.execute("DELETE FROM recovery_control_ledger");
  expect(await ledger.getMaxSequence()).toBe(0);
});
