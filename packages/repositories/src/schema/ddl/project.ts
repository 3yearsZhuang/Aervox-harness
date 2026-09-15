/**
 * Aervox｜思隅 @aervox/repositories — 项目实体表 DDL (CR-048 / W3)
 */
import type { Client } from "@libsql/client";

export async function createProjectTables(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      color TEXT,
      icon TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  await client.execute(`
    CREATE INDEX IF NOT EXISTS projects_name_idx ON projects(name);
  `);
}
