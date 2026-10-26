// Resolve the selected actual execution dependencies; no platform/version path
// is hard-coded into the cross-platform static source manifest.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { COST_RUNTIME_ROLES } from './cost-protocol.mjs';

async function packageInfo(entry, name) {
  let directory = path.dirname(entry);
  for (;;) {
    try {
      const file = path.join(directory, 'package.json'), metadata = JSON.parse(await readFile(file, 'utf8'));
      if (metadata.name === name) return { root: directory, file, name: metadata.name, version: metadata.version };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`package root not found: ${name}`);
    directory = parent;
  }
}

export async function readCostRuntimeInputs(root) {
  if (process.env.LIBSQL_JS_DEV) throw new Error('LIBSQL_JS_DEV override is outside the declared native-runtime protocol');
  root = await realpath(root);
  const clientEntry = await realpath(path.join(root, 'packages/repositories/node_modules/@libsql/client/lib-esm/sqlite3.js'));
  const clientRequire = createRequire(clientEntry);
  // require.resolve locates the package through its CJS export. The client
  // imports its ESM export, whose actual files are selected below.
  const core = await packageInfo(clientRequire.resolve('@libsql/core/api'), '@libsql/core');
  const coreRequire = createRequire(path.join(core.root, 'lib-esm/util.js'));
  const base64Entry = coreRequire.resolve('js-base64');
  const base64 = await packageInfo(base64Entry, 'js-base64');
  const base64Metadata = JSON.parse(await readFile(base64.file, 'utf8'));
  const base64Import = base64Metadata.exports?.['.']?.import?.default ?? base64Metadata.exports?.['.']?.import;
  assert.ok(typeof base64Import === 'string' && base64Import.startsWith('./'), 'js-base64 ESM export could not be resolved');
  const base64EsmEntry = path.join(base64.root, base64Import);
  const libsqlEntry = clientRequire.resolve('libsql');
  const libsql = await packageInfo(libsqlEntry, 'libsql');
  const libsqlRequire = createRequire(libsqlEntry);
  const loaderEntry = libsqlRequire.resolve('@neon-rs/load');
  const libcEntry = libsqlRequire.resolve('detect-libc');
  const loader = await packageInfo(loaderEntry, '@neon-rs/load');
  const libc = await packageInfo(libcEntry, 'detect-libc');
  // Match libsql's own native selection, including its Linux glibc correction.
  let target = libsqlRequire('@neon-rs/load').currentTarget();
  const { familySync, GLIBC } = libsqlRequire('detect-libc');
  if (familySync() === GLIBC) {
    if (target === 'linux-x64-musl') target = 'linux-x64-gnu';
    else if (target === 'linux-arm64-musl') target = 'linux-arm64-gnu';
  }
  const nativeName = `@libsql/${target}`, nativeEntry = libsqlRequire.resolve(nativeName);
  const native = await packageInfo(nativeEntry, nativeName);
  const entries = {
    'core-package': [core, core.file],
    ...Object.fromEntries(['api', 'config', 'util', 'uri'].map(name => [`core-${name}`, [core, path.join(core.root, `lib-esm/${name}.js`)]])),
    'base64-package': [base64, base64.file], 'base64-entry': [base64, base64EsmEntry],
    'libsql-package': [libsql, libsql.file], 'libsql-entry': [libsql, libsqlEntry], 'libsql-error': [libsql, path.join(libsql.root, 'sqlite-error.js')],
    'loader-package': [loader, loader.file], 'loader-entry': [loader, loaderEntry],
    'libc-package': [libc, libc.file], 'libc-entry': [libc, libcEntry],
    'native-package': [native, native.file], 'native-addon': [native, nativeEntry],
  };
  return Promise.all(COST_RUNTIME_ROLES.map(async role => {
    const [metadata, file] = entries[role];
    const absolute = await realpath(file), relative = path.relative(root, absolute).split(path.sep).join('/');
    assert.ok(relative.startsWith('node_modules/.pnpm/') && !relative.split('/').includes('..'), 'execution dependency must be inside the repository install');
    return { role, packageName: metadata.name, packageVersion: metadata.version,
      path: relative, sha256: createHash('sha256').update(await readFile(absolute)).digest('hex') };
  }));
}
