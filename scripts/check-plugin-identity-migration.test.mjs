import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import { migratePluginIdentities, recoverPluginIdentityMigration, migratePluginIdentityCluster, recoverPluginIdentityCluster } from './migrate-plugin-identities.mjs';
import { assertPluginIdentityMigrationReady, assertPluginIdentityMigrationUnlocked, assertPluginIdentityMigrationUnlockedForPath } from '../packages/repositories/src/migration/plugin-identities.ts';
import { createProactiveVaultCipher } from '../packages/repositories/src/proactive-vault-crypto.ts';

const oldId = 'focus-mode';
const nextId = 'ap-ui-focus-mode';
const generation = 'b393b3e2-c9a2-4e77-a27e-8ad1b452262b';
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function fixture(t, installed = false) {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'aervox-plugin-migrate-')));
  t.after(() => fs.rm(parent, { recursive: true, force: true }));
  const source = path.join(parent, 'data');
  await fs.mkdir(source);
  const options = { source, staging: path.join(parent, 'staging'), rollback: path.join(parent, 'rollback'), backup: path.join(parent, 'backup'), stopped: true, confirmPluginIdMigration: true };
  const file = path.join(source, 'main.sqlite');
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE plugins(id TEXT PRIMARY KEY, checksum TEXT NOT NULL, signature TEXT, bundle_generation TEXT, enabled INTEGER NOT NULL, lifecycle_generation TEXT);
    CREATE TABLE plugin_configs(id TEXT PRIMARY KEY, plugin_id TEXT UNIQUE, values_json TEXT, revision INTEGER);
    CREATE TABLE plugin_config_secrets(id TEXT PRIMARY KEY, plugin_id TEXT, value_json TEXT, configured INTEGER);
    CREATE TABLE plugin_grants(id TEXT PRIMARY KEY, plugin_id TEXT REFERENCES plugins(id), revoked_at TEXT, scope TEXT);
    CREATE TABLE tool_registrations(id TEXT PRIMARY KEY, plugin_id TEXT, enabled INTEGER);
    CREATE TABLE skill_registrations(id TEXT PRIMARY KEY, name TEXT, plugin_id TEXT, content_path TEXT, active INTEGER);
    CREATE TABLE bot_connections(id TEXT PRIMARY KEY, plugin_id TEXT, secret_cipher TEXT, revision INTEGER, enabled INTEGER);
    CREATE TABLE proactive_attention_budgets(id TEXT PRIMARY KEY, plugin_id TEXT, budget_units INTEGER, reserve_version INTEGER);
    CREATE TABLE proactive_trigger_rules(id TEXT PRIMARY KEY, plugin_id TEXT, enabled INTEGER, action_json TEXT);
    CREATE TABLE proactive_intervention_receipts(id TEXT PRIMARY KEY, plugin_id TEXT, idempotency_key TEXT, evidence_digest TEXT);
    CREATE TABLE recovery_control_ledger(event_id TEXT PRIMARY KEY, tamper_evidence TEXT, target_ref TEXT);
    CREATE TABLE tool_approvals(id TEXT PRIMARY KEY, tool_version TEXT, state TEXT);
    CREATE TABLE persona_config(id TEXT PRIMARY KEY, config_json TEXT);
  `);
  const manifest = { apiVersion: 'aervox.dev/v1', kind: 'PluginManifest', metadata: { id: oldId, displayName: 'Focus', publisher: 'aervox-official', version: '1.0.0' }, spec: {} };
  const content = { 'plugin.manifest.json': strToU8(JSON.stringify(manifest)), 'SKILL.md': strToU8('---\nname: focus-mode\ndescription: Focus\n---\nInstructions\n') };
  const archive = zipSync(content);
  db.prepare('INSERT INTO plugins VALUES (?,?,?,?,?,?)').run(oldId, installed ? 'sha256:' + sha(archive) : 'builtin', installed ? 'original-signature' : null, installed ? generation : null, 0, 'same-denied-generation');
  db.prepare('INSERT INTO plugin_configs VALUES (?,?,?,?)').run('config', oldId, '{"pluginId":"focus-mode","secretConfigured":true}', 7);
  db.prepare('INSERT INTO plugin_config_secrets VALUES (?,?,?,?)').run('secret', oldId, '"DO_NOT_PRINT_SECRET"', 1);
  db.prepare('INSERT INTO plugin_grants VALUES (?,?,?,?)').run('revoked', oldId, '2026-10-27T00:00:00Z', 'device:sensors');
  db.prepare('INSERT INTO plugin_grants VALUES (?,?,?,?)').run('active', oldId, null, 'learning:read');
  db.prepare('INSERT INTO tool_registrations VALUES (?,?,?)').run('focus-mode.my_tool', oldId, 0);
  const skillPath = installed ? path.join(source, 'plugins', oldId, 'releases', generation, 'skills', oldId, 'SKILL.md') : path.join(source, 'skills', oldId, oldId, 'SKILL.md');
  db.prepare('INSERT INTO skill_registrations VALUES (?,?,?,?,?)').run(oldId, oldId, oldId, skillPath, 0);
  db.prepare('INSERT INTO bot_connections VALUES (?,?,?,?,?)').run('connection', oldId, 'ciphertext-unmodified', 4, 0);
  db.prepare('INSERT INTO proactive_attention_budgets VALUES (?,?,?,?)').run('budget_plugin_focus-mode', oldId, 3, 22);
  db.prepare('INSERT INTO proactive_trigger_rules VALUES (?,?,?,?)').run('rule-immutable-id', oldId, 0, '{"pluginId":"focus-mode","toolId":"focus-mode.my_tool"}');
  db.prepare('INSERT INTO proactive_intervention_receipts VALUES (?,?,?,?)').run('receipt', oldId, 'original-idempotency', 'original-digest');
  db.prepare('INSERT INTO recovery_control_ledger VALUES (?,?,?)').run('deny', '{"signature":"unchanged"}', 'pseudonymous:focus-mode');
  db.prepare('INSERT INTO tool_approvals VALUES (?,?,?)').run('approval', 'signed-owner:focus-mode', 'denied');
  db.prepare('INSERT INTO persona_config VALUES (?,?)').run('persona', '{"displayName":"focus-mode"}');
  db.close();
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, content['SKILL.md']);
  if (installed) {
    const root = path.join(source, 'plugins', oldId, 'releases', generation);
    await fs.mkdir(path.join(root, 'content'));
    for (const [name, bytes] of Object.entries(content)) await fs.writeFile(path.join(root, 'content', name), bytes);
    await fs.writeFile(path.join(root, 'original.aervox-plugin'), archive);
    await fs.writeFile(path.join(root, 'owner.json'), JSON.stringify({ format: 1, pluginId: oldId, generation }));
  }
  return { options, file, archive };
}

function client(db) {
  return { execute: async input => ({ rows: typeof input === 'string' ? db.prepare(input).all() : db.prepare(input.sql).all(...input.args) }) };
}

test('explicit migration retains configs, secrets, revoked grants, disabled state and signed historical evidence', async t => {
  const { options, file } = await fixture(t);
  const original = await fs.readFile(file);
  const report = await migratePluginIdentities(options);
  assert.ok(!JSON.stringify(report).includes('DO_NOT_PRINT_SECRET'));
  assert.deepEqual(await fs.readFile(path.join(options.backup, 'main.sqlite')), original);
  assert.deepEqual(await fs.readFile(path.join(options.rollback, 'main.sqlite')), original);
  const db = new DatabaseSync(file);
  try {
    assert.deepEqual({ ...db.prepare('SELECT * FROM plugins').get() }, { id: nextId, checksum: 'builtin', signature: null, bundle_generation: null, enabled: 0, lifecycle_generation: 'same-denied-generation' });
    assert.equal(db.prepare('SELECT values_json FROM plugin_configs').get().values_json, '{"pluginId":"focus-mode","secretConfigured":true}');
    assert.equal(db.prepare('SELECT value_json FROM plugin_config_secrets').get().value_json, '"DO_NOT_PRINT_SECRET"');
    assert.equal(db.prepare("SELECT revoked_at FROM plugin_grants WHERE id='revoked'").get().revoked_at, '2026-10-27T00:00:00Z');
    assert.equal(db.prepare("SELECT revoked_at FROM plugin_grants WHERE id='active'").get().revoked_at, null);
    assert.deepEqual({ ...db.prepare('SELECT * FROM tool_registrations').get() }, { id: nextId + '.my_tool', plugin_id: nextId, enabled: 0 });
    assert.equal(db.prepare('SELECT reserve_version FROM proactive_attention_budgets').get().reserve_version, 22);
    assert.equal(db.prepare('SELECT evidence_digest FROM proactive_intervention_receipts').get().evidence_digest, 'original-digest');
    assert.equal(db.prepare('SELECT target_ref FROM recovery_control_ledger').get().target_ref, 'pseudonymous:focus-mode');
    assert.equal(db.prepare('SELECT tool_version FROM tool_approvals').get().tool_version, 'signed-owner:focus-mode');
    assert.equal(db.prepare('SELECT secret_cipher FROM bot_connections').get().secret_cipher, 'ciphertext-unmodified');
    const persona = JSON.parse(db.prepare('SELECT config_json FROM persona_config').get().config_json);
    assert.deepEqual(persona, { displayName: 'focus-mode' });
    assert.equal(db.prepare('SELECT plugin_id FROM proactive_intervention_receipts').get().plugin_id, oldId);
    const skill = db.prepare('SELECT * FROM skill_registrations').get();
    assert.equal(skill.id, nextId); assert.equal(skill.active, 0);
    assert.ok(await fs.readFile(skill.content_path));
    await assertPluginIdentityMigrationReady(client(db));
    await assertPluginIdentityMigrationUnlocked(options.source);
  } finally { db.close(); }
});

test('immutable bundle generations migrate archive, content, owner and checksum together; original ZIP is retained', async t => {
  const { options, file, archive } = await fixture(t, true);
  const report = await migratePluginIdentities(options);
  assert.equal(report.retiredSignatures, 1);
  const root = path.join(options.source, 'plugins', nextId, 'releases', generation);
  const packed = await fs.readFile(path.join(root, 'original.aervox-plugin'));
  const files = unzipSync(packed);
  assert.equal(JSON.parse(strFromU8(files['plugin.manifest.json'])).metadata.id, nextId);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, 'owner.json'), 'utf8')).pluginId, nextId);
  const db = new DatabaseSync(file);
  try {
    const plugin = db.prepare('SELECT * FROM plugins').get();
    assert.equal(plugin.checksum, 'sha256:' + sha(packed)); assert.equal(plugin.signature, null);
    assert.equal(plugin.bundle_generation, generation);
    const skill = db.prepare('SELECT * FROM skill_registrations').get();
    assert.match(await fs.readFile(skill.content_path, 'utf8'), /name: ap-ui-focus-mode/);
  } finally { db.close(); }
  assert.deepEqual(await fs.readFile(path.join(options.rollback, 'plugins', oldId, 'releases', generation, 'original.aervox-plugin')), Buffer.from(archive));
});

test('current persona references get a new revision while old revision and turn checksums remain unchanged', async t => {
  const { options, file } = await fixture(t);
  let db = new DatabaseSync(file);
  const config = JSON.stringify({ systemPromptAppend: 'focus-mode is a display label', allowedSkillNames: [oldId] });
  const checksum = sha(config);
  db.exec(`CREATE TABLE personas(id TEXT PRIMARY KEY,current_revision_id TEXT);
    CREATE TABLE persona_revisions(id TEXT PRIMARY KEY,persona_id TEXT,revision INTEGER,config TEXT,checksum TEXT,created_at TEXT);
    CREATE TABLE persona_selections(id TEXT PRIMARY KEY,revision_id TEXT);
    CREATE TABLE persona_turn_contexts(id TEXT PRIMARY KEY,revision_id TEXT,revision_checksum TEXT);`);
  db.prepare('INSERT INTO personas VALUES(?,?)').run('persona', 'oldrevision');
  db.prepare('INSERT INTO persona_revisions VALUES(?,?,?,?,?,?)').run('oldrevision', 'persona', 3, config, checksum, 'original-date');
  db.prepare('INSERT INTO persona_selections VALUES(?,?)').run('selection', 'oldrevision');
  db.prepare('INSERT INTO persona_turn_contexts VALUES(?,?,?)').run('turn', 'oldrevision', checksum);
  db.close();
  const report = await migratePluginIdentities(options);
  assert.equal(report.databases['main.sqlite'].newPersonaRevisions.length, 1);
  db = new DatabaseSync(file);
  try {
    const current = db.prepare('SELECT r.* FROM persona_revisions r JOIN personas p ON r.id=p.current_revision_id').get();
    assert.equal(current.revision, 4);
    assert.deepEqual(JSON.parse(current.config), { systemPromptAppend: 'focus-mode is a display label', allowedSkillNames: [nextId] });
    assert.equal(current.checksum, sha(current.config));
    assert.equal(db.prepare("SELECT checksum FROM persona_revisions WHERE id='oldrevision'").get().checksum, checksum);
    assert.equal(db.prepare('SELECT revision_id FROM persona_turn_contexts').get().revision_id, 'oldrevision');
    assert.equal(db.prepare('SELECT revision_checksum FROM persona_turn_contexts').get().revision_checksum, checksum);
    assert.equal(db.prepare('SELECT revision_id FROM persona_selections').get().revision_id, current.id);
  } finally { db.close(); }
});

test('mismatched installed archive pointer is refused before replacing the source', async t => {
  const { options, file } = await fixture(t, true);
  const db = new DatabaseSync(file);
  db.exec("UPDATE plugins SET checksum='sha256:not-the-current-package'"); db.close();
  const before = await fs.readFile(file);
  await assert.rejects(migratePluginIdentities(options), /checksum differs/);
  assert.deepEqual(await fs.readFile(file), before);
});

test('target identity collisions fail without changing the source and keep verified backup', async t => {
  const { options, file } = await fixture(t);
  const db = new DatabaseSync(file);
  db.prepare('INSERT INTO plugins VALUES (?,?,?,?,?,?)').run(nextId, 'target', null, null, 1, 'other'); db.close();
  const before = await fs.readFile(file);
  await assert.rejects(migratePluginIdentities(options), /both exist/);
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(await fs.readFile(path.join(options.backup, 'main.sqlite')), before);
  await assertPluginIdentityMigrationUnlocked(options.source);
});

test('new owner tables and external skill content fail closed', async t => {
  for (const kind of ['unknown', 'external']) await t.test(kind, async sub => {
    const { options, file } = await fixture(sub);
    const db = new DatabaseSync(file);
    if (kind === 'unknown') db.exec("CREATE TABLE future_plugin_state(id TEXT PRIMARY KEY, plugin_id TEXT); INSERT INTO future_plugin_state VALUES('x','focus-mode')");
    else db.exec("UPDATE skill_registrations SET content_path='/not-in-cluster/SKILL.md'");
    db.close();
    const before = await fs.readFile(file);
    await assert.rejects(migratePluginIdentities(options), kind === 'unknown' ? /Unreviewed plugin owner/ : /outside the declared cluster/);
    assert.deepEqual(await fs.readFile(file), before);
  });
});

test('ordinary failure after retaining the original rolls back the directory switch', async t => {
  const { options, file } = await fixture(t);
  const before = await fs.readFile(file);
  await assert.rejects(migratePluginIdentities({ ...options, onPhase: phase => { if (phase === 'source-retained') throw new Error('injected interruption'); } }), /injected interruption/);
  assert.deepEqual(await fs.readFile(file), before);
  await assertPluginIdentityMigrationUnlocked(options.source);
});

test('hard process interruption leaves startup locked and explicit recovery restores the retained original', async t => {
  const { options, file } = await fixture(t);
  const before = await fs.readFile(file);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {migratePluginIdentities} from ${JSON.stringify(new URL('./migrate-plugin-identities.mjs', import.meta.url).href)}; await migratePluginIdentities({...${JSON.stringify(options)},onPhase: phase=>{if(phase==='source-retained')process.exit(19)}});`], { stdio: 'pipe' });
  let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 19, stderr);
  await assert.rejects(assertPluginIdentityMigrationUnlocked(options.source), /MIGRATION_LOCKED/);
  await recoverPluginIdentityMigration(options);
  assert.deepEqual(await fs.readFile(file), before);
  await assertPluginIdentityMigrationUnlocked(options.source);
});

test('startup refuses detached old ownership even if the plugin row is absent', async t => {
  const { file } = await fixture(t);
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=OFF; DELETE FROM plugins');
    await assert.rejects(assertPluginIdentityMigrationReady(client(db)), /explicit offline/);
  } finally { db.close(); }
});

test('an open writer, symlink and hardlink cannot be used as a stopped cluster', async t => {
  for (const kind of ['writer', 'symlink', 'hardlink']) await t.test(kind, async sub => {
    const { options, file } = await fixture(sub);
    let db;
    if (kind === 'writer') { db = new DatabaseSync(file); db.exec('BEGIN IMMEDIATE'); }
    else if (kind === 'symlink') await fs.symlink(file, path.join(options.source, 'linked.db'));
    else await fs.link(file, path.join(options.source, 'linked.db'));
    try { await assert.rejects(migratePluginIdentities(options), /in use|link or special/); }
    finally { db?.close(); }
  });
});

test('no implicit database selection, overwrite, or unconfirmed mutation is permitted', async t => {
  const { options, file } = await fixture(t);
  const before = await fs.readFile(file);
  await assert.rejects(migratePluginIdentities({ ...options, stopped: false }), /Explicit/);
  await assert.rejects(migratePluginIdentities({ ...options, staging: options.source }), /distinct siblings/);
  await fs.mkdir(options.backup);
  await assert.rejects(migratePluginIdentities(options), /Destination already exists/);
  assert.deepEqual(await fs.readFile(file), before);
});

test('separate main and Vault roots migrate as one declared cluster and both keep rollback copies', async t => {
  const { options, file } = await fixture(t);
  const vault = path.join(path.dirname(options.source), 'external-vault');
  await fs.mkdir(vault);
  const db = new DatabaseSync(path.join(vault, 'vault.sqlite'));
  db.exec("CREATE TABLE proactive_trigger_rules(id TEXT PRIMARY KEY,plugin_id TEXT,enabled INTEGER,action_json TEXT); INSERT INTO proactive_trigger_rules VALUES('vault-rule','focus-mode',0,'{}')");
  db.prepare('UPDATE proactive_trigger_rules SET action_json=?').run(JSON.stringify({ allowedSkillNames: [oldId, 'anki-sync'] }));
  db.close();
  await fs.writeFile(path.join(vault, 'vault.key'), 'key-material-do-not-print');
  const original = await fs.readFile(file);
  const report = await migratePluginIdentityCluster({ ...options, includeDataRoots: [vault] });
  assert.equal(report.units.length, 2);
  assert.ok(!JSON.stringify(report).includes('key-material-do-not-print'));
  const opened = new DatabaseSync(path.join(vault, 'vault.sqlite'));
  try {
    const rule = opened.prepare('SELECT plugin_id, action_json FROM proactive_trigger_rules').get();
    assert.equal(rule.plugin_id, nextId);
    assert.deepEqual(JSON.parse(rule.action_json), { allowedSkillNames: [nextId, 'anki-sync'] });
  }
  finally { opened.close(); }
  assert.deepEqual(await fs.readFile(path.join(options.rollback, 'main.sqlite')), original);
  const vaultUnit = report.units.find(unit => unit.rollback.startsWith(vault));
  assert.equal(await fs.readFile(path.join(vaultUnit.rollback, 'vault.key'), 'utf8'), 'key-material-do-not-print');
  await assertPluginIdentityMigrationUnlockedForPath(path.join(vault, 'nested', 'vault.sqlite'));
});

test('a failure in an external root restores every already switched cluster unit', async t => {
  const { options, file } = await fixture(t);
  const vault = path.join(path.dirname(options.source), 'external-vault');
  await fs.mkdir(vault);
  const db = new DatabaseSync(path.join(vault, 'vault.sqlite'));
  db.exec("CREATE TABLE plugin_configs(id TEXT PRIMARY KEY,plugin_id TEXT,values_json TEXT); INSERT INTO plugin_configs VALUES('vault','focus-mode','{}')"); db.close();
  const before = await fs.readFile(file);
  const beforeVault = await fs.readFile(path.join(vault, 'vault.sqlite'));
  await assert.rejects(migratePluginIdentityCluster({ ...options, includeDataRoots: [vault],
    onPhase: async (phase, root) => {
      if (phase === 'switched' && root === vault) throw new Error('injected external switch failure');
    } }), /injected external switch failure/);
  assert.deepEqual(await fs.readFile(file), before);
  assert.deepEqual(await fs.readFile(path.join(vault, 'vault.sqlite')), beforeVault);
  await assertPluginIdentityMigrationUnlocked(options.source);
  await assertPluginIdentityMigrationUnlocked(vault);
});

test('crashing midway through a multi-root switch keeps all roots locked until group recovery', async t => {
  const { options, file } = await fixture(t);
  const vault = path.join(path.dirname(options.source), 'external-vault');
  await fs.mkdir(vault);
  const db = new DatabaseSync(path.join(vault, 'vault.sqlite'));
  db.exec("CREATE TABLE plugin_configs(id TEXT PRIMARY KEY,plugin_id TEXT,values_json TEXT); INSERT INTO plugin_configs VALUES('vault','focus-mode','{}')"); db.close();
  const before = await fs.readFile(file);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {migratePluginIdentityCluster} from ${JSON.stringify(new URL('./migrate-plugin-identities.mjs', import.meta.url).href)}; await migratePluginIdentityCluster({...${JSON.stringify(options)},includeDataRoots:[${JSON.stringify(vault)}],onPhase:(phase,root)=>{if(phase==='source-retained'&&root===${JSON.stringify(vault)})process.exit(23)}});`], { stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 23, stderr);
  await assert.rejects(assertPluginIdentityMigrationUnlockedForPath(path.join(vault, 'vault.sqlite')), /MIGRATION_LOCKED/);
  await assert.rejects(assertPluginIdentityMigrationUnlocked(options.source), /MIGRATION_LOCKED/);
  await recoverPluginIdentityCluster(options);
  assert.deepEqual(await fs.readFile(file), before);
  await assertPluginIdentityMigrationUnlocked(vault);
});

test('a stopped database with a durable uncheckpointed WAL is copied consistently', async t => {
  const { options, file } = await fixture(t);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(${JSON.stringify(file)});db.exec("PRAGMA journal_mode=WAL; UPDATE plugin_configs SET revision=19");process.exit(0);`], { stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 0, stderr);
  await migratePluginIdentities(options);
  const db = new DatabaseSync(file);
  try { assert.equal(db.prepare('SELECT revision FROM plugin_configs').get().revision, 19); }
  finally { db.close(); }
  const original = new DatabaseSync(path.join(options.rollback, 'main.sqlite'));
  try { assert.equal(original.prepare('SELECT revision FROM plugin_configs').get().revision, 19); }
  finally { original.close(); }
});

test('an existing foreign migration lock is never read, recovered or deleted on multi-root failure', async t => {
  const { options, file } = await fixture(t);
  const foreign = path.join(path.dirname(options.source), 'foreign-vault');
  await fs.mkdir(foreign);
  const marker = '{"owner":"another-invocation","private":"do-not-touch"}\n';
  await fs.writeFile(foreign + '.plugin-identities.lock', marker);
  const before = await fs.readFile(file);
  await assert.rejects(migratePluginIdentityCluster({ ...options, includeDataRoots: [foreign] }), /EEXIST/);
  assert.equal(await fs.readFile(foreign + '.plugin-identities.lock', 'utf8'), marker);
  assert.deepEqual(await fs.readFile(file), before);
  await assertPluginIdentityMigrationUnlocked(options.source);
});

test('crashing before a checkpoint rename leaves the previous journal intact and recoverable', async t => {
  const { options, file } = await fixture(t);
  const before = await fs.readFile(file);
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {migratePluginIdentities} from ${JSON.stringify(new URL('./migrate-plugin-identities.mjs', import.meta.url).href)}; await migratePluginIdentities({...${JSON.stringify(options)},onJournalPrepared:phase=>{if(phase==='source-retained')process.exit(31)}});`], { stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }), 31, stderr);
  const lock = JSON.parse(await fs.readFile(options.source + '.plugin-identities.lock', 'utf8'));
  const journal = JSON.parse(await fs.readFile(options.source + '.plugin-identities.lock.state', 'utf8'));
  assert.equal(lock.phase, 'locked');
  assert.equal(journal.phase, 'switching');
  assert.equal(lock.migrationId, journal.migrationId);
  await recoverPluginIdentityMigration(options);
  assert.deepEqual(await fs.readFile(file), before);
});

test('completed group can finish unlocking after a crash without rolling back a root already in use', async t => {
  const { options } = await fixture(t);
  const vault = path.join(path.dirname(options.source), 'vault');
  await fs.mkdir(vault);
  const db = new DatabaseSync(path.join(vault, 'vault.sqlite'));
  db.exec("CREATE TABLE plugin_configs(id TEXT PRIMARY KEY,plugin_id TEXT,revision INTEGER); INSERT INTO plugin_configs VALUES('vault','focus-mode',7)"); db.close();
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {migratePluginIdentityCluster} from ${JSON.stringify(new URL('./migrate-plugin-identities.mjs', import.meta.url).href)}; await migratePluginIdentityCluster({...${JSON.stringify(options)},includeDataRoots:[${JSON.stringify(vault)}],onGroupPhase:(phase,root)=>{if(phase==='unit-unlocked'&&root===${JSON.stringify(vault)})process.exit(37)}});`], { stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', bytes => { stderr += bytes; });
  assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); }), 37, stderr);
  await assertPluginIdentityMigrationUnlocked(vault);
  await assert.rejects(assertPluginIdentityMigrationUnlocked(options.source), /LOCKED/);
  const active = new DatabaseSync(path.join(vault, 'vault.sqlite'));
  active.exec('UPDATE plugin_configs SET revision=99'); active.close();
  const recovered = await recoverPluginIdentityCluster(options);
  assert.equal(recovered.completed, true);
  const read = new DatabaseSync(path.join(vault, 'vault.sqlite'));
  try {
    assert.equal(read.prepare('SELECT revision FROM plugin_configs').get().revision, 99);
    assert.equal(read.prepare('SELECT plugin_id FROM plugin_configs').get().plugin_id, nextId);
  } finally { read.close(); }
  await assertPluginIdentityMigrationUnlocked(options.source);
});

test('unknown JSON ownership references fail closed rather than silently acquiring new semantics', async t => {
  const { options, file } = await fixture(t);
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE future_state(id TEXT PRIMARY KEY,payload_json TEXT); INSERT INTO future_state VALUES('future','{\"pluginId\":\"focus-mode\"}')"); db.close();
  const before = await fs.readFile(file);
  await assert.rejects(migratePluginIdentities(options), /Unreviewed JSON identity references/);
  assert.deepEqual(await fs.readFile(file), before);
});

test('emitted plugin notification payloads remain historical snapshots in every delivery state', async t => {
  const { options, file } = await fixture(t);
  let db = new DatabaseSync(file);
  db.exec('CREATE TABLE notifications(id TEXT PRIMARY KEY,status TEXT,payload_json TEXT)');
  for (const status of ['scheduled', 'sent', 'dismissed']) {
    db.prepare('INSERT INTO notifications VALUES(?,?,?)').run(status, status, JSON.stringify({
      kind: 'plugin_dispatch', pluginId: oldId, ruleId: 'rule_profile_plugin_focus-mode_pulse',
      title: 'Take a break', triggerType: 'system_state', message: 'Time to stand up',
      source: 'plugin', occurredAt: '2026-10-28T12:00:00Z',
    }));
  }
  const original = db.prepare('SELECT * FROM notifications ORDER BY id').all();
  db.close();
  await migratePluginIdentities(options);
  db = new DatabaseSync(file);
  try {
    assert.deepEqual(db.prepare('SELECT * FROM notifications ORDER BY id').all(), original);
    assert.equal(db.prepare('SELECT id FROM plugins').get().id, nextId);
    await assertPluginIdentityMigrationReady(client(db));
  } finally { db.close(); }
});

test('skill references follow proven plugin ownership and preserve local, third-party and missing names', async t => {
  const { options, file } = await fixture(t);
  let db = new DatabaseSync(file);
  for (const [name, owner] of [['anki-sync', null], ['bot-onebot', 'third-party']]) {
    const contentPath = path.join(options.source, 'skills', ...(owner ? [owner, name] : [name]), 'SKILL.md');
    await fs.mkdir(path.dirname(contentPath), { recursive: true });
    await fs.writeFile(contentPath, `---\nname: ${name}\ndescription: Existing skill\n---\nRetain ownership\n`);
    db.prepare('INSERT INTO skill_registrations VALUES(?,?,?,?,?)').run(name, name, owner, contentPath, 1);
  }
  const configs = {
    mixed: { systemPromptAppend: 'Mixed skills', allowedSkillNames: [oldId, 'anki-sync', 'bot-onebot', 'home-assistant'] },
    local: { systemPromptAppend: 'Local skills', allowedSkillNames: ['anki-sync', 'bot-onebot', 'home-assistant'] },
  };
  db.exec(`CREATE TABLE personas(id TEXT PRIMARY KEY,current_revision_id TEXT);
    CREATE TABLE persona_revisions(id TEXT PRIMARY KEY,persona_id TEXT,revision INTEGER,config TEXT,checksum TEXT,created_at TEXT);
    CREATE TABLE persona_selections(id TEXT PRIMARY KEY,revision_id TEXT);
    ALTER TABLE tool_registrations ADD COLUMN gating_conditions_json TEXT;`);
  for (const [id, value] of Object.entries(configs)) {
    const config = JSON.stringify(value);
    db.prepare('INSERT INTO personas VALUES(?,?)').run(id, id);
    db.prepare('INSERT INTO persona_revisions VALUES(?,?,?,?,?,?)').run(id, id, 1, config, sha(config), 'original-date');
  }
  db.prepare('INSERT INTO persona_selections VALUES(?,?)').run('selection', 'local');
  db.prepare('UPDATE tool_registrations SET gating_conditions_json=?').run(JSON.stringify({
    allowedSkillNames: configs.mixed.allowedSkillNames, disabledSkillIds: [oldId, 'anki-sync'],
  }));
  db.close();
  const report = await migratePluginIdentities(options);
  db = new DatabaseSync(file);
  try {
    const config = id => JSON.parse(db.prepare('SELECT config FROM persona_revisions r JOIN personas p ON r.id=p.current_revision_id WHERE p.id=?').get(id).config);
    assert.deepEqual(config('mixed').allowedSkillNames, [nextId, 'anki-sync', 'bot-onebot', 'home-assistant']);
    assert.deepEqual(config('local'), configs.local);
    assert.equal(db.prepare("SELECT current_revision_id FROM personas WHERE id='local'").get().current_revision_id, 'local');
    assert.equal(db.prepare('SELECT revision_id FROM persona_selections').get().revision_id, 'local');
    assert.equal(report.databases['main.sqlite'].newPersonaRevisions.length, 1);
    assert.deepEqual(JSON.parse(db.prepare('SELECT gating_conditions_json FROM tool_registrations').get().gating_conditions_json), {
      allowedSkillNames: [nextId, 'anki-sync', 'bot-onebot', 'home-assistant'], disabledSkillIds: [nextId, 'anki-sync'],
    });
  } finally { db.close(); }
});

test('ambiguous skill names cannot transfer an existing selection to another owner', async t => {
  for (const name of [oldId, nextId]) await t.test(name, async t => {
    const { options, file } = await fixture(t);
    const contentPath = path.join(options.source, 'skills', 'local-notes', 'SKILL.md');
    await fs.mkdir(path.dirname(contentPath), { recursive: true });
    await fs.writeFile(contentPath, `---\nname: ${name}\ndescription: Local notes\n---\nUnrelated skill\n`);
    const db = new DatabaseSync(file);
    db.prepare('INSERT INTO skill_registrations VALUES(?,?,?,?,?)').run('local-notes', name, null, contentPath, 1);
    db.close();
    const before = await fs.readFile(file);
    await assert.rejects(migratePluginIdentities(options), /Ambiguous skill name migration/);
    assert.deepEqual(await fs.readFile(file), before);
    await assertPluginIdentityMigrationUnlocked(options.source);
  });
});

test('installed ZIP CRC mismatch is rejected before copying its content into a new identity', async t => {
  const { options, file, archive } = await fixture(t, true);
  const corrupt = Buffer.from(archive);
  const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  corrupt.writeUInt32LE((corrupt.readUInt32LE(central + 16) + 1) >>> 0, central + 16);
  await fs.writeFile(path.join(options.source, 'plugins', oldId, 'releases', generation, 'original.aervox-plugin'), corrupt);
  const db = new DatabaseSync(file);
  db.prepare('UPDATE plugins SET checksum=?').run('sha256:' + sha(corrupt)); db.close();
  const before = await fs.readFile(file);
  await assert.rejects(migratePluginIdentities(options), /checksum mismatch/);
  assert.deepEqual(await fs.readFile(file), before);
});

test('encrypted materialized rules retain cooldown under the new identity and old approved actions are revoked', async t => {
  const { options, file } = await fixture(t);
  const key = new Uint8Array(32).fill(23);
  const cipher = createProactiveVaultCipher(key, 'migration-test');
  const keyFile = path.join(options.source, 'proactive-vault.key');
  await fs.writeFile(keyFile, Buffer.from(key).toString('base64url'), { mode: 0o600 });
  const ruleId = 'rule_profile_plugin_focus-mode_pulse';
  const nextRuleId = 'rule_profile_plugin_ap-ui-focus-mode_pulse';
  let db = new DatabaseSync(file);
  db.exec('ALTER TABLE proactive_trigger_rules ADD COLUMN revision_id TEXT; ALTER TABLE proactive_trigger_rules ADD COLUMN name TEXT; ALTER TABLE proactive_trigger_rules ADD COLUMN condition_json TEXT; ALTER TABLE proactive_trigger_rules ADD COLUMN last_triggered_at TEXT');
  db.prepare('UPDATE proactive_trigger_rules SET id=?,revision_id=?,name=?,condition_json=?,action_json=?,last_triggered_at=?').run(
    ruleId, 'profile', cipher.encrypt('Rule title', `trigger-rule:${ruleId}`),
    cipher.encrypt('{"threshold":3}', `trigger-rule:${ruleId}`),
    cipher.encrypt('{"kind":"plugin_dispatch","pluginId":"focus-mode"}', `trigger-rule:${ruleId}`), '2026-10-28T12:00:00Z');
  db.exec('CREATE TABLE proactive_actions(id TEXT PRIMARY KEY,state TEXT,target TEXT,request_json TEXT,requested_by TEXT,error TEXT,finished_at TEXT,updated_at TEXT)');
  const target = cipher.encrypt(oldId, 'action:old-action');
  const request = cipher.encrypt('{"ruleId":"rule_profile_plugin_focus-mode_pulse"}', 'action:old-action');
  db.prepare('INSERT INTO proactive_actions VALUES(?,?,?,?,?,?,?,?)').run('old-action', 'approved', target, request, 'plugin:focus-mode', null, null, 'before');
  const executed = cipher.encrypt(oldId, 'action:executed');
  db.prepare('INSERT INTO proactive_actions VALUES(?,?,?,?,?,?,?,?)').run('executed', 'executed', executed, '{}', 'plugin:focus-mode', null, 'original', 'before');
  db.close();
  const report = await migratePluginIdentities({ ...options, vaultKeyFile: keyFile, vaultKeyId: 'migration-test' });
  assert.ok(!JSON.stringify(report).includes(Buffer.from(key).toString('base64url')));
  db = new DatabaseSync(file);
  try {
    const rule = db.prepare('SELECT * FROM proactive_trigger_rules').get();
    assert.equal(rule.id, nextRuleId);
    assert.equal(rule.last_triggered_at, '2026-10-28T12:00:00Z');
    assert.equal(rule.enabled, 0);
    assert.equal(cipher.decrypt(rule.name, `trigger-rule:${nextRuleId}`), 'Rule title');
    assert.deepEqual(JSON.parse(cipher.decrypt(rule.action_json, `trigger-rule:${nextRuleId}`)), { kind: 'plugin_dispatch', pluginId: nextId });
    assert.throws(() => cipher.decrypt(rule.name, `trigger-rule:${ruleId}`));
    const action = db.prepare("SELECT * FROM proactive_actions WHERE id='old-action'").get();
    assert.equal(action.state, 'revoked');
    assert.equal(action.target, target); assert.equal(action.request_json, request);
    assert.equal(cipher.decrypt(action.error, 'action:old-action'), 'Plugin identity changed; submit a new action under the new owner');
    assert.equal(db.prepare("SELECT target FROM proactive_actions WHERE id='executed'").get().target, executed);
    await assertPluginIdentityMigrationReady(client(db));
  } finally { db.close(); }
});

test('encrypted plugin ownership cannot silently pass migration without its explicitly selected key', async t => {
  const { options, file } = await fixture(t);
  const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(24));
  const db = new DatabaseSync(file);
  db.prepare('UPDATE proactive_trigger_rules SET action_json=?').run(cipher.encrypt('{"pluginId":"focus-mode"}', 'trigger-rule:rule-immutable-id'));
  db.close();
  const before = await fs.readFile(file);
  await assert.rejects(migratePluginIdentities(options), /explicit --vault-key-file/);
  assert.deepEqual(await fs.readFile(file), before);
  await assertPluginIdentityMigrationUnlocked(options.source);
});

test('identity migration preserves unrelated local skills and page asset names that resemble old plugin IDs', async t => {
  const { options, file, archive } = await fixture(t, true);
  const files = unzipSync(archive);
  const manifest = JSON.parse(strFromU8(files['plugin.manifest.json']));
  manifest.spec.pages = [{ id: oldId, title: 'Page', entry: `pages/${oldId}/index.html`, capabilities: [] }];
  files['plugin.manifest.json'] = strToU8(JSON.stringify(manifest));
  files[`pages/${oldId}/index.html`] = strToU8('<h1>Preserve this page identity</h1>');
  files[`skills/${oldId}/assets/${oldId}/note.txt`] = strToU8('ordinary asset name');
  const packed = zipSync(files);
  const root = path.join(options.source, 'plugins', oldId, 'releases', generation);
  for (const [name, bytes] of Object.entries(files)) {
    const target = path.join(root, 'content', name);
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, bytes);
  }
  await fs.writeFile(path.join(root, 'original.aervox-plugin'), packed);
  const localPath = path.join(options.source, 'skills', 'anki-sync', 'SKILL.md');
  const localContent = '---\nname: anki-sync\ndescription: Local notes\n---\nUnrelated local content';
  await fs.mkdir(path.dirname(localPath), { recursive: true }); await fs.writeFile(localPath, localContent);
  let db = new DatabaseSync(file);
  db.prepare('UPDATE plugins SET checksum=?').run('sha256:' + sha(packed));
  db.prepare('INSERT INTO skill_registrations VALUES(?,?,?,?,?)').run('anki-sync', 'anki-sync', null, localPath, 1); db.close();
  await migratePluginIdentities(options);
  assert.equal(await fs.readFile(localPath, 'utf8'), localContent);
  db = new DatabaseSync(file);
  try {
    assert.equal(db.prepare("SELECT content_path FROM skill_registrations WHERE id='anki-sync'").get().content_path, localPath);
    assert.equal(db.prepare("SELECT name FROM skill_registrations WHERE id='anki-sync'").get().name, 'anki-sync');
  } finally { db.close(); }
  const migratedArchive = unzipSync(await fs.readFile(path.join(options.source, 'plugins', nextId, 'releases', generation, 'original.aervox-plugin')));
  assert.ok(migratedArchive[`pages/${oldId}/index.html`]);
  assert.ok(migratedArchive[`skills/${nextId}/assets/${oldId}/note.txt`]);
  assert.equal(JSON.parse(strFromU8(migratedArchive['plugin.manifest.json'])).spec.pages[0].id, oldId);
});

test('recovery refuses an in-flight migration without releasing its startup lock', async t => {
  const { options } = await fixture(t);
  let observed = false;
  await migratePluginIdentities({ ...options, onPhase: async phase => {
    if (phase !== 'backed-up') return;
    await assert.rejects(recoverPluginIdentityMigration(options), /still running/);
    await assert.rejects(assertPluginIdentityMigrationUnlocked(options.source), /MIGRATION_LOCKED/);
    observed = true;
  } });
  assert.equal(observed, true);
});

test('recovery is idempotent after a completed migration and preserves later writes', async t => {
  const { options, file } = await fixture(t);
  await migratePluginIdentities(options);
  const db = new DatabaseSync(file);
  db.exec('UPDATE plugin_configs SET revision=99'); db.close();
  const bytes = await fs.readFile(file);
  const result = await recoverPluginIdentityMigration(options);
  assert.equal(result.completed, true); assert.equal(result.alreadyUnlocked, true);
  assert.deepEqual(await fs.readFile(file), bytes);
  await assertPluginIdentityMigrationUnlocked(options.source);
});
