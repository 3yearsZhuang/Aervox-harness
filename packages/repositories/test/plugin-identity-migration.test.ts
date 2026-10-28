import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { buildPortableSchemaArtifact } from '../src/schema/portable-artifact.js';
import { inspectSchemaParity } from '../src/schema/manifest.js';
import { assertPluginIdentityMigrationReady } from '../src/migration/plugin-identities.js';

describe('offline plugin identity migration against the complete current schema', () => {
  it('retains relational state, notification history, skill ownership and schema metadata', async () => {
    const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aervox-plugin-schema-migration-')));
    const source = path.join(parent, 'data');
    await fs.mkdir(source);
    const filename = path.join(source, 'main.sqlite');
    const create = (file: string, scope: 'main' | 'ledger') => {
      const connection = new DatabaseSync(file);
      const artifact = buildPortableSchemaArtifact(scope);
      for (const sql of [...artifact.initialization.statements, ...artifact.projections.statements]) connection.exec(sql);
      connection.prepare(artifact.initialization.journal.sql).run({ ...artifact.initialization.journal.parameters, applied_at: '2026-10-29T00:00:00Z' });
      connection.exec('PRAGMA foreign_keys=ON');
      return connection;
    };
    const ledgerPath = path.join(source, 'ledger.sqlite');
    const ledger = create(ledgerPath, 'ledger');
    ledger.prepare('INSERT INTO recovery_control_ledger(event_id,idempotency_key,event_type,target_ref,occurred_at,sequence,tamper_evidence) VALUES(?,?,?,?,?,?,?)').run('deny', 'original-key', 'consent_revoke', 'focus-mode', '2026-10-27', 1, '{"chain":"unchanged"}');
    ledger.close();
    const ledgerBytes = await fs.readFile(ledgerPath);
    const database = create(filename, 'main');
    const client = (connection: DatabaseSync) => ({ execute: async (statement: string | { sql: string; args: unknown[] }) => ({ rows: typeof statement === 'string'
      ? connection.prepare(statement).all() : connection.prepare(statement.sql).all(...statement.args as any[]) }) }) as any;
    try {
      database.exec("INSERT INTO plugins(id,publisher,version,checksum,enabled,created_at,updated_at) VALUES('focus-mode','official','1.0.0','builtin',0,'2026-10-26','2026-10-26')");
      database.exec("INSERT INTO plugin_grants(id,plugin_id,permission,scope,granted_at,revoked_at,created_at,updated_at) VALUES('grant','focus-mode','learning.write','local','2026-10-26','2026-10-27','2026-10-26','2026-10-26')");
      database.exec("INSERT INTO plugin_config_secrets(id,plugin_id,field_key,value_json,configured,created_at,updated_at) VALUES('secret','focus-mode','token','\"opaque-secret\"',1,'2026-10-26','2026-10-26')");
      const notificationPayload = JSON.stringify({
        kind: 'plugin_dispatch', pluginId: 'focus-mode', ruleId: 'rule_profile_plugin_focus-mode_pulse',
        title: 'Take a break', triggerType: 'system_state', message: 'Time to stand up',
        source: 'plugin', occurredAt: '2026-10-28T12:00:00Z',
      });
      database.prepare('INSERT INTO notifications(id,type,scheduled_at,channel,status,payload_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run('notification', 'proactive.system_state', '2026-10-28T12:00:00Z', 'in_app', 'sent', notificationPayload, '2026-10-28', '2026-10-28');
      const notification = database.prepare("SELECT * FROM notifications WHERE id='notification'").get();
      for (const [name, owner] of [['focus-mode', 'focus-mode'], ['anki-sync', null]] as const) {
        const contentPath = path.join(source, 'skills', ...(owner ? [owner, name] : [name]), 'SKILL.md');
        await fs.mkdir(path.dirname(contentPath), { recursive: true });
        await fs.writeFile(contentPath, `---\nname: ${name}\ndescription: Existing skill\n---\nKeep my skill\n`);
        database.prepare('INSERT INTO skill_registrations(id,name,description,source,plugin_id,content_path,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
          .run(name, name, 'Existing skill', owner ? 'plugin' : 'local', owner, contentPath, '2026-10-26', '2026-10-26');
      }
      const localSkill = database.prepare("SELECT * FROM skill_registrations WHERE id='anki-sync'").get();
      for (const [id, skills] of [['mixed', ['focus-mode', 'anki-sync']], ['local', ['anki-sync']]] as const) {
        const config = JSON.stringify({ systemPromptAppend: 'Keep existing selections', allowedSkillNames: skills });
        database.prepare('INSERT INTO personas(id,name,current_revision_id,created_at,updated_at) VALUES(?,?,?,?,?)').run(id, id, id, '2026-10-26', '2026-10-26');
        database.prepare('INSERT INTO persona_revisions(id,persona_id,revision,config,checksum,created_at) VALUES(?,?,?,?,?,?)')
          .run(id, id, 1, config, createHash('sha256').update(config).digest('hex'), '2026-10-26');
      }
      database.prepare('INSERT INTO persona_selections(id,persona_id,revision_id,selected_at,created_at,updated_at) VALUES(?,?,?,?,?,?)')
        .run('selection', 'local', 'local', '2026-10-26', '2026-10-26', '2026-10-26');
      await expect(assertPluginIdentityMigrationReady(client(database))).rejects.toMatchObject({ code: 'PLUGIN_IDENTITY_MIGRATION_REQUIRED' });
      if (database.isOpen) database.close();
      // The CLI entry is tested as a module to keep all mutation confined to this temporary cluster.
      const { migratePluginIdentities } = await import('../../../scripts/migrate-plugin-identities.mjs');
      await migratePluginIdentities({ source, staging: path.join(parent, 'stage'), rollback: path.join(parent, 'rollback'), backup: path.join(parent, 'backup'), stopped: true, confirmPluginIdMigration: true });
      const migrated = new DatabaseSync(filename);
      try {
        expect(migrated.prepare("SELECT enabled FROM plugins WHERE id='ap-ui-focus-mode'").get()?.enabled).toBe(0);
        expect(migrated.prepare("SELECT plugin_id,revoked_at FROM plugin_grants WHERE id='grant'").get()).toMatchObject({ plugin_id: 'ap-ui-focus-mode', revoked_at: '2026-10-27' });
        expect(migrated.prepare("SELECT value_json FROM plugin_config_secrets WHERE id='secret'").get()?.value_json).toBe('"opaque-secret"');
        expect(migrated.prepare("SELECT * FROM notifications WHERE id='notification'").get()).toEqual(notification);
        expect(migrated.prepare("SELECT * FROM skill_registrations WHERE id='anki-sync'").get()).toEqual(localSkill);
        const selectedConfig = (id: string) => JSON.parse(String(migrated.prepare('SELECT config FROM persona_revisions r JOIN personas p ON r.id=p.current_revision_id WHERE p.id=?').get(id)?.config));
        expect(selectedConfig('mixed').allowedSkillNames).toEqual(['ap-ui-focus-mode', 'anki-sync']);
        expect(selectedConfig('local').allowedSkillNames).toEqual(['anki-sync']);
        expect(migrated.prepare("SELECT revision_id FROM persona_selections WHERE id='selection'").get()?.revision_id).toBe('local');
        expect(migrated.prepare("SELECT current_revision_id FROM personas WHERE id='local'").get()?.current_revision_id).toBe('local');
        expect(migrated.prepare('SELECT count(*) AS n FROM persona_revisions').get()?.n).toBe(3);
        expect(migrated.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(migrated.prepare('PRAGMA integrity_check').get()?.integrity_check).toBe('ok');
        await expect(assertPluginIdentityMigrationReady(client(migrated))).resolves.toBeUndefined();
        expect(await inspectSchemaParity(client(migrated), 'main')).toEqual([]);
        expect(await fs.readFile(ledgerPath)).toEqual(ledgerBytes);
        expect(migrated.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='index'").get()?.n).toBeGreaterThan(100);
      } finally { migrated.close(); }
    } finally {
      if (database.isOpen) database.close();
      await fs.rm(parent, { recursive: true, force: true });
    }
  });
});
