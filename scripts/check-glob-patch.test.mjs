import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createRequire, SourceMap } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Backport of https://github.com/isaacs/node-glob/commit/4682e8c9babee1b385202ede36389634e12076d7
// glob 13's default minified entries bundle their own minimatch. Route the public
// entries to the existing raw modules so the separately patched dependency is
// actually used. Keep the public CJS/ESM API and BlueOak license unchanged.
const root = fileURLToPath(new URL('../', import.meta.url));
const self = fileURLToPath(import.meta.url);
const patchPath = 'patches/glob@13.0.6.patch';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function probe(entry, format, scenario) {
  const api = format === 'cjs'
    ? createRequire(import.meta.url)(fileURLToPath(entry))
    : await import(entry);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aervox-glob-abort-'));
  const files = [];
  function populate(directory, depth) {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'f.txt');
    fs.writeFileSync(file, 'fixture');
    files.push(path.relative(cwd, file).split(path.sep).join('/'));
    if (depth) {
      populate(path.join(directory, 'a'), depth - 1);
      populate(path.join(directory, 'b'), depth - 1);
    }
  }
  const collect = async stream => {
    const values = [];
    for await (const value of stream) values.push(value);
    return values.sort();
  };
  function countedFilesystem() {
    const controller = new AbortController();
    const reason = new Error('intentional glob abort');
    const count = { calls: 0 };
    const abortFirstRead = () => {
      if (++count.calls === 1) controller.abort(reason);
    };
    return {
      count,
      controller,
      reason,
      options: {
        cwd,
        signal: controller.signal,
        fs: {
          ...fs,
          readdir(...args) {
            abortFirstRead();
            return fs.readdir(...args);
          },
          readdirSync(...args) {
            abortFirstRead();
            return fs.readdirSync(...args);
          },
        },
      },
    };
  }
  try {
    populate(cwd, 4);
    fs.writeFileSync(path.join(cwd, '.hidden.txt'), 'hidden fixture');
    if (scenario === 'matching') {
      const options = { cwd, nodir: true, posix: true, ignore: ['b/**'] };
      const expected = files.filter(file => !file.startsWith('b/')).sort();
      assert.deepEqual(api.globSync('**/*.txt', options).sort(), expected);
      assert.deepEqual((await api.glob('**/*.txt', options)).sort(), expected);
      assert.deepEqual(await collect(api.globStream('**/*.txt', options)), expected);
      assert.deepEqual(await collect(api.globStreamSync('**/*.txt', options)), expected);
      assert.deepEqual(api.globSync('*.txt', { cwd, dot: true }).sort(), ['.hidden.txt', 'f.txt']);
      assert.equal(api.hasMagic('**/*.txt'), true);
      assert.equal(api.hasMagic('f.txt'), false);
    } else if (scenario === 'async-abort') {
      const { count, reason, options } = countedFilesystem();
      await assert.rejects(api.glob('**', options), error => error === reason);
      const atRejection = count.calls;
      await delay(100);
      assert.equal(count.calls, atRejection, 'directory reads continued after rejected abort');
      assert.equal(count.calls, 1, 'aborted traversal read a descendant directory');
    } else if (scenario === 'sync-abort') {
      const walk = countedFilesystem();
      assert.throws(() => api.globSync('**', walk.options), error => error === walk.reason);
      assert.equal(walk.count.calls, 1);
      const streamWalk = countedFilesystem();
      const stream = api.globStreamSync('**', streamWalk.options);
      await new Promise((resolve, reject) => {
        stream.once('error', error => {
          if (error === streamWalk.reason) resolve();
          else reject(error);
        });
        stream.resume();
      });
      await delay(25);
      assert.equal(streamWalk.count.calls, 1, 'aborted synchronous stream kept reading');
    } else if (scenario === 'pause-resume') {
      // Upstream regression: let pending reads fill and pause the stream before
      // consuming it. Dropped resume callbacks would leave this iterator hung.
      const stream = api.globStream('**/*.txt', { cwd, nodir: true, posix: true });
      await delay(50);
      assert.deepEqual(await collect(stream), files.sort());
    } else if (scenario === 'aborted-resume-callback') {
      // An already-aborted walker must still release completion work scheduled
      // through onResume. Exercise its real walkCB callback, without filesystem
      // I/O. Restoring only onResume's early return drops this completion.
      const walk = countedFilesystem();
      const glob = new api.Glob('**', walk.options);
      const walkerEntry = new URL('./walker.js', entry);
      const { GlobWalker } = format === 'cjs'
        ? createRequire(import.meta.url)(fileURLToPath(walkerEntry))
        : await import(walkerEntry.href);
      const walker = new GlobWalker(glob.patterns, glob.scurry.cwd, glob);
      walk.controller.abort(walk.reason);
      let callbacks = 0;
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('aborted walker dropped its resume completion callback')), 200);
        try {
          walker.onResume(() => walker.walkCB(glob.scurry.cwd, glob.patterns, () => {
            callbacks++;
            clearTimeout(timeout);
            resolve();
          }));
        } catch (error) {
          clearTimeout(timeout);
          reject(error);
        }
      });
      assert.equal(callbacks, 1);
      assert.equal(walk.count.calls, 0, 'completed aborted walker must not read directories');
    } else {
      throw new Error(`Unknown glob probe: ${scenario}`);
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--probe') {
  // An unresolved stream promise alone does not keep Node alive. Hold a timer
  // so the parent's subprocess timeout detects a genuine hang, then kill it.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await probe(process.argv[3], process.argv[4], process.argv[5]);
    console.log(`${process.argv[4]} ${process.argv[5]} passed`);
  } finally {
    clearInterval(keepAlive);
  }
} else {
  const consumers = [
    { label: '@vue/test-utils > js-beautify', start: 'package.json', names: ['@vue/test-utils', 'js-beautify'] },
    { label: '@capacitor/cli > rimraf', start: 'apps/mobile/package.json', names: ['@capacitor/cli', 'rimraf'] },
  ];
  // Resolve from each real consumer, with both Node conditions. This detects an
  // unpatched parallel installation, rather than testing a convenient root copy.
  const resolved = JSON.parse(execFileSync(process.execPath, [
    '--experimental-import-meta-resolve', '--input-type=module', '-e', `
      import { createRequire } from 'node:module';
      import { pathToFileURL } from 'node:url';
      import path from 'node:path';
      const consumers = ${JSON.stringify(consumers)};
      const root = ${JSON.stringify(root)};
      console.log(JSON.stringify(consumers.map(consumer => {
        let parent = pathToFileURL(path.join(root, consumer.start)).href;
        for (const name of consumer.names) parent = import.meta.resolve(name, parent);
        const require = createRequire(parent);
        const entries = ['glob', 'glob/raw'].flatMap(specifier => [
          { specifier, format: 'cjs', entry: pathToFileURL(require.resolve(specifier)).href },
          { specifier, format: 'esm', entry: import.meta.resolve(specifier, parent) },
        ]).map(entry => ({
          ...entry,
          minimatch: entry.format === 'cjs'
            ? pathToFileURL(createRequire(entry.entry).resolve('minimatch')).href
            : import.meta.resolve('minimatch', entry.entry),
        }));
        return { label: consumer.label, manifest: require.resolve('glob/package.json'), entries };
      })));
    `,
  ], { cwd: root, encoding: 'utf8', timeout: 10_000 }));

  const patchHash = createHash('sha256').update(fs.readFileSync(path.join(root, patchPath))).digest('hex');
  const minimatchPatch = 'patches/minimatch@10.2.6.patch';
  const minimatchHash = createHash('sha256').update(fs.readFileSync(path.join(root, minimatchPatch))).digest('hex');

  test('glob abort patch and its external minimatch patch are registered before audit', () => {
    const workspace = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
    const lock = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
    for (const [name, version, hash] of [['glob', '13.0.6', patchHash], ['minimatch', '10.2.6', minimatchHash]]) {
      const escapedVersion = version.replaceAll('.', '\\.');
      assert.match(workspace, new RegExp(`^  ["']?${name}@${escapedVersion}["']?: patches/${name}@${escapedVersion}\\.patch$`, 'm'));
      assert.match(lock, new RegExp(`^  ${name}@${escapedVersion}: ${hash}$`, 'm'));
      assert.match(lock, new RegExp(`^  ${name}@${escapedVersion}\\(patch_hash=${hash}\\):`, 'm'));
    }
    const patch = fs.readFileSync(path.join(root, patchPath), 'utf8');
    for (const file of ['package.json', ...['commonjs', 'esm'].flatMap(format =>
      ['walker.js', 'walker.js.map', 'walker.d.ts.map'].map(name => `dist/${format}/${name}`))]) {
      assert.ok(patch.includes(`+++ b/${file}`), `${file} is patched`);
    }
    const scripts = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts;
    assert.match(scripts['check:dependency-audit'], /node --test [^&]*scripts\/check-(?:glob|\*)-patch\.test\.mjs[^&]*&& node scripts\/check-dependency-audit\.mjs/);
  });

  for (const consumer of resolved) {
    test(`${consumer.label} uses public unbundled glob entries and patched external minimatch`, () => {
      const manifest = JSON.parse(fs.readFileSync(consumer.manifest, 'utf8'));
      assert.equal(manifest.version, '13.0.6');
      assert.equal(manifest.license, 'BlueOak-1.0.0');
      assert.equal(manifest.bin, undefined);
      assert.deepEqual(Object.keys(manifest.exports).sort(), ['.', './package.json', './raw']);
      assert.equal(manifest.main, './dist/commonjs/index.js');
      assert.equal(manifest.module, './dist/esm/index.js');
      assert.equal(JSON.stringify(manifest.exports).includes('.min.js'), false);
      for (const format of ['commonjs', 'esm']) {
        const base = path.join(path.dirname(consumer.manifest), 'dist', format, 'walker');
        const js = fs.readFileSync(`${base}.js`, 'utf8').split('\n');
        const rawMap = JSON.parse(fs.readFileSync(`${base}.js.map`, 'utf8'));
        const source = rawMap.sourcesContent[0].split('\n');
        const map = new SourceMap(rawMap);
        const returnLines = js.flatMap((line, index) => line.includes('return cb();') && js[index - 1]?.includes('this.signal?.aborted') ? [index] : []);
        assert.equal(returnLines.length, 4);
        for (const line of returnLines) {
          const mapped = map.findEntry(line, js[line].indexOf('return'));
          assert.ok(source[mapped.originalLine]?.includes('if (this.signal?.aborted) return cb()'));
        }
        const declaration = fs.readFileSync(`${base}.d.ts`, 'utf8').split('\n');
        const declarationMap = new SourceMap(JSON.parse(fs.readFileSync(`${base}.d.ts.map`, 'utf8')));
        for (const method of ['onResume', 'walkCB', 'walkCB2', 'walkCBSync', 'walkCB2Sync']) {
          const line = declaration.findIndex(value => value.trimStart().startsWith(`${method}(`));
          const mapped = declarationMap.findEntry(line, declaration[line].indexOf(method));
          assert.ok(source[mapped.originalLine]?.includes(`${method}(`), `${format} declaration map for ${method}`);
        }
      }
      for (const { entry, minimatch, format } of consumer.entries) {
        const relative = path.relative(path.dirname(consumer.manifest), fileURLToPath(entry)).split(path.sep).join('/');
        assert.equal(relative, `dist/${format === 'cjs' ? 'commonjs' : 'esm'}/index.js`);
        // The pinned pnpm installation includes patch identities in its store
        // paths, so stale pre-patch installs cannot pass this resolution check.
        assert.ok(fs.realpathSync(fileURLToPath(entry)).split(path.sep).includes(`glob@13.0.6_patch_hash=${patchHash}`));
        assert.ok(fs.realpathSync(fileURLToPath(minimatch)).split(path.sep).includes(`minimatch@10.2.6_patch_hash=${minimatchHash}`));
      }
    });
    for (const { specifier, entry, format } of consumer.entries) {
      for (const scenario of ['matching', 'async-abort', 'sync-abort', 'pause-resume', 'aborted-resume-callback']) {
        test(`${consumer.label} ${specifier} ${format} ${scenario}`, () => {
          const child = spawnSync(process.execPath, [self, '--probe', entry, format, scenario], {
            cwd: root, encoding: 'utf8', timeout: 8_000, maxBuffer: 1024 * 1024,
          });
          assert.equal(child.error, undefined, child.error?.message);
          assert.equal(child.status, 0, child.stderr || child.stdout);
        });
      }
    }
  }
}
