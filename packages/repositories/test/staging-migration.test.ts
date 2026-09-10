import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/client.js";
import {
  atomicSwapCr030Database,
  buildCr030Staging,
  validateCr030Staging,
} from "../src/migration/staging-migration.js";

describe("CR-030 staging and atomic swap", () => {
  it("copies only the selected scope, preserves foreign keys, and validates counts", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-cr030-staging-"));
    const sourcePath = path.join(directory, "source.db");
    const stagingPath = path.join(directory, "staging.db");
    try {
      const source = await createDatabase({ url: `file:${sourcePath}` });
      const staging = await createDatabase({ url: `file:${stagingPath}` });
      await source.client.execute("CREATE TABLE parents (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL)");
      await source.client.execute("CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parents(id), workspace_id TEXT NOT NULL, subject_user_id TEXT NOT NULL)");
      await staging.client.execute("CREATE TABLE parents (id TEXT PRIMARY KEY)");
      await staging.client.execute("CREATE TABLE children (id TEXT PRIMARY KEY, parent_id TEXT NOT NULL REFERENCES parents(id))");
      await source.client.execute("INSERT INTO parents VALUES ('p1','w1','u1'),('p2','w2','u2')");
      await source.client.execute("INSERT INTO children VALUES ('c1','p1','w1','u1'),('c2','p2','w2','u2')");
      const result = await buildCr030Staging({
        source: source.client,
        staging: staging.client,
        selectedScope: { workspaceId: "w1", subjectUserId: "u1" },
      });
      expect(result.copiedRowsByTable.parents).toBe(1);
      expect(result.copiedRowsByTable.children).toBe(1);
      await validateCr030Staging(staging.client, { parents: 1, children: 1 });
      const parentColumns = await staging.client.execute("PRAGMA table_info(parents)");
      expect(parentColumns.rows.map((row) => row.name)).toEqual(["id"]);
      const childRows = await staging.client.execute("SELECT id, parent_id FROM children");
      expect(childRows.rows).toMatchObject([{ id: "c1", parent_id: "p1" }]);
      source.client.close();
      staging.client.close();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("atomically swaps source and staging, retaining rollback", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-cr030-swap-"));
    const sourcePath = path.join(directory, "aervox.db");
    const stagingPath = path.join(directory, "aervox.db.cr030.staging");
    const rollbackPath = path.join(directory, "aervox.db.rollback");
    try {
      await fs.writeFile(sourcePath, "old");
      await fs.writeFile(stagingPath, "new");
      await atomicSwapCr030Database({ sourcePath, stagingPath, rollbackPath });
      expect(await fs.readFile(sourcePath, "utf8")).toBe("new");
      expect(await fs.readFile(rollbackPath, "utf8")).toBe("old");
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
