/**
 * Aervox｜思隅 @aervox/repositories — content 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";
import { addColumnIfMissing } from "./common.js";

export async function createContentTables(client: Client): Promise<void> {
  // 14. 内容/资源域（PRD §8）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        object_key TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL DEFAULT 0,
        scan_status TEXT NOT NULL DEFAULT 'pending',
        source_license TEXT,
        deleted_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  // CAP-012：扩展 attachments 表（用途声明、解析状态、幂等键）
    await addColumnIfMissing(client, "attachments", "purpose", "purpose TEXT");
  await addColumnIfMissing(client, "attachments", "parse_status", "parse_status TEXT NOT NULL DEFAULT 'pending'");
  await addColumnIfMissing(client, "attachments", "idempotency_key", "idempotency_key TEXT");
  // CAP-012 FR-EXT-002：附件解析结果表
    await client.execute(`
      CREATE TABLE IF NOT EXISTS attachment_parse_results (
        id TEXT PRIMARY KEY,
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        parse_status TEXT NOT NULL DEFAULT 'pending',
        parsed_text TEXT,
        confidence INTEGER,
        parse_error TEXT,
        crop_data TEXT,
        operation TEXT NOT NULL DEFAULT 'ocr',
        idempotency_key TEXT,
        superseded_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS attachment_parse_results_attachment_idx ON attachment_parse_results(attachment_id);
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS attachment_parse_results_idem_idx
      ON attachment_parse_results(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    `);
  await client.execute(`
      CREATE TABLE IF NOT EXISTS embedding_indexes (
        id TEXT PRIMARY KEY,
        source_artifact_id TEXT NOT NULL,
        source_revision_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        dimension INTEGER NOT NULL DEFAULT 0,
        index_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS embedding_indexes_source_idx ON embedding_indexes(source_artifact_id);
    `);
}
