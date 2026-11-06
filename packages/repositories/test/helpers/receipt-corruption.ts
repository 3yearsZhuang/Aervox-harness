import type { Client } from "@libsql/client";

type Corruption = { name: string; path: string; value: unknown } | { name: string; remove: string } | { name: string; root: unknown };

export const receiptCorruptions: Corruption[] = [
  { name: "root null", root: null },
  { name: "root array", root: [] },
  { name: "missing intent", remove: "$.intent" },
  { name: "empty intent", path: "$.intent", value: {} },
  { name: "null intent", path: "$.intent", value: null },
  { name: "array intent", path: "$.intent", value: [] },
  { name: "string intent", path: "$.intent", value: "invalid" },
  { name: "number intent", path: "$.intent", value: 1 },
  { name: "missing message", remove: "$.intent.message" },
  { name: "empty message", path: "$.intent.message", value: {} },
  { name: "null message", path: "$.intent.message", value: null },
  { name: "array message", path: "$.intent.message", value: [] },
  { name: "string message", path: "$.intent.message", value: "invalid" },
  { name: "missing attachments", remove: "$.intent.message.attachments" },
  { name: "nontext content", path: "$.intent.message.content", value: 1 },
  { name: "unsupported content type", path: "$.intent.message.contentType", value: "html" },
  { name: "missing version", remove: "$.intent.version" },
  { name: "unsupported version", path: "$.intent.version", value: 2 },
  { name: "string version", path: "$.intent.version", value: "1" },
  { name: "nonarray references", path: "$.intent.references", value: {} },
  { name: "scalar reference", path: "$.intent.references", value: ["invalid"] },
  { name: "incomplete reference", path: "$.intent.references", value: [{ sourceId: "source" }] },
  { name: "nonobject metadata", path: "$.intent.metadata", value: [] },
  { name: "unsupported tool mode", path: "$.intent.toolApprovalMode", value: "allow" },
  { name: "nontext actor", path: "$.intent.actorId", value: 1 },
  { name: "mismatched intent session", path: "$.intent.sessionId", value: "other" },
  { name: "mismatched intent policy", path: "$.intent.executionPolicy", value: "bot-owner-v1" },
  { name: "mismatched receipt Turn", path: "$.turnId", value: "other" },
  { name: "mismatched receipt session", path: "$.sessionId", value: "other" },
  { name: "mismatched receipt hash", path: "$.requestHash", value: `turn-intent-v1:${"0".repeat(64)}` },
];

export async function corruptReceipt(client: Pick<Client, "execute">, turnId: string, corruption: Corruption): Promise<void> {
  const id = `outbox_${turnId}`;
  if ("root" in corruption) await client.execute({ sql: "UPDATE outbox_events SET payload=? WHERE id=?", args: [JSON.stringify(corruption.root), id] });
  else if ("remove" in corruption) await client.execute({ sql: "UPDATE outbox_events SET payload=json_remove(payload,?) WHERE id=?", args: [corruption.remove, id] });
  else await client.execute({ sql: "UPDATE outbox_events SET payload=json_set(payload,?,json(?)) WHERE id=?", args: [corruption.path, JSON.stringify(corruption.value), id] });
}
