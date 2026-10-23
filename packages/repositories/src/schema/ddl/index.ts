/** Bootstrap and upgrades share one schema gate. Live legacy structures are inspected before any write. */
import type { Client } from "@libsql/client";
import { initializeCanonicalSchema } from "../manifest.js";
import { createFtsTables } from "./fts.js";

export async function initDatabaseSchema(client: Client): Promise<void> {
  await initializeCanonicalSchema(client, "main");
  await createFtsTables(client);
}
export async function initLedgerSchema(client: Client): Promise<void> {
  await initializeCanonicalSchema(client, "ledger");
}
