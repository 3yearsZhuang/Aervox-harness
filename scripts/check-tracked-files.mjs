import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { productTrackedEntries } from './core-submodule.mjs';

export const SIZE_EXCEPTIONS = {
  'packages/live2d/mizuki/model/20mizuki_normal_3.0_t04.2048/texture_00.png': { maxBytes: 2_000_000, reason: 'Original bundled Live2D texture' },
  'packages/ui/src/assets/brand/siyu-companion-a2.png': { maxBytes: 1_300_000, reason: 'Product brand illustration' },
};
const FAKE_KEY_FILE = 'apps/worker/test/proactive-distiller.test.ts';
const FAKE_KEY = ['-----BEGIN', ' PRIVATE KEY-----",\n      "private-material",\n      "-----END', ' PRIVATE KEY-----'].join('');
const GENERATED = /(?:^|\/)(?:dist|out|\.turbo|node_modules|\.cache|coverage)(?:\/|$)/;
const LOCAL_FILE = /(?:\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?|\.(?:log|tmp|bak|swp|tsbuildinfo)|~)$/i;
const CREDENTIAL_FILE = /(?:^|\/)(?:\.env(?:\..+)?|id_rsa|id_ed25519|credentials\.json)$/;

/** Inspect product tracked files, including required Core; ignore data and reference gitlinks. */
export function inspectTrackedFiles({ cwd = process.cwd(), sizeLimit = 1_048_576, exceptions = SIZE_EXCEPTIONS } = {}) {
  const entries = productTrackedEntries(cwd);
  const violations = [];
  let files = 0;
  for (const { file } of entries) {
    const stat = lstatSync(path.join(cwd, file), { throwIfNoEntry: false });
    if (!stat) continue; // A tracked removal is checked by Git/PR review.
    files++;
    const add = rule => violations.push({ file, rule });
    if (!stat.isFile()) { add('tracked-link-or-special-file'); continue; }
    if (GENERATED.test(file)) add('generated-output');
    if (LOCAL_FILE.test(file)) add('local-runtime-file');
    if (CREDENTIAL_FILE.test(file) && !/(?:^|\/)\.env\.(?:example|sample|template)$/.test(file)) add('credential-file');
    if (stat.size > (exceptions[file]?.maxBytes ?? sizeLimit)) { add('size-budget'); continue; }
    // Keep notices and values out of diagnostics; report only file and rule.
    const bytes = readFileSync(path.join(cwd, file));
    if (bytes.subarray(0, 8192).includes(0)) continue;
    const keys = bytes.toString('utf8').match(/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g) ?? [];
    const beginnings = bytes.toString('utf8').match(/-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g) ?? [];
    if (beginnings.length !== keys.length || keys.some(key => file !== FAKE_KEY_FILE || key !== FAKE_KEY) || (file === FAKE_KEY_FILE && keys.length > 1)) add('private-key-material');
  }
  return { files, violations };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = inspectTrackedFiles();
  for (const violation of result.violations) console.error(`${violation.file}: ${violation.rule}`);
  console.log(`Tracked file hygiene: ${result.files} files, ${result.violations.length} violations`);
  if (result.violations.length) process.exitCode = 1;
}
