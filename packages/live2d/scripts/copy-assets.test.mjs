import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { copyModelAssets, modelAssetSource, sweepStaleStages } from './copy-assets.mjs'

test('a killed run leaves a staging directory that the next build sweeps, without touching user assets', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'aervox-live2d-stage-'))
  try {
    const destination = join(root, 'apps/web/public/live2d')
    mkdirSync(destination, { recursive: true })
    // An interrupted copy: the staged tree exists but the rename never happened.
    const leftover = join(destination, '.mizuki-stage-abc123')
    mkdirSync(leftover)
    writeFileSync(join(leftover, 'partial.txt'), 'interrupted')
    // Adjacent models are user-owned and must survive.
    const neighbour = join(destination, 'user-model')
    mkdirSync(neighbour)
    writeFileSync(join(neighbour, 'keep.txt'), 'user owned')

    copyModelAssets(modelAssetSource, [destination])

    assert.equal(existsSync(leftover), false)
    assert.equal(readFileSync(join(destination, 'mizuki', 'mizuki.model3.json'), 'utf8'),
      readFileSync(join(modelAssetSource, 'mizuki.model3.json'), 'utf8'))
    assert.equal(readFileSync(join(neighbour, 'keep.txt'), 'utf8'), 'user owned')
    assert.deepEqual(readdirSync(destination).filter((name) => name.startsWith('.mizuki-stage-')), [])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('the sweep ignores entries it did not create', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'aervox-live2d-sweep-'))
  try {
    mkdirSync(join(root, 'mizuki'))
    mkdirSync(join(root, '.intro-stage-other'))
    const ours = join(root, '.mizuki-stage-stale')
    mkdirSync(ours)
    assert.equal(sweepStaleStages(root), 1)
    assert.equal(existsSync(ours), false)
    assert.equal(existsSync(join(root, 'mizuki')), true)
    assert.equal(existsSync(join(root, '.intro-stage-other')), true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
