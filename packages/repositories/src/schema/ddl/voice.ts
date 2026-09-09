/**
 * Aervox｜思隅 @aervox/repositories — voice 表 DDL（自 schema/init.ts 机械拆分）
 */
import type { Client } from "@libsql/client";
import { addColumnIfMissing } from "./common.js";

export async function createVoiceTables(client: Client): Promise<void> {
  // CR-011 语音输出配置（系统核心能力 · 本地语音模型配置）：每租户多行（多预设，至多一行激活）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS voice_configs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '默认配置',
        is_active INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        provider_id TEXT NOT NULL,
        model_path TEXT,
        model_id TEXT NOT NULL,
        speaker_id TEXT,
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await addColumnIfMissing(client, "voice_configs", "name", "name TEXT NOT NULL DEFAULT '默认配置'");
  await addColumnIfMissing(client, "voice_configs", "is_active", "is_active INTEGER NOT NULL DEFAULT 1");
  await client.execute(`DROP INDEX IF EXISTS voice_configs_tenant_unique_idx;`);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS voice_configs_tenant_idx ON voice_configs(workspace_id, subject_user_id);
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS voice_configs_tenant_active_idx ON voice_configs(workspace_id, subject_user_id) WHERE is_active = 1;
    `);
  // CR-016 离线语音输入 (ASR) 配置持久化：每租户多行（多预设，至多一行激活）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS voice_input_configs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '默认配置',
        is_active INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        engine_type TEXT NOT NULL DEFAULT 'sensevoice-local',
        model_path TEXT,
        model_id TEXT NOT NULL DEFAULT 'sensevoice-small',
        endpoint TEXT,
        api_key TEXT,
        auto_stop_on_keyboard INTEGER NOT NULL DEFAULT 1,
        vad_silence_threshold_ms INTEGER NOT NULL DEFAULT 700,
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await addColumnIfMissing(client, "voice_input_configs", "name", "name TEXT NOT NULL DEFAULT '默认配置'");
  await addColumnIfMissing(client, "voice_input_configs", "is_active", "is_active INTEGER NOT NULL DEFAULT 1");
  await client.execute(`DROP INDEX IF EXISTS voice_input_configs_tenant_unique_idx;`);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS voice_input_configs_tenant_idx ON voice_input_configs(workspace_id, subject_user_id);
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS voice_input_configs_tenant_active_idx ON voice_input_configs(workspace_id, subject_user_id) WHERE is_active = 1;
    `);
  // CR-028 在线语音模型（GPT-SoVITS 远程 API）配置持久化：每租户多行（多预设，至多一行激活）
    await client.execute(`
      CREATE TABLE IF NOT EXISTS voice_remote_configs (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        subject_user_id TEXT NOT NULL,
        name TEXT NOT NULL DEFAULT '默认配置',
        is_active INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        provider_id TEXT NOT NULL DEFAULT 'gpt-sovits-remote',
        endpoint TEXT NOT NULL,
        api_key TEXT,
        model_id TEXT NOT NULL,
        speaker_id TEXT,
        text_lang TEXT,
        ref_audio_path TEXT,
        prompt_text TEXT,
        prompt_lang TEXT,
        aux_ref_audio_paths_json TEXT,
        speed_factor REAL,
        settings_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  await addColumnIfMissing(client, "voice_remote_configs", "name", "name TEXT NOT NULL DEFAULT '默认配置'");
  await addColumnIfMissing(client, "voice_remote_configs", "is_active", "is_active INTEGER NOT NULL DEFAULT 1");
  await client.execute(`DROP INDEX IF EXISTS voice_remote_configs_tenant_unique_idx;`);
  await client.execute(`
      CREATE INDEX IF NOT EXISTS voice_remote_configs_tenant_idx ON voice_remote_configs(workspace_id, subject_user_id);
    `);
  await client.execute(`
      CREATE UNIQUE INDEX IF NOT EXISTS voice_remote_configs_tenant_active_idx ON voice_remote_configs(workspace_id, subject_user_id) WHERE is_active = 1;
    `);
  // 9dbfecb 后补列：早期版本建的表缺 prompt_text/prompt_lang，幂等补齐
    await addColumnIfMissing(client, "voice_remote_configs", "prompt_text", "prompt_text TEXT");
  await addColumnIfMissing(client, "voice_remote_configs", "prompt_lang", "prompt_lang TEXT");
}
