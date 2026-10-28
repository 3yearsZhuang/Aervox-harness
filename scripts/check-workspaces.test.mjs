import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { discoverWorkspaces, workspaceOwner } from './workspaces.mjs';
import { collectSourceFiles } from './import-boundary.mjs';
import { getSubpackageJsonPaths } from './check-dep-hoisting.mjs';

test('default boundary and dependency scans cover every declared workspace, including surfaces', () => {
  const packages = discoverWorkspaces();
  assert.deepEqual(getSubpackageJsonPaths().map(p => p.relDir), packages.map(p => p.relDir));
  assert.ok(collectSourceFiles().some(file => file.startsWith('plugins/surfaces/workbench-ui/src/')));
  assert.equal(workspaceOwner('plugins/surfaces/workbench-ui/src/index.ts', packages).name, '@aervox/plugin-workbench-ui');
});

test('new workspace roots, real names and default CLI violations need no root-list edits', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'aervox-workspaces-'));
  try {
    mkdirSync(path.join(cwd, 'future/new/src'), { recursive: true });
    writeFileSync(path.join(cwd, 'pnpm-workspace.yaml'), 'packages:\n  - "future/*"\n');
    writeFileSync(path.join(cwd, 'package.json'), '{"private":true}');
    writeFileSync(path.join(cwd, 'future/new/package.json'), '{"name":"@example/real-name","devDependencies":{"vitest":"4"}}');
    assert.equal(discoverWorkspaces(cwd)[0].name, '@example/real-name');
    const result = spawnSync(process.execPath, [new URL('./check-dep-hoisting.mjs', import.meta.url).pathname], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /@example\/real-name/);
    writeFileSync(path.join(cwd, 'future/new/src/broken.ts'), 'export const broken = ;');
    const boundary = spawnSync(process.execPath, [new URL('./import-boundary.mjs', import.meta.url).pathname], { cwd, encoding: 'utf8' });
    assert.equal(boundary.status, 1);
    assert.match(boundary.stderr, /future\/new\/src\/broken.ts/);
    execFileSync('git', ['init', '-q'], { cwd });
    symlinkSync(tmpdir(), path.join(cwd, 'future/escape'));
    writeFileSync(path.join(cwd, 'pnpm-workspace.yaml'), 'packages:\n  - "future/new"\n  - "../escape"\n');
    assert.throws(() => discoverWorkspaces(cwd), /Unsupported workspace/);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
