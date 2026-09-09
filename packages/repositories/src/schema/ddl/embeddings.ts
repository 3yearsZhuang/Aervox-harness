/**
 * Aervox｜思隅 @aervox/repositories — embeddings 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";

export async function createEmbeddingsTables(client: Client): Promise<void> {
  // T-05 记忆向量独立表（向量数据本体；任务/版本状态在 embedding_indexes）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,
        dimension INTEGER NOT NULL,
        model_id TEXT NOT NULL,
        embedding_json TEXT NOT NULL,
        source_created_at TEXT,
        index_version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_embeddings_tenant_idx ON memory_embeddings(workspace_id, subject_user_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_embeddings_memory_idx ON memory_embeddings(memory_id);
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS memory_embeddings_model_idx ON memory_embeddings(model_id);
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS memory_embeddings_memory_model_idx
      ON memory_embeddings(workspace_id, subject_user_id, memory_id, model_id);
    `);
}
