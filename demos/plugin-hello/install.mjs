#!/usr/bin/env node
/**
 * Hello Aervox Demo 插件安装脚本
 *
 * 用法：
 *   1. 启动 API：pnpm --filter @aervox/api dev（默认 http://127.0.0.1:3000）
 *   2. 运行：node demos/plugin-hello/install.mjs
 *
 * 可选环境变量：
 *   AERVOX_API_URL       API 地址（默认 http://127.0.0.1:3000）
 *   AERVOX_WORKSPACE_ID  租户头 x-workspace-id
 *   AERVOX_USER_ID       租户头 x-user-id
 */
import {readFile, readdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const apiBase = (process.env.AERVOX_API_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
const headers = {
  'Content-Type': 'application/json',
  ...(process.env.AERVOX_WORKSPACE_ID ? {'x-workspace-id': process.env.AERVOX_WORKSPACE_ID} : {}),
  ...(process.env.AERVOX_USER_ID ? {'x-user-id': process.env.AERVOX_USER_ID} : {}),
};

async function request(method, url, body) {
  const res = await fetch(`${apiBase}${url}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${url} → HTTP ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function collectFiles(root) {
  const files = [];
  async function walk(current, prefix) {
    for (const entry of await readdir(current, {withFileTypes: true})) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else files.push({path: rel, contentBase64: (await readFile(path.join(current, entry.name))).toString('base64')});
    }
  }
  await walk(root, '');
  return files;
}

const manifest = JSON.parse(await readFile(path.join(dir, 'plugin.manifest.json'), 'utf8'));
const pluginId = manifest.metadata.id;

await request('POST', '/v1/plugins', {
  id: pluginId,
  publisher: manifest.metadata.publisher,
  version: manifest.metadata.version,
  permissions: [],
});
console.log(`[ok] 插件已登记：${pluginId}`);

await request('PUT', `/v1/plugins/${pluginId}/config/schema`, JSON.parse(await readFile(path.join(dir, 'config.schema.json'), 'utf8')));
console.log('[ok] 配置 Schema 已注册');

for (const page of manifest.spec.pages ?? []) {
  await request('POST', `/v1/plugins/${pluginId}/pages`, page);
  const pageDir = path.join(dir, 'pages', page.id);
  const files = await collectFiles(pageDir);
  await request('POST', `/v1/plugins/${pluginId}/pages/${page.id}/assets`, {files});
  console.log(`[ok] 页面已注册并写入资源：${page.id}`);
}

console.log(`\n完成！打开设置 → 插件 → ${pluginId}，即可配置并打开页面。`);
