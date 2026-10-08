import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
  ? files(join(dir, entry.name)).map((file) => join(entry.name, file)) : [entry.name]).sort()

test('cold copy reconstructs both consumers and rebuild removes stale generated intro files', () => {
  const root = mkdtempSync(join(tmpdir(), 'aervox-public-'))
  try {
    const pkg = join(root, 'packages/public')
    cpSync(source, pkg, { recursive: true, filter: (path) => !path.includes('node_modules') && !path.includes('.turbo') })
    const desktop = join(root, 'apps/desktop/src/renderer/public')
    const web = join(root, 'apps/web/public')
    const build = () => execFileSync(process.execPath, [join(pkg, 'scripts/copy-assets.mjs')], { stdio: 'pipe' })
    build()
    for (const target of [desktop, web]) assert.deepEqual(readFileSync(join(target, 'aervox-mark.svg')), readFileSync(join(source, 'aervox-mark.svg')))
    const intro = join(desktop, 'aervox-intro')
    const originals = files(join(source, 'aervox-intro'))
    assert.deepEqual(files(intro), originals)
    for (const file of originals) assert.deepEqual(readFileSync(join(intro, file)), readFileSync(join(source, 'aervox-intro', file)))
    writeFileSync(join(intro, 'stale.txt'), 'previous release')
    build()
    assert.deepEqual(files(intro), originals)
    assert.equal(existsSync(join(web, 'aervox-intro')), false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
