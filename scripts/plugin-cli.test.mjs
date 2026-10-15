import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { unzipSync } from 'fflate';
import { initPlugin, checkPlugin, packPlugin } from './plugin-cli.mjs';

async function temporary(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aervox-plugin-author-'));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('init/check/pack produces a valid, reproducible runnable Page bundle', async () => temporary(async (root) => {
  const directory = path.join(root, 'example');
  await initPlugin(directory);
  const checked = await checkPlugin(directory);
  assert.deepEqual(checked.issues, []);
  assert.deepEqual(checked.permissions, ['config.read', 'config.write']);
  const a = await packPlugin(directory, path.join(root, 'a.aervox-plugin'));
  const b = await packPlugin(directory, path.join(root, 'b.aervox-plugin'));
  assert.equal(a.checksum, b.checksum);
  const unpacked = unzipSync(await fs.readFile(a.path));
  assert.ok(unpacked['pages/settings/app.js']);
  const elements = Object.fromEntries(['#message', '#save', '#status'].map((id) => [id, { disabled: true, addEventListener: (_event, fn) => { elements[id].handler = fn; } }]));
  const saved = [];
  const bridge = { ready: async () => ({}), getConfig: async () => ({ revision: 1, values: { message: 'Stored' } }), saveConfig: async (value) => { saved.push(value); return { revision: 2 }; } };
  const script = new TextDecoder().decode(unpacked['pages/settings/app.js']);
  vm.runInNewContext(script, { document: { querySelector: (id) => elements[id] }, window: { AervoxPluginPageBridge: bridge } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements['#message'].value, 'Stored');
  elements['#message'].value = 'Updated';
  await elements['#save'].handler();
  assert.equal(saved[0].values.message, 'Updated');
  assert.equal(elements['#status'].textContent, '已保存');
  await assert.rejects(initPlugin(directory), /EEXIST/);
  await assert.rejects(packPlugin(directory, a.path), /EEXIST/);
}));

test('check rejects incompatible hosts and pack never writes invalid bundles', async () => temporary(async (root) => {
  const directory = path.join(root, 'example'); await initPlugin(directory);
  assert.ok((await checkPlugin(directory, { hostVersion: '2.0.0' })).issues.some((issue) => issue.code === 'HOST_INCOMPATIBLE'));
  await fs.unlink(path.join(directory, 'pages/settings/index.html'));
  const target = path.join(root, 'bad.aervox-plugin');
  await assert.rejects(packPlugin(directory, target), /Missing or invalid entry/);
  await assert.rejects(fs.access(target));
}));

test('rejects unknown source files and symlinks while excluding trusted local development files', async () => temporary(async (root) => {
  const directory = path.join(root, 'example'); await initPlugin(directory);
  await fs.mkdir(path.join(directory, 'src'));
  await fs.writeFile(path.join(directory, 'src/server.ts'), 'throw new Error("must not execute");');
  assert.deepEqual((await checkPlugin(directory)).issues, []);
  await fs.writeFile(path.join(directory, 'execute.js'), 'throw 1');
  await assert.rejects(checkPlugin(directory), /Unknown bundle resource/);
  await fs.unlink(path.join(directory, 'execute.js'));
  await fs.symlink(path.join(directory, 'plugin.manifest.json'), path.join(directory, 'pages/settings/linked.json'));
  await assert.rejects(checkPlugin(directory), /Symbolic links/);
}));
