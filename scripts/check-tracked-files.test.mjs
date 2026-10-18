import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspectTrackedFiles } from './check-tracked-files.mjs';

test('tracked gate catches forced generated/runtime/secret files and ignores user data and gitlinks', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'aervox-tracked-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd });
    const put = (file, text) => { mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true }); writeFileSync(path.join(cwd, file), text); };
    put('.gitignore', 'data/\n.env\ndist/\n');
    put('source with spaces.ts', 'export {};');
    put('data/business.db', 'private user data');
    put('dist/generated.js', 'generated');
    put('.env', 'EXAMPLE=secret');
    put('runtime.log', 'runtime');
    put('key.txt', ['-----BEGIN' + ' PRIVATE KEY-----', 'DO NOT PRINT THIS VALUE', '-----END' + ' PRIVATE KEY-----'].join('\n'));
    execFileSync('git', ['add', '-f', '.gitignore', 'source with spaces.ts', 'dist/generated.js', '.env', 'runtime.log', 'key.txt'], { cwd });
    execFileSync('git', ['update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,reference/external'], { cwd });
    assert.deepEqual(inspectTrackedFiles({ cwd }).violations.map(v => [v.file, v.rule]), [
      ['.env', 'credential-file'], ['dist/generated.js', 'generated-output'], ['key.txt', 'private-key-material'], ['runtime.log', 'local-runtime-file'],
    ]);
    put('truncated-key.txt', '-----BEGIN' + ' PRIVATE KEY-----\ntruncated');
    execFileSync('git', ['add', 'truncated-key.txt'], { cwd });
    assert.ok(inspectTrackedFiles({ cwd }).violations.some(v => v.file === 'truncated-key.txt' && v.rule === 'private-key-material'));
    put('large.png', Buffer.alloc(65, 0));
    execFileSync('git', ['add', 'large.png'], { cwd });
    assert.ok(inspectTrackedFiles({ cwd, sizeLimit: 64 }).violations.some(v => v.file === 'large.png' && v.rule === 'size-budget'));
    assert.ok(!inspectTrackedFiles({ cwd, sizeLimit: 64, exceptions: { 'large.png': { maxBytes: 65, reason: 'test asset' } } }).violations.some(v => v.file === 'large.png'));
    put('large.png', Buffer.alloc(66, 0));
    assert.ok(inspectTrackedFiles({ cwd, sizeLimit: 64, exceptions: { 'large.png': { maxBytes: 65 } } }).violations.some(v => v.file === 'large.png'));
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});
