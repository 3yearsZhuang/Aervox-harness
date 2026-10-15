import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDatabase, initDatabaseSchema, SqliteExtensionRepository } from '../src/index.js';

const entry = pathToFileURL(createRequire(import.meta.url).resolve('@aervox/repositories')).href;
describe('plugin installation crash recovery', () => {
  it.each(['during', 'after'])('keeps one complete version when a process exits %s the activation transaction', async (phase) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aervox-plugin-crash-'));
    const url = `file:${path.join(root, 'state.db')}`;
    let database = await createDatabase({url});
    try {
      await initDatabaseSchema(database.client);
      await new SqliteExtensionRepository(database.db).createPlugin({id: 'crash-example', publisher: 'example', version: '1.0.0', checksum: 'old'});
      database.client.close();
      const generation = '11111111-1111-4111-8111-111111111111';
      const stagedPath = path.join(root, generation, 'index.html');
      await fs.mkdir(path.dirname(stagedPath));
      await fs.writeFile(stagedPath, 'complete-new-page');
      const input = {
        plugin: {id: 'crash-example', publisher: 'example', version: '2.0.0', checksum: 'new'},
        generation, expectedGeneration: null, expectedChecksum: 'old', expectedConfigRevision: 0, expectedSchema: null,
        tools: [], skills: [], pages: [{pluginId: 'crash-example', pageId: 'main', title: 'Main', entry: stagedPath, capabilities: []}],
      };
      const script = `
        import {createDatabase, SqlitePluginInstallationRepository, SqlitePluginPageRepository} from ${JSON.stringify(entry)};
        const {db} = await createDatabase({url: process.argv[1]});
        if (process.argv[2] === 'during') SqlitePluginPageRepository.prototype.upsertPage = async () => process.exit(73);
        await new SqlitePluginInstallationRepository(db).activate(JSON.parse(process.argv[3]));
        process.exit(74);
      `;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, url, phase, JSON.stringify(input)], {encoding: 'utf8', timeout: 15000});
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(phase === 'during' ? 73 : 74);
      database = await createDatabase({url});
      const plugin = await new SqliteExtensionRepository(database.db).getPlugin('crash-example');
      expect(plugin?.version).toBe(phase === 'during' ? '1.0.0' : '2.0.0');
      expect(plugin?.bundleGeneration).toBe(phase === 'during' ? null : generation);
      const pages = await database.client.execute("SELECT entry FROM plugin_pages WHERE plugin_id = 'crash-example'");
      expect(pages.rows.length).toBe(phase === 'during' ? 0 : 1);
      if (phase === 'after') expect(await fs.readFile(String(pages.rows[0]!.entry), 'utf8')).toBe('complete-new-page');
    } finally {
      database.client.close();
      await fs.rm(root, {recursive: true, force: true});
    }
  });
});
