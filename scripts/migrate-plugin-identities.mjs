/** Explicit, offline identity migration. Nothing calls this from normal startup. */
import fs from 'node:fs/promises';
import { createReadStream, readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import * as zlib from 'node:zlib';
import { zipSync, strToU8, strFromU8 } from 'fflate';
import { boundedUnpack } from '../packages/host-runtime/src/shared/archive-codec.ts';
import { PLUGIN_IDENTITY_MIGRATIONS } from '../packages/repositories/src/migration/plugin-identities.ts';
import { comparePluginVersions } from '../packages/contracts/src/plugin-compatibility.ts';
import { createProactiveVaultCipher } from '../packages/repositories/src/proactive-vault-crypto.ts';

const run = promisify(execFile);
const q = value => '"' + value.replaceAll('"', '""') + '"';
const mappings = Object.entries(PLUGIN_IDENTITY_MIGRATIONS);
const activeMigrations = new Set();
const OWNER_TABLES = new Set(['plugin_configs', 'plugin_config_secrets', 'plugin_pages', 'plugin_grants',
  'tool_registrations', 'skill_registrations', 'bot_connections', 'proactive_trigger_rules',
  'proactive_attention_budgets']);
// Append-only execution/audit/deny evidence keeps its original, signed identity. It never becomes
// a valid approval for the new owner. The migration manifest links the two identities for review.
const HISTORICAL_TABLES = new Set(['recovery_control_ledger', 'audit_records', 'audit_logs', 'tool_executions',
  'tool_approvals', 'turns', 'turn_attempts', 'turn_events', 'turn_context_manifests', 'proactive_trigger_events',
  'persona_revisions', 'persona_turn_contexts', 'persona_switch_logs', 'proactive_intervention_receipts', 'proactive_budget_feedback_events']);
const JSON_REFERENCE_COLUMNS = new Set(['proactive_trigger_rules.action_json', 'proactive_trigger_rules.condition_json',
  'plugins.proactive_spec_json', 'tool_registrations.gating_conditions_json', 'skill_registrations.gating_conditions_json']);
const JSON_REFERENCE_KEYS = new Set(['pluginId', 'plugin_id', 'ownerPluginId', 'pluginIds', 'enabledPluginIds',
  'disabledPluginIds', 'allowedPluginIds', 'allowedSkills', 'allowedSkillNames', 'disabledSkillIds', 'skillName', 'skillId', 'toolId', 'disabledToolIds']);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const safeRelative = name => name && name.length <= 512 && !name.includes('\\') && !name.includes('\0')
  && !name.startsWith('/') && !/^[A-Za-z]:/.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..');
const has = async filename => fs.lstat(filename).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
const movedIdentity = value => {
  if (typeof value !== 'string') return value;
  for (const [oldId, nextId] of mappings) {
    if (value === oldId) return nextId;
    if (value.startsWith(oldId + '.') || value.startsWith(oldId + ':')) return nextId + value.slice(oldId.length);
  }
  return value;
};
const movedSkillSegment = value => movedIdentity(value.replaceAll('%3A', ':')).replaceAll(':', '%3A');

function ownedSkillPath(value, pluginId, roots) {
  const absolute = path.resolve(value);
  const unit = roots.find(root => absolute.startsWith(root.source + path.sep));
  if (!unit) throw new Error('Skill content is outside the declared cluster');
  const parts = path.relative(unit.source, absolute).split(path.sep);
  const next = [...parts];
  if (parts.length === 4 && parts[0] === 'skills' && parts[1] === pluginId) {
    next[1] = movedIdentity(pluginId); next[2] = movedSkillSegment(parts[2]);
  } else if (parts.length === 7 && parts[0] === 'plugins' && parts[1] === pluginId && parts[2] === 'releases' && parts[4] === 'skills') {
    next[1] = movedIdentity(pluginId); next[5] = movedSkillSegment(parts[5]);
  } else throw new Error('Unreviewed plugin skill storage layout');
  if (parts.at(-1).toLowerCase() !== 'skill.md') throw new Error('Unreviewed plugin skill content file');
  return { unit, parts, next, source: path.join(unit.source, ...next), stage: path.join(unit.staging, ...next) };
}

function rewriteReferenceJson(value, context = '') {
  if (typeof value === 'string') return JSON_REFERENCE_KEYS.has(context) ? movedIdentity(value) : value;
  if (Array.isArray(value)) return value.map(entry => rewriteReferenceJson(entry, context));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewriteReferenceJson(entry, key)]));
}

async function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  for await (const bytes of createReadStream(filename)) hash.update(bytes);
  return hash.digest('hex');
}

/** Reject links/special files: the cluster must have no references outside its declared boundary. */
async function inventory(root, relative = '') {
  const files = [];
  for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = path.join(relative, entry.name);
    const absolute = path.join(root, rel);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) {
      throw new Error('Cluster contains a link or special file: ' + rel);
    }
    if (stat.isDirectory()) files.push(...await inventory(root, rel));
    else files.push({ path: rel, size: stat.size, mode: stat.mode & 0o777, sha256: await hashFile(absolute) });
  }
  return files;
}

async function checkNoOpenFiles(root) {
  try {
    const { stdout } = await run('lsof', ['-F', 'p', '+D', root], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    if (stdout.trim()) throw new Error('Cluster is in use; stop all API, Worker, desktop and database processes');
  } catch (error) {
    if (error.stdout?.trim()) throw new Error('Cluster is in use; stop all API, Worker, desktop and database processes');
    if (error.code === 1 && !error.stdout?.trim()) return;
    if (error.code === 'ENOENT') throw new Error('lsof is required to verify the stopped cluster');
    throw error;
  }
}

async function sqliteFiles(root, files) {
  const result = [];
  for (const file of files) {
    const handle = await fs.open(path.join(root, file.path), 'r');
    const header = Buffer.alloc(16);
    try { await handle.read(header, 0, 16, 0); } finally { await handle.close(); }
    if (header.equals(Buffer.from('SQLite format 3\0'))) result.push(file.path);
    else if (/\.(?:db|sqlite|sqlite3)$/i.test(file.path)) throw new Error('Unknown or encrypted database format: ' + file.path);
  }
  return result;
}

function dbTables(db) {
  return db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
}

function dbSnapshot(db) {
  const counts = {};
  for (const table of dbTables(db)) counts[table.name] = db.prepare(`SELECT count(*) AS n FROM ${q(table.name)}`).get().n;
  return counts;
}

function transformRow(table, row, roots, resourceChecksums, vaultCipher) {
  const next = { ...row };
  if (HISTORICAL_TABLES.has(table)) return next;
  if (table === 'proactive_actions') {
    // Existing approval is evidence for the old owner, never approval for its replacement.
    if (!['pending', 'approved', 'running'].includes(row.state)) return next;
    const decode = value => {
      if (typeof value !== 'string' || !value.startsWith('avxenc:v1:')) return value;
      if (!vaultCipher) throw new Error('Encrypted active actions require an explicit --vault-key-file inside the selected data roots');
      return vaultCipher.decrypt(value, `action:${row.id}`);
    };
    const target = decode(row.target);
    const request = decode(row.request_json);
    let hasLegacyReference = typeof target === 'string' && movedIdentity(target) !== target;
    if (typeof request === 'string') {
      let parsed;
      try { parsed = JSON.parse(request); } catch { throw new Error('Invalid active action request document'); }
      hasLegacyReference ||= JSON.stringify(parsed) !== JSON.stringify(rewriteReferenceJson(parsed));
    }
    hasLegacyReference ||= typeof row.requested_by === 'string' && mappings.some(([oldId]) => row.requested_by === `plugin:${oldId}`);
    if (hasLegacyReference) {
      next.state = 'revoked';
      const now = new Date().toISOString();
      if ('updated_at' in row) next.updated_at = now;
      if ('finished_at' in row) next.finished_at = now;
      if ('error' in row) {
        const reason = 'Plugin identity changed; submit a new action under the new owner';
        next.error = vaultCipher ? vaultCipher.encrypt(reason, `action:${row.id}`) : reason;
      }
    }
    return next;
  }
  if ('plugin_id' in row && mappings.some(([oldId]) => row.plugin_id === oldId)) {
    if (!OWNER_TABLES.has(table)) throw new Error('Unreviewed plugin owner table: ' + table);
    next.plugin_id = movedIdentity(row.plugin_id);
  }
  if (table === 'plugins') {
    next.id = movedIdentity(row.id);
    const archive = resourceChecksums.get(row.id + '/' + row.bundle_generation);
    if (row.bundle_generation && next.id !== row.id && !archive) throw new Error('Installed generation is missing or unverified');
    if (archive) {
      if (row.checksum !== archive.before && row.checksum !== 'sha256:' + archive.before) throw new Error('Installed archive checksum differs from its database pointer');
      next.checksum = 'sha256:' + archive.after; next.signature = null;
    }
  }
  if (table === 'tool_registrations' && next.plugin_id !== row.plugin_id) next.id = movedIdentity(row.id);
  if (table === 'skill_registrations' && next.plugin_id !== row.plugin_id) {
    next.id = movedIdentity(row.id); next.name = movedIdentity(row.name);
  }
  if (table === 'proactive_attention_budgets' && next.plugin_id !== row.plugin_id && row.id === 'budget_plugin_' + row.plugin_id) {
    next.id = 'budget_plugin_' + next.plugin_id;
  }
  if (table === 'proactive_trigger_rules' && next.plugin_id !== row.plugin_id) {
    const prefix = `rule_${row.revision_id}_plugin_${row.plugin_id}_`;
    if (typeof row.revision_id === 'string' && row.id.startsWith(prefix)) {
      next.id = `rule_${row.revision_id}_plugin_${next.plugin_id}_${row.id.slice(prefix.length)}`;
    }
    for (const column of ['name', 'condition_json', 'action_json']) {
      const original = row[column];
      if (typeof original !== 'string') continue;
      const encrypted = original.startsWith('avxenc:v1:');
      if (encrypted && !vaultCipher) throw new Error('Encrypted plugin rules require an explicit --vault-key-file inside the selected data roots');
      let plaintext = encrypted ? vaultCipher.decrypt(original, `trigger-rule:${row.id}`) : original;
      if (column !== 'name') {
        let parsed;
        try { parsed = JSON.parse(plaintext); } catch { throw new Error('Invalid plugin trigger rule document'); }
        plaintext = JSON.stringify(rewriteReferenceJson(parsed));
      }
      next[column] = encrypted ? vaultCipher.encrypt(plaintext, `trigger-rule:${next.id}`) : plaintext;
    }
  }
  for (const [column, value] of Object.entries(row)) {
    if (typeof value !== 'string') continue;
    if (table === 'proactive_trigger_rules' && next.plugin_id !== row.plugin_id && ['name', 'condition_json', 'action_json'].includes(column)) continue;
    if (column === 'content_path' && table === 'skill_registrations') {
      const absolute = path.resolve(value);
      const unit = roots.find(root => absolute.startsWith(root.source + path.sep));
      if (!unit) throw new Error('Skill content is outside the declared cluster');
      const { source: sourceRoot, staging: stageRoot } = unit;
      const relative = path.relative(sourceRoot, absolute);
      if (!relative || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Skill content is outside the declared cluster');
      if (next.plugin_id !== row.plugin_id) {
        const selected = ownedSkillPath(value, row.plugin_id, roots);
        next[column] = selected.source;
        const bytes = readFileSync(selected.stage);
        if ('checksum' in row) next.checksum = digest(bytes);
      } else if (!readFileSync(path.join(stageRoot, relative))) throw new Error('Missing selected skill content');
    } else if ((column.endsWith('_json') || column === 'permissions') && table !== 'plugin_config_secrets' && table !== 'plugin_configs') {
      let parsed;
      try { parsed = JSON.parse(value); } catch { continue; }
      const rewritten = rewriteReferenceJson(parsed);
      if (JSON.stringify(parsed) !== JSON.stringify(rewritten)) {
        if (!JSON_REFERENCE_COLUMNS.has(table + '.' + column)) throw new Error('Unreviewed JSON identity references: ' + table + '.' + column);
        next[column] = JSON.stringify(rewritten);
      }
    }
  }
  return next;
}

/** Mutates staging only. FK checks and unchanged row counts are mandatory after all updates. */
function migrateDatabase(filename, roots, resourceChecksums, options) {
  let vaultCipher;
  if (options.vaultKeyFile) {
    const keyPath = options.vaultKeyFile;
    if (!path.isAbsolute(keyPath) || path.resolve(keyPath) !== keyPath) throw new Error('Vault key path must be an explicit normalized absolute path');
    const owner = roots.find(root => keyPath.startsWith(root.source + path.sep));
    if (!owner) throw new Error('Vault key must be inside an explicitly selected data root');
    const encoded = readFileSync(path.join(owner.staging, path.relative(owner.source, keyPath)), 'utf8').trim();
    vaultCipher = createProactiveVaultCipher(Buffer.from(encoded, 'base64url'), options.vaultKeyId ?? 'local-v1');
  }
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA foreign_keys=OFF; PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    const tables = dbTables(db);
    const before = dbSnapshot(db);
    const changes = {};
    for (const table of tables) {
      const info = db.prepare(`PRAGMA table_info(${q(table.name)})`).all();
      if (/CREATE\s+VIRTUAL\s+TABLE/i.test(table.sql ?? '')) continue;
      const primary = info.filter(column => column.pk).sort((a, b) => a.pk - b.pk).map(column => column.name);
      const keys = primary.length ? primary : ['__migration_rowid'];
      const columns = info.map(column => column.name);
      if (table.name === 'plugins') {
        const ids = new Set(db.prepare('SELECT id FROM plugins').all().map(row => row.id));
        for (const [oldId, newId] of mappings) if (ids.has(oldId) && ids.has(newId)) throw new Error('Source and target plugin identities both exist');
      }
      const query = db.prepare(`SELECT ${primary.length ? '' : 'rowid AS __migration_rowid,'}* FROM ${q(table.name)}`);
      query.setReadBigInts(true);
      for (const row of query.all()) {
        const next = transformRow(table.name, row, roots, resourceChecksums, vaultCipher);
        const changed = columns.filter(column => !Object.is(row[column], next[column]));
        if (!changed.length) continue;
        const update = db.prepare(`UPDATE ${q(table.name)} SET ${changed.map(column => q(column) + '=?').join(',')} WHERE ${keys.map(column => (column === '__migration_rowid' ? 'rowid' : q(column)) + ' IS ?').join(' AND ')}`);
        update.run(...changed.map(column => next[column]), ...keys.map(column => row[column]));
        changes[table.name] = (changes[table.name] ?? 0) + 1;
      }
    }
    const personaRevisions = migratePersonaRevisions(db, new Set(tables.map(table => table.name)));
    const expected = { ...before };
    if (personaRevisions.length) expected.persona_revisions += personaRevisions.length;
    const after = dbSnapshot(db);
    if (JSON.stringify(expected) !== JSON.stringify(after)) throw new Error('Migration changed unexpected table row counts');
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Staging has unresolved foreign keys');
    if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Staging integrity check failed');
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA foreign_keys=ON');
    return { rows: before, changedRows: changes, newPersonaRevisions: personaRevisions };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* staging is discarded, never the source */ }
    throw error;
  } finally { db.close(); }
}

/** Preserve immutable revisions and turn evidence; only live selection pointers move to new revisions. */
function migratePersonaRevisions(db, tables) {
  if (!tables.has('persona_revisions')) return [];
  if (!tables.has('personas') || !tables.has('persona_selections')) throw new Error('Incomplete persona revision schema');
  const targets = new Set([
    ...db.prepare('SELECT current_revision_id AS id FROM personas').all().map(row => row.id),
    ...db.prepare('SELECT revision_id AS id FROM persona_selections').all().map(row => row.id),
  ]);
  const changes = [];
  const columns = db.prepare('PRAGMA table_info(persona_revisions)').all().map(column => column.name);
  for (const id of targets) {
    const row = db.prepare('SELECT * FROM persona_revisions WHERE id=?').get(id);
    if (!row) throw new Error('Missing selected persona revision');
    const config = JSON.parse(row.config);
    const next = rewriteReferenceJson(config);
    if (JSON.stringify(config) === JSON.stringify(next)) continue;
    if (digest(JSON.stringify(config)) !== row.checksum) throw new Error('Selected persona revision checksum mismatch');
    const revision = db.prepare('SELECT MAX(revision) AS n FROM persona_revisions WHERE persona_id=?').get(row.persona_id).n + 1;
    const newId = 'personarev_' + crypto.randomUUID();
    const record = { ...row, id: newId, revision, config: JSON.stringify(next), checksum: digest(JSON.stringify(next)), created_at: new Date().toISOString() };
    db.prepare(`INSERT INTO persona_revisions(${columns.map(q).join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => record[column]));
    db.prepare('UPDATE personas SET current_revision_id=? WHERE current_revision_id=?').run(newId, id);
    db.prepare('UPDATE persona_selections SET revision_id=? WHERE revision_id=?').run(newId, id);
    changes.push({ previous: id, current: newId, revision });
  }
  return changes;
}

function updateSkillMarkdown(bytes) {
  const text = strFromU8(bytes);
  return strToU8(text.replace(/^---\r?\n([\s\S]*?)\r?\n---/, (match, frontmatter) =>
    match.replace(frontmatter, frontmatter.replace(/^(name:\s*)([\w.:-]+)(\s*)$/m, (_entry, begin, name, end) => begin + movedIdentity(name) + end))));
}

function rewrittenBundle(files, oldId, newId) {
  const keys = Object.keys(files);
  if (keys.length > 2048 || keys.some(name => !safeRelative(name))) throw new Error('Unsafe installed archive');
  let total = 0;
  for (const bytes of Object.values(files)) {
    if (bytes.length > 5 * 1024 * 1024) throw new Error('Installed archive entry exceeds quota');
    total += bytes.length;
  }
  if (total > 50 * 1024 * 1024) throw new Error('Installed archive expansion exceeds quota');
  const manifestName = files['plugin.manifest.json'] ? 'plugin.manifest.json' : 'manifest.json';
  const manifest = JSON.parse(strFromU8(files[manifestName] ?? new Uint8Array()));
  if (manifest.metadata?.id !== oldId) throw new Error('Installed archive identity does not match its owner');
  manifest.metadata.id = newId;
  manifest.metadata.category ??= newId.split('-')[1];
  const range = manifest.requires?.hostApiVersion ?? { min: '1.0.0', maxExclusive: '2.0.0' };
  if (comparePluginVersions(range.min, '1.1.0') === -1) range.min = '1.1.0';
  if (range.maxExclusive && comparePluginVersions(range.min, range.maxExclusive) !== -1) throw new Error('Installed bundle host range cannot admit the migrated protocol');
  manifest.requires = { ...manifest.requires, hostApiVersion: range };
  const moveResourcePath = entry => entry.startsWith('skills/')
    ? entry.split('/').map((part, index) => index === 1 ? movedSkillSegment(part) : part).join('/') : entry;
  for (const skill of manifest.spec?.skills ?? []) {
    if (skill.name) skill.name = movedIdentity(skill.name);
    if (skill.entry) skill.entry = moveResourcePath(skill.entry);
  }
  if (typeof manifest.spec?.skill === 'string') manifest.spec.skill = moveResourcePath(manifest.spec.skill);
  const next = Object.fromEntries(Object.entries(files).map(([name, bytes]) => [moveResourcePath(name), bytes]));
  if (Object.keys(next).length !== keys.length) throw new Error('Migrated bundle resource collision');
  next[manifestName] = strToU8(JSON.stringify(manifest, null, 2) + '\n');
  for (const name of keys) if ((name.startsWith('skills/') || /^(?:skill\.md)$/i.test(name)) && /(?:^|\/)SKILL\.md$/i.test(name)) next[moveResourcePath(name)] = updateSkillMarkdown(files[name]);
  return next;
}

async function migrateResources(stage, validatePluginBundleFiles, registeredSkills, roots) {
  const checksums = new Map();
  const pluginsRoot = path.join(stage, 'plugins');
  for (const [oldId, newId] of mappings) {
    const directory = path.join(pluginsRoot, oldId);
    if (!await has(directory)) continue;
    if (await has(path.join(pluginsRoot, newId))) throw new Error('Both plugin resource identities exist');
    const releases = path.join(directory, 'releases');
    if (await has(releases)) {
      for (const generation of await fs.readdir(releases)) {
        if (!/^[a-f0-9-]{36}$/.test(generation)) throw new Error('Unrecognized installed generation directory');
        const root = path.join(releases, generation);
        const owner = JSON.parse(await fs.readFile(path.join(root, 'owner.json'), 'utf8'));
        if (owner.format !== 1 || owner.pluginId !== oldId || owner.generation !== generation) throw new Error('Installed generation owner mismatch');
        const bytes = await fs.readFile(path.join(root, 'original.aervox-plugin'));
        if (bytes.length > 20 * 1024 * 1024) throw new Error('Installed archive exceeds quota');
        const unpacked = boundedUnpack(bytes, { expandedBytes: 50 * 1024 * 1024, entryBytes: 5 * 1024 * 1024, entries: 2048 }, raw => {
          const directoryEntry = raw.endsWith('/');
          if (!safeRelative(directoryEntry ? raw.slice(0, -1) : raw)) throw new Error('Unsafe installed archive entry');
          return raw;
        }, zlib);
        const files = Object.fromEntries(Object.entries(unpacked).filter(([name]) => !name.endsWith('/')));
        const originalCheck = validatePluginBundleFiles(files);
        if (originalCheck.issues.length) throw new Error('Original installed archive is invalid');
        const content = path.join(root, 'content');
        const originalFiles = await inventory(content);
        if (originalFiles.length !== Object.keys(files).length) throw new Error('Installed content does not match original archive');
        for (const file of originalFiles) if (!files[file.path.split(path.sep).join('/')] || file.sha256 !== digest(files[file.path.split(path.sep).join('/')])) {
          throw new Error('Installed content differs from original archive');
        }
        const next = rewrittenBundle(files, oldId, newId);
        if (validatePluginBundleFiles(next).issues.length) throw new Error('Migrated installed archive is invalid');
        for (const name of Object.keys(files)) if (!(name in next)) await fs.unlink(path.join(content, ...name.split('/')));
        for (const [name, data] of Object.entries(next)) {
          const target = path.join(content, ...name.split('/'));
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, data);
        }
        const packed = zipSync(Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)).map(([name, data]) => [name, [data, { mtime: new Date(1980, 0, 1) }]])), { level: 9 });
        if (packed.byteLength > 20 * 1024 * 1024) throw new Error('Migrated installed archive exceeds compressed quota');
        await fs.writeFile(path.join(root, 'original.aervox-plugin'), packed);
        await fs.writeFile(path.join(root, 'owner.json'), JSON.stringify({ ...owner, pluginId: newId }) + '\n');
        checksums.set(oldId + '/' + generation, { before: digest(bytes), after: digest(packed) });
      }
    }
    await fs.rename(directory, path.join(pluginsRoot, newId));
  }
  // Only database-proven plugin ownership can rename a Skill. Local skills and nested assets
  // can coincidentally share an old plugin name, and must retain their names and bytes.
  const selections = registeredSkills.map(row => ownedSkillPath(row.content_path, row.plugin_id, roots))
    .filter(selected => selected.unit.staging === stage);
  const movedOwners = new Set();
  for (const selected of selections) {
    const { unit, parts, next } = selected;
    if (parts[0] === 'skills') {
      const owner = path.join(unit.staging, 'skills', parts[1]);
      const targetOwner = path.join(unit.staging, 'skills', next[1]);
      if (!movedOwners.has(owner)) {
        if (await has(targetOwner)) throw new Error('Conflicting skill resource identities');
        await fs.rename(owner, targetOwner); movedOwners.add(owner);
      }
    }
    const original = [...next];
    original[parts[0] === 'skills' ? 2 : 5] = parts[parts[0] === 'skills' ? 2 : 5];
    const before = path.dirname(path.join(unit.staging, ...original));
    const after = path.dirname(selected.stage);
    if (before !== after && await has(before)) {
      if (await has(after)) throw new Error('Conflicting skill resource identities');
      await fs.rename(before, after);
    }
    await fs.writeFile(selected.stage, updateSkillMarkdown(await fs.readFile(selected.stage)));
  }
  return checksums;
}

async function registeredPluginSkills(roots, databaseFiles) {
  const rows = [];
  const paths = new Set();
  for (const root of roots) {
    for (const file of databaseFiles.get(root.source) ?? []) {
      const db = new DatabaseSync(path.join(root.staging, file), { readOnly: true });
      try {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_registrations'").get()) continue;
        for (const row of db.prepare('SELECT id, name, plugin_id, content_path FROM skill_registrations').all()) {
          if (!Object.hasOwn(PLUGIN_IDENTITY_MIGRATIONS, row.plugin_id)) continue;
          if (!row.content_path) throw new Error('Plugin skill has no explicit content path');
          if (paths.has(row.content_path)) throw new Error('Plugin skill content has duplicate database ownership');
          paths.add(row.content_path); rows.push(row);
        }
      } finally { db.close(); }
    }
  }
  return rows;
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectoryTree(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncDirectoryTree(path.join(directory, entry.name));
  }
  await syncDirectory(directory);
}

async function writeAtomic(filename, value, prepared) {
  const temporary = filename + '.tmp-' + crypto.randomUUID();
  const handle = await fs.open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await prepared?.(value.phase, filename);
  await fs.rename(temporary, filename);
  await syncDirectory(path.dirname(filename));
}

async function readMigrationState(source) {
  const lock = source + '.plugin-identities.lock';
  const stat = await fs.lstat(lock);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Invalid recovery manifest');
  const initial = JSON.parse(await fs.readFile(lock, 'utf8'));
  let current = initial;
  if (await has(lock + '.state')) {
    const journalStat = await fs.lstat(lock + '.state');
    if (!journalStat.isFile() || journalStat.isSymbolicLink() || journalStat.nlink !== 1) throw new Error('Invalid recovery journal');
    current = JSON.parse(await fs.readFile(lock + '.state', 'utf8'));
    if (current.migrationId !== initial.migrationId || current.source !== initial.source || current.coordinator !== initial.coordinator) throw new Error('Recovery journal ownership mismatch');
  }
  return current;
}

async function releaseOwnedLock(source, migrationId) {
  const current = await readMigrationState(source);
  if (current.migrationId !== migrationId) throw new Error('Refusing to release another migration lock');
  const lock = source + '.plugin-identities.lock';
  await fs.unlink(lock);
  await syncDirectory(path.dirname(source));
  // The complete journal must outlive the lock. A crash may leave harmless journal data,
  // but can never leave an active startup lock whose recovery state was already removed.
  if (await has(lock + '.state')) await fs.unlink(lock + '.state');
  await syncDirectory(path.dirname(source));
}

function requireStoppedMigration(state) {
  if (activeMigrations.has(state.migrationId)) throw new Error('Migration is still running; wait for it to stop before recovery');
  if (!Number.isSafeInteger(state.ownerPid) || state.ownerPid <= 0 || state.ownerPid === process.pid) return;
  try { process.kill(state.ownerPid, 0); }
  catch (error) { if (error.code === 'ESRCH') return; throw error; }
  throw new Error('Migration process is still running; stop it before recovery');
}

async function durableCopy(source, target) {
  await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  for (const file of await inventory(target)) {
    const handle = await fs.open(path.join(target, file.path), 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }
  await syncDirectoryTree(target);
}

/** Operates only on an explicitly stopped, self-contained directory; never discovers user data. */
export async function migratePluginIdentities(options) {
  if (!options.stopped || !options.confirmPluginIdMigration) throw new Error('Explicit --stopped and --confirm-plugin-id-migration are required');
  const { source, staging, rollback, backup } = options;
  for (const value of [source, staging, rollback, backup]) if (!value || !path.isAbsolute(value) || path.resolve(value) !== value) throw new Error('All paths must be explicit normalized absolute paths');
  const parent = path.dirname(source);
  if ([staging, rollback, backup].some(value => path.dirname(value) !== parent || value === source) || new Set([source, staging, rollback, backup]).size !== 4) {
    throw new Error('Source, staging, rollback and backup must be distinct siblings on one filesystem');
  }
  if ((await fs.realpath(parent)) !== parent || (await fs.lstat(source)).isSymbolicLink()) throw new Error('Cluster parents cannot contain symbolic links');
  if (!(await fs.lstat(source)).isDirectory()) throw new Error('Source cluster must be a directory');
  for (const target of [staging, rollback, backup]) if (await has(target)) throw new Error('Destination already exists');
  const lock = source + '.plugin-identities.lock';
  const lockHandle = await fs.open(lock, 'wx', 0o600);
  const roots = options.clusterUnits ?? [{ source, staging, rollback, backup }];
  const migrationId = options.migrationId ?? crypto.randomUUID();
  const state = { format: 1, migrationId, ownerPid: process.pid, coordinator: options.coordinator, phase: 'locked', source, staging, rollback, backup, clusterUnits: roots, mapping: PLUGIN_IDENTITY_MIGRATIONS };
  await lockHandle.writeFile(JSON.stringify(state, null, 2) + '\n'); await lockHandle.sync();
  await syncDirectory(parent);
  options.onLockAcquired?.(source);
  const checkpoint = async phase => {
    state.phase = phase;
    await writeAtomic(lock + '.state', state, options.onJournalPrepared);
    await options.onPhase?.(phase);
  };
  const sourceDatabases = [];
  let switched = false;
  let retainLock = false;
  activeMigrations.add(migrationId);
  try {
    await checkpoint('locked');
    await checkNoOpenFiles(source);
    const initial = await inventory(source);
    const databases = await sqliteFiles(source, initial);
    options.databaseCounts?.set(source, databases.length);
    const databaseFiles = options.databaseFiles ?? new Map();
    databaseFiles.set(source, databases);
    if (!databases.length && !options.clusterUnits) throw new Error('No SQLite databases found in the declared cluster');
    for (const file of databases) {
      const connection = new DatabaseSync(path.join(source, file), { readOnly: true });
      sourceDatabases.push(connection);
      connection.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE');
    }
    const frozen = await inventory(source);
    state.sourceDigest = digest(JSON.stringify(frozen));
    await durableCopy(source, backup);
    if (JSON.stringify(await inventory(backup)) !== JSON.stringify(frozen)) throw new Error('Backup verification failed');
    await checkpoint('backed-up');
    await durableCopy(backup, staging);
    await checkpoint('staging-prepared');
    const { validatePluginBundleFiles } = await import('../packages/contracts/dist/plugin-validation.js');
    const localChecksums = await migrateResources(staging, validatePluginBundleFiles, await registeredPluginSkills(roots, databaseFiles), roots);
    const checksums = options.resourceChecksums ?? localChecksums;
    if (options.resourceChecksums) for (const [key, value] of localChecksums) {
      if (checksums.has(key)) throw new Error('Duplicate installed generation ownership across data roots');
      checksums.set(key, value);
    }
    await checkpoint('resources-prepared');
    const report = { format: 1, migrationId, mapping: PLUGIN_IDENTITY_MIGRATIONS, sourceDigest: digest(JSON.stringify(frozen)), databases: {}, retiredSignatures: checksums.size };
    for (const file of databases) report.databases[file] = migrateDatabase(path.join(staging, file), roots, checksums, options);
    await checkpoint('validated');
    // Source handles keep SQLite write locks through the directory swap; the sibling lock is
    // checked by every new host before opening a database. A crash keeps the recovery state.
    if (JSON.stringify(await inventory(source)) !== JSON.stringify(frozen)) throw new Error('Source changed after backup');
    const reportFile = path.join(staging, 'plugin-identity-migration.json');
    if (await has(reportFile)) throw new Error('Cluster already has an identity migration manifest');
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    for (const file of await inventory(staging)) {
      const handle = await fs.open(path.join(staging, file.path), 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }
    await syncDirectoryTree(staging);
    state.stagingDigest = digest(JSON.stringify(await inventory(staging)));
    await checkpoint('switching');
    await fs.rename(source, rollback);
    await checkpoint('source-retained');
    await fs.rename(staging, source); switched = true;
    await checkpoint('switched');
    for (const db of sourceDatabases.splice(0)) db.close();
    await checkpoint('complete');
    return { ...report, backup, rollback, source };
  } catch (error) {
    for (const db of sourceDatabases.splice(0)) db.close();
    try {
      if (await has(rollback)) {
        if (switched) await fs.rename(source, staging);
        await fs.rename(rollback, source);
      }
      await checkpoint('rolled-back');
    } catch {
      retainLock = true;
      throw new Error('Migration interrupted; keep all hosts stopped and recover using the sibling lock manifest', { cause: error });
    }
    throw error;
  } finally {
    activeMigrations.delete(migrationId);
    for (const db of sourceDatabases) db.close();
    await lockHandle.close();
    if (!retainLock && !options.retainLock) await releaseOwnedLock(source, migrationId);
  }
}

/** Crash recovery only restores the retained original; it never replays a partially run migration. */
export async function recoverPluginIdentityMigration(options) {
  if (!options.stopped || !options.confirmPluginIdMigration || !path.isAbsolute(options.source ?? '')) throw new Error('Recovery requires the stopped cluster and explicit confirmation');
  const source = path.resolve(options.source);
  const lock = source + '.plugin-identities.lock';
  if (!await has(lock)) {
    const reportFile = path.join(source, 'plugin-identity-migration.json');
    const journalFile = lock + '.state';
    if (await has(journalFile)) {
      const journal = JSON.parse(await fs.readFile(journalFile, 'utf8'));
      if (journal.source !== source || !['complete', 'rolled-back'].includes(journal.phase)) throw new Error('Unowned recovery journal cannot be removed');
      requireStoppedMigration(journal);
      if (journal.phase === 'complete') {
        const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
        if (report.migrationId !== journal.migrationId) throw new Error('Completed migration marker mismatch');
      } else if (digest(JSON.stringify(await inventory(source))) !== journal.sourceDigest) throw new Error('Recovered original changed');
      if (!options.dryRun) { await fs.unlink(journalFile); await syncDirectory(path.dirname(source)); }
      return { recovered: true, completed: journal.phase === 'complete', source, alreadyUnlocked: true };
    }
    const report = JSON.parse(await fs.readFile(reportFile, 'utf8'));
    if (report.format !== 1 || !report.migrationId || JSON.stringify(report.mapping) !== JSON.stringify(PLUGIN_IDENTITY_MIGRATIONS)) throw new Error('No matching completed identity migration');
    return { recovered: true, completed: true, source, alreadyUnlocked: true };
  }
  const state = await readMigrationState(source);
  requireStoppedMigration(state);
  if (options.migrationId && options.migrationId !== state.migrationId) throw new Error('Recovery lock belongs to another migration');
  if (state.format !== 1 || state.source !== source || [state.staging, state.rollback, state.backup].some(value => typeof value !== 'string' || path.dirname(value) !== path.dirname(source))
      || new Set([source, state.staging, state.rollback, state.backup]).size !== 4) throw new Error('Invalid recovery boundaries');
  for (const directory of [source, state.rollback, state.staging].filter(Boolean)) if (await has(directory)) {
    if ((await fs.lstat(directory)).isSymbolicLink()) throw new Error('Linked recovery directory');
    await checkNoOpenFiles(directory);
  }
  if (await has(state.rollback)) {
    if (digest(JSON.stringify(await inventory(state.rollback))) !== state.sourceDigest) throw new Error('Retained original changed; automatic recovery refused');
    if (await has(source)) {
      if (await has(state.staging)) throw new Error('Staging collision; preserve both clusters for manual recovery');
      if (digest(JSON.stringify(await inventory(source))) !== state.stagingDigest) throw new Error('New cluster changed; automatic recovery refused');
      if (!options.dryRun) await fs.rename(source, state.staging);
    }
    if (!options.dryRun) await fs.rename(state.rollback, source);
  } else if (!await has(source) || (state.sourceDigest && digest(JSON.stringify(await inventory(source))) !== state.sourceDigest)) {
    throw new Error('Original cluster is missing or changed; keep the migration lock');
  }
  if (options.dryRun) return { recoverable: true, source };
  await syncDirectory(path.dirname(source));
  if (!options.keepLock) await releaseOwnedLock(source, state.migrationId);
  await syncDirectory(path.dirname(source));
  return { recovered: true, source, backup: state.backup, retainedStaging: state.staging };
}

/** Multiple explicitly selected roots form one stopped cluster, including an external Vault. */
export async function migratePluginIdentityCluster(options) {
  if (!options.stopped || !options.confirmPluginIdMigration) throw new Error('Explicit --stopped and --confirm-plugin-id-migration are required');
  const includes = options.includeDataRoots ?? [];
  if (!includes.length) return migratePluginIdentities(options);
  const migrationId = crypto.randomUUID();
  const suffix = '.plugin-identities-' + migrationId;
  const units = [{ source: options.source, staging: options.staging, rollback: options.rollback, backup: options.backup },
    ...includes.map(source => ({ source, staging: source + suffix + '.staging', rollback: source + suffix + '.rollback', backup: source + suffix + '.backup' }))];
  for (const unit of units) {
    if (!unit.source || !path.isAbsolute(unit.source) || path.resolve(unit.source) !== unit.source) throw new Error('Included data roots must be normalized absolute paths');
    for (const other of units) if (unit !== other && (unit.source === other.source || unit.source.startsWith(other.source + path.sep))) throw new Error('Data roots must be disjoint and cannot contain one another');
  }
  const coordinator = options.source + '.plugin-identities.group.json';
  const group = { format: 1, migrationId, ownerPid: process.pid, phase: 'running', units };
  const initial = await fs.open(coordinator, 'wx', 0o600);
  try { await initial.writeFile(JSON.stringify(group, null, 2) + '\n'); await initial.sync(); }
  finally { await initial.close(); }
  await syncDirectory(path.dirname(coordinator));
  const owned = new Set();
  let abort;
  let failed;
  const failure = new Promise((_resolve, reject) => { abort = error => { if (!failed) { failed = error; reject(error); } }; });
  failure.catch(() => {});
  const barriers = new Map();
  const databaseCounts = new Map();
  const databaseFiles = new Map();
  function barrier(name) {
    let entry = barriers.get(name);
    if (!entry) {
      entry = { count: 0 };
      entry.promise = new Promise(resolve => { entry.resolve = resolve; });
      barriers.set(name, entry);
    }
    if (++entry.count === units.length) {
      if (name === 'switching' && ![...databaseCounts.values()].some(count => count > 0)) abort(new Error('No SQLite database found in the declared cluster'));
      else entry.resolve();
    }
    return Promise.race([entry.promise, failure]);
  }
  const resourceChecksums = new Map();
  const results = await Promise.allSettled(units.map(async unit => {
    try {
      return await migratePluginIdentities({ ...options, ...unit, clusterUnits: units, retainLock: true, resourceChecksums, databaseCounts, databaseFiles, migrationId, coordinator,
        onLockAcquired: source => owned.add(source),
        onPhase: async phase => {
          await options.onPhase?.(phase, unit.source);
          if (phase === 'staging-prepared' || phase === 'resources-prepared' || phase === 'switching') await barrier(phase);
        } });
    } catch (error) { abort(error); throw error; }
  }));
  if (results.some(result => result.status === 'rejected')) {
    try {
      // Never inspect, recover or unlink a lock this invocation did not acquire.
      const lockedUnits = units.filter(unit => owned.has(unit.source));
      for (const unit of lockedUnits) await recoverPluginIdentityMigration({ ...options, ...unit, migrationId, dryRun: true });
      for (const unit of lockedUnits) await recoverPluginIdentityMigration({ ...options, ...unit, migrationId, keepLock: true });
      group.phase = 'rolled-back';
      group.ownedRoots = [...owned];
      await writeAtomic(coordinator, group);
      for (const unit of lockedUnits) await releaseOwnedLock(unit.source, migrationId);
    } catch (error) { throw new Error('Cluster recovery requires attention; keep all roots stopped and recover from the group manifest', { cause: error }); }
    throw failed;
  }
  const reports = results.map(result => result.value);
  // The durable group completion is written before any unit can be unlocked. Recovery after
  // a crash during unlock finishes releasing this group, rather than rolling back an active root.
  group.phase = 'complete';
  group.reports = reports;
  await writeAtomic(coordinator, group);
  await options.onGroupPhase?.('complete');
  for (const unit of [...units].reverse()) {
    await releaseOwnedLock(unit.source, migrationId);
    await options.onGroupPhase?.('unit-unlocked', unit.source);
  }
  return { format: 1, migrationId, units: reports, mapping: PLUGIN_IDENTITY_MIGRATIONS };
}

export async function recoverPluginIdentityCluster(options) {
  const source = path.resolve(options.source ?? '');
  let state;
  if (await has(source + '.plugin-identities.lock')) state = await readMigrationState(source);
  if (!state?.coordinator && !await has(source + '.plugin-identities.group.json')) return recoverPluginIdentityMigration(options);
  const coordinator = state?.coordinator ?? source + '.plugin-identities.group.json';
  const stat = await fs.lstat(coordinator);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Invalid cluster coordinator');
  const group = JSON.parse(await fs.readFile(coordinator, 'utf8'));
  requireStoppedMigration(group);
  const units = group.units;
  if (group.format !== 1 || !Array.isArray(units) || !units.length || !units.some(unit => unit.source === source)
      || coordinator !== units[0].source + '.plugin-identities.group.json' || (state && state.migrationId !== group.migrationId)) throw new Error('Invalid cluster recovery manifest');
  if (!options.stopped || !options.confirmPluginIdMigration) throw new Error('Recovery requires the stopped cluster and explicit confirmation');
  const locks = [];
  for (const unit of units) {
    if (!await has(unit.source + '.plugin-identities.lock')) continue;
    const local = await readMigrationState(unit.source);
    // Foreign pre-existing locks can exist if acquisition failed. They are never part of recovery.
    if (local.migrationId !== group.migrationId) continue;
    if (local.coordinator !== coordinator || JSON.stringify(local.clusterUnits) !== JSON.stringify(units)) throw new Error('Cluster recovery manifests disagree');
    locks.push(unit);
  }
  if (group.phase === 'complete') {
    // Completed, already-unlocked units may have received legitimate writes. Their signed-off
    // migration marker suffices; never compare a live database to its pre-unlock bytes.
    for (const unit of units) {
      const report = JSON.parse(await fs.readFile(path.join(unit.source, 'plugin-identity-migration.json'), 'utf8'));
      if (report.migrationId !== group.migrationId) throw new Error('Completed root migration marker mismatch');
    }
  } else {
    for (const unit of locks) await recoverPluginIdentityMigration({ ...options, source: unit.source, migrationId: group.migrationId, dryRun: true });
    for (const unit of locks) await recoverPluginIdentityMigration({ ...options, source: unit.source, migrationId: group.migrationId, keepLock: true });
    group.phase = 'rolled-back';
    await writeAtomic(coordinator, group);
  }
  for (const unit of locks) await releaseOwnedLock(unit.source, group.migrationId);
  return { recovered: true, completed: group.phase === 'complete', roots: units.map(unit => unit.source) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--stopped') options.stopped = true;
    else if (argument === '--confirm-plugin-id-migration') options.confirmPluginIdMigration = true;
    else if (argument === '--recover') options.recover = true;
    else if (argument === '--include-data-root') (options.includeDataRoots ??= []).push(args[++index]);
    else if (argument === '--vault-key-file') options.vaultKeyFile = args[++index];
    else if (argument === '--vault-key-id') options.vaultKeyId = args[++index];
    else if (['--source', '--staging', '--rollback', '--backup'].includes(argument)) options[argument.slice(2)] = args[++index];
    else throw new Error('Unknown migration argument');
  }
  (options.recover ? recoverPluginIdentityCluster(options) : migratePluginIdentityCluster(options)).then(report => console.log(JSON.stringify(report, null, 2))).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
