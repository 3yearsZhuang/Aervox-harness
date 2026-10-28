import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import {
  collectMarketBundleFiles,
  exportPluginBundle,
  listMarketPlugins,
  type BundleEngineDeps,
} from '../src/modules/ecosystem/plugins/package-bundle.js';

const manifest = {
  apiVersion: 'aervox.dev/v1', kind: 'PluginManifest',
  metadata: { id: 'example', displayName: 'Example', publisher: 'fixture', version: '1.0.0' },
  spec: { skill: 'SKILL.md', pages: [{ id: 'main', title: 'Main', entry: 'pages/main/index.html', capabilities: [] }] },
};

describe('builtin plugin export resource boundary', () => {
  let root: string;
  let source: string;
  let deps: BundleEngineDeps;
  const put = async (file: string, content: string) => {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await fs.writeFile(path.join(source, file), content);
  };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'aervox-bundle-export-'));
    source = path.join(root, 'example');
    await put('plugin.manifest.json', JSON.stringify(manifest));
    await put('SKILL.md', '# Example\nInstructions.');
    await put('pages/main/index.html', '<h1>Example</h1>');
    deps = {
      builtinPluginsSourceRoot: root,
      extensionRepo: { getPlugin: vi.fn().mockResolvedValue(null) },
    } as unknown as BundleEngineDeps;
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it('exports the same declarations/resources as market installation while excluding implementation and dependencies', async () => {
    await put('src/index.ts', 'private implementation');
    await put('dist/index.js', 'compiled implementation');
    await put('test/private.test.ts', 'private tests');
    await put('package.json', '{}');
    await put('.gitignore', 'dist/');
    await put('node_modules/local-placeholder', 'dependency');
    await fs.symlink(path.join(root, 'external-dependency'), path.join(source, 'node_modules/workspace'));
    const result = await exportPluginBundle('example', deps);
    const files = unzipSync(result.bytes);
    const marketFiles = await collectMarketBundleFiles(source);
    expect(Object.keys(files).sort()).toEqual(['SKILL.md', 'pages/main/index.html', 'plugin.manifest.json']);
    expect(files).toEqual(marketFiles);
    expect(strFromU8(files['pages/main/index.html']!)).toBe('<h1>Example</h1>');
    expect(result.checksum).toBe(createHash('sha256').update(result.bytes).digest('hex'));
  });

  it('discovers plugins beside clone metadata without treating repository directories as plugins', async () => {
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await fs.writeFile(path.join(root, '.git/FETCH_HEAD'), 'clone metadata');
    await fs.mkdir(path.join(root, '.github/workflows'), { recursive: true });
    await fs.writeFile(path.join(root, '.github/workflows/integration.yml'), 'name: integration');
    await fs.writeFile(path.join(root, 'LICENSE'), 'collection license');
    deps.extensionRepo.listPlugins = vi.fn().mockResolvedValue([]);
    const market = await listMarketPlugins(deps);
    expect(market.map(item => item.id)).toEqual(['example']);
    const exported = await exportPluginBundle('example', deps);
    expect(Object.keys(unzipSync(exported.bytes)).sort()).toEqual(['SKILL.md', 'pages/main/index.html', 'plugin.manifest.json']);
  });

  it.each(['.env', '.git', 'credentials.json', 'unknown.asset', 'LICENSE'])('rejects an unclassified source entry: %s', async file => {
    await put(file, 'unclassified local content');
    await expect(exportPluginBundle('example', deps)).rejects.toThrow(/未登记角色/);
  });

  it.each(['SKILL.md', 'pages/main/linked.txt'])('rejects symbolic resources without reading outside the plugin: %s', async file => {
    const outside = path.join(root, 'outside-secret');
    await fs.writeFile(outside, 'must not export');
    await fs.rm(path.join(source, file), { force: true });
    await fs.symlink(outside, path.join(source, file));
    await expect(exportPluginBundle('example', deps)).rejects.toThrow(/Unsupported plugin resource/);
    await expect(collectMarketBundleFiles(source)).rejects.toThrow(/Unsupported plugin resource/);
  });

  it('rejects a symbolic plugin directory', async () => {
    const actual = path.join(root, 'actual-source');
    await fs.rename(source, actual);
    await fs.symlink(actual, source);
    await expect(exportPluginBundle('example', deps)).rejects.toThrow(/Unsupported plugin source directory/);
    await expect(collectMarketBundleFiles(source)).rejects.toThrow(/Unsupported plugin source directory/);
  });

  it('rejects invalid source declarations before producing an uninstallable archive', async () => {
    await put('plugin.manifest.json', JSON.stringify({ ...manifest, spec: {} }));
    await expect(exportPluginBundle('example', deps)).rejects.toThrow(/PAGE_UNDECLARED|Page resources require/);
  });

  it('returns an installed generation original archive unchanged even when builtin source is invalid', async () => {
    const original = zipSync({ 'plugin.manifest.json': strToU8(JSON.stringify(manifest)) }, { mtime: new Date(1980, 0, 1) });
    const readOriginalBundle = vi.fn().mockResolvedValue(original);
    deps.extensionRepo.getPlugin = vi.fn().mockResolvedValue({ id: 'example', version: '2.0.0', bundleGeneration: 'stored-generation' });
    deps.bundleStore = { readOriginalBundle } as unknown as BundleEngineDeps['bundleStore'];
    await put('.env', 'must not inspect builtin source');
    const result = await exportPluginBundle('example', deps);
    expect(readOriginalBundle).toHaveBeenCalledExactlyOnceWith('example', 'stored-generation');
    expect(result.bytes).toBe(original);
    expect(result.filename).toBe('example-2.0.0.aervox-plugin');
    expect(result.checksum).toBe(createHash('sha256').update(original).digest('hex'));
  });
});
