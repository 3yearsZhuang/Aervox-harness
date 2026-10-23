import { describe, expect, it } from "vitest";
import { createInMemoryDatabase } from "../src/index.js";
import { exportSnapshot, restoreSnapshotToEmptyStaging, snapshotFileName } from "../src/sync/git-snapshot.js";

describe("logical snapshots", () => {
  it("round trips parent and child rows without cascade deletion, excludes all virtual/shadow tables", async () => {
    const source = await createInMemoryDatabase(), target = await createInMemoryDatabase();
    try {
      await source.client.execute("INSERT INTO sessions(id,title,created_at,updated_at) VALUES ('s','session','t','t')");
      await source.client.execute("INSERT INTO turns(id,session_id,idempotency_key,status,created_at,updated_at) VALUES ('t','s','i','Completed','t','t')");
      await source.client.execute("INSERT INTO messages(id,session_id,role,current_version_id,created_at) VALUES ('m','s','user','mv','t')");
      await source.client.execute("INSERT INTO message_versions(id,turn_id,message_id,role,content,created_at) VALUES ('mv','t','m','user','retained','t')");
      await source.client.execute("CREATE VIRTUAL TABLE custom_search USING fts5(content)");
      const snapshot = JSON.parse(JSON.stringify(await exportSnapshot(source.client, 1)));
      expect(Object.keys(snapshot.tables).some((table) => table.includes("fts") || table.includes("custom_search"))).toBe(false);
      expect(snapshot.tables._aervox_schema_versions).toBeUndefined();
      await restoreSnapshotToEmptyStaging(target.client, snapshot);
      expect((await target.client.execute("SELECT content FROM message_versions")).rows[0]?.content).toBe("retained");
      expect((await target.client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);
      await expect(restoreSnapshotToEmptyStaging(target.client, snapshot)).rejects.toThrow("must be empty");
    } finally { await source.cleanup(); await target.cleanup(); }
  });
  it("rolls back the entire staging import on a broken foreign key", async () => {
    const target = await createInMemoryDatabase();
    try {
      await expect(restoreSnapshotToEmptyStaging(target.client, { version: 1, exportedAt: "t", tables: {
        sessions: [{ id: "s", title: "parent", created_at: "t", updated_at: "t" }],
        turns: [{ id: "broken", session_id: "missing", idempotency_key: "i", status: "Completed", created_at: "t", updated_at: "t" }],
      } })).rejects.toThrow("foreign key check");
      expect((await target.client.execute("SELECT * FROM sessions")).rows).toEqual([]);
    } finally { await target.cleanup(); }
  });
  it("keeps file identity stable", () => expect(snapshotFileName(3)).toBe("snapshot-v3.json"));
});
