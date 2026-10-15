#!/usr/bin/env node
/** Declarative plugin authoring tools. Run through mise/pnpm from the repository root. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import { classifyDistEntry } from './export-plugins.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ENTRIES = 2048;
const MAX_ENTRY_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const REPRODUCIBLE_MTIME = new Date(1980, 0, 1, 0, 0, 0);

async function validation() {
  try { return await import('../packages/contracts/dist/plugin-validation.js'); }
  catch (error) { throw new Error('Build shared contracts first: mise exec -- pnpm --filter @aervox/contracts build', { cause: error }); }
}

export async function readPluginDirectory(directory) {
  const files = Object.create(null);
  let total = 0;
  let count = 0;
  async function walk(relative = '') {
    const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not accepted: ${name}`);
      const role = classifyDistEntry(name, entry.isDirectory());
      if (role === 'local') continue;
      if (role !== 'dist') throw new Error(`Unknown bundle resource: ${name}`);
      if (++count > MAX_ENTRIES) throw new Error('Plugin exceeds entry quota');
      if (entry.isDirectory()) await walk(name);
      else {
        const absolute = path.join(directory, name);
        const stat = await fs.stat(absolute);
        if (!stat.isFile() || stat.size > MAX_ENTRY_BYTES || total + stat.size > MAX_TOTAL_BYTES) throw new Error(`Plugin exceeds resource quota: ${name}`);
        const bytes = new Uint8Array(await fs.readFile(absolute));
        total += bytes.length;
        if (bytes.length > MAX_ENTRY_BYTES || total > MAX_TOTAL_BYTES) throw new Error(`Plugin exceeds resource quota: ${name}`);
        files[name] = bytes;
      }
    }
  }
  await walk();
  return files;
}

export async function checkPlugin(directory, options = {}) {
  const files = await readPluginDirectory(directory);
  const { validatePluginBundleFiles } = await validation();
  const result = validatePluginBundleFiles(files, options);
  return { ...result, files };
}

export async function packPlugin(directory, output, options = {}) {
  const result = await checkPlugin(directory, options);
  if (result.issues.length) throw new Error(result.issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n'));
  const manifest = result.manifest;
  const archive = {};
  for (const name of Object.keys(result.files).sort()) archive[name] = [result.files[name], { mtime: REPRODUCIBLE_MTIME }];
  const bytes = zipSync(archive, { level: 9 });
  if (bytes.length > 20 * 1024 * 1024) throw new Error('Packed plugin exceeds compressed quota');
  const target = output ?? path.join(directory, '..', `${manifest.metadata.id}-${manifest.metadata.version.replace(/[^A-Za-z0-9.+_-]/g, '_')}.aervox-plugin`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, { flag: 'wx' });
  return { path: path.resolve(target), checksum: createHash('sha256').update(bytes).digest('hex'), permissions: result.permissions };
}

export async function initPlugin(directory, id = path.basename(path.resolve(directory))) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('Plugin id must use lowercase letters, numbers and hyphens');
  // mkdir is exclusive at the root: never overwrite an existing project.
  await fs.mkdir(directory);
  await fs.mkdir(path.join(directory, 'pages', 'settings'), { recursive: true });
  const manifest = {
    apiVersion: 'aervox.dev/v1', kind: 'PluginManifest',
    metadata: { id, displayName: id, publisher: 'local-author', version: '1.0.0', license: 'UNLICENSED' },
    requires: { hostApiVersion: { min: '1.0.0', maxExclusive: '2.0.0' } },
    spec: { config: { schemaVersion: 1, entry: 'config.schema.json' }, pages: [{ id: 'settings', title: '设置', entry: 'pages/settings/index.html', capabilities: ['config.read', 'config.write'] }] },
  };
  const config = { apiVersion: 'aervox.dev/v1', kind: 'PluginConfigSchema', schemaVersion: 1, fields: [{ key: 'message', type: 'string', label: '消息', default: '你好', validation: { maxLength: 500 } }] };
  const html = '<!doctype html>\n<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>插件设置</title>\n<body><label>消息 <input id="message" maxlength="500" disabled></label><button id="save" disabled>保存</button><p id="status" role="status">等待宿主连接</p><script src="/v1/plugin-pages/bridge.js"></script><script src="app.js"></script></body></html>\n';
  const script = `const message = document.querySelector('#message');
const save = document.querySelector('#save');
const status = document.querySelector('#status');
async function load() {
  await window.AervoxPluginPageBridge.ready();
  const snapshot = await window.AervoxPluginPageBridge.getConfig();
  message.value = snapshot.values.message ?? '';
  message.disabled = save.disabled = false;
  status.textContent = '可以编辑';
}
save.addEventListener('click', async () => {
  save.disabled = true;
  try {
    await window.AervoxPluginPageBridge.saveConfig({ values: { message: message.value } });
    status.textContent = '已保存';
  } catch (error) { status.textContent = String(error.message ?? error); }
  finally { save.disabled = false; }
});
load().catch(error => { status.textContent = String(error.message ?? error); });
`;
  await fs.writeFile(path.join(directory, 'plugin.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await fs.writeFile(path.join(directory, 'config.schema.json'), `${JSON.stringify(config, null, 2)}\n`);
  await fs.writeFile(path.join(directory, 'pages', 'settings', 'index.html'), html);
  await fs.writeFile(path.join(directory, 'pages', 'settings', 'app.js'), script);
  return { path: path.resolve(directory), id };
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command === 'init' && rest[0]) return initPlugin(path.resolve(rest[0]), rest[1]);
  if (command === 'check' && rest[0] === '--all') {
    const entries = await fs.readdir(path.join(ROOT, 'plugins'), { withFileTypes: true });
    const reports = [];
    for (const entry of entries.filter((item) => item.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const directory = path.join(ROOT, 'plugins', entry.name);
      try { await fs.access(path.join(directory, 'plugin.manifest.json')); } catch { continue; }
      const { files: _files, ...report } = await checkPlugin(directory);
      reports.push({ directory: entry.name, id: report.manifest?.metadata.id, issues: report.issues, permissions: report.permissions });
    }
    if (!reports.length) throw new Error('No plugin manifests found');
    if (reports.some((report) => report.issues.length)) process.exitCode = 1;
    return reports;
  }
  if ((command === 'check' || command === 'pack') && rest[0]) {
    const hostIndex = rest.indexOf('--host-api');
    const options = hostIndex < 0 ? {} : { hostVersion: rest[hostIndex + 1] };
    if (hostIndex >= 0 && !options.hostVersion) throw new Error('--host-api needs a version');
    if (command === 'pack') return packPlugin(path.resolve(rest[0]), rest[1] && !rest[1].startsWith('--') ? path.resolve(rest[1]) : undefined, options);
    const { files: _files, ...report } = await checkPlugin(path.resolve(rest[0]), options);
    if (report.issues.length) process.exitCode = 1;
    return report;
  }
  throw new Error('Usage: plugin init <new-directory> [id] | check <directory> [--host-api 1.0.0] | check --all | pack <directory> [output.aervox-plugin]');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
