/** Shared asset manifest and consumer-invoked copy operation. */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const publicAssetManifest = Object.freeze({mark: 'aervox-mark.svg', intro: 'aervox-intro'})

/** Staging prefix this module creates inside the consumer directory. */
const STAGE_PREFIX = '.intro-stage-'

/**
 * Remove staging directories left behind by an interrupted run.
 *
 * `finally` covers thrown errors but not process kills, so a stopped build leaves a
 * staged copy behind. Only entries carrying this module's unique prefix are removed.
 */
export function sweepStaleIntroStages(destination) {
  let removed = 0
  let entries
  try {
    entries = readdirSync(destination, { withFileTypes: true })
  } catch {
    return removed
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGE_PREFIX)) continue
    rmSync(join(destination, entry.name), { recursive: true, force: true })
    removed += 1
  }
  return removed
}

export function copyPublicAssets(target, { includeIntro = false } = {}) {
  const destination = resolve(target)
  const within = (parent, child) => {
    const rel = relative(parent, child)
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }
  let anchor = source
  while (!within(anchor, destination)) anchor = dirname(anchor)
  let current = realpathSync(anchor)
  for (const part of relative(anchor, destination).split(sep).filter(Boolean)) {
    current = join(current, part)
    if (lstatSync(current, {throwIfNoEntry: false})?.isSymbolicLink()) {
      const osAliases = {'/var': '/private/var', '/tmp': '/private/tmp'}
      if (osAliases[current] !== realpathSync(current)) throw new Error(`拒绝链接资源目录: ${current}`)
    }
  }
  mkdirSync(destination, { recursive: true })
  const mark = join(destination, publicAssetManifest.mark)
  if (lstatSync(mark, {throwIfNoEntry: false})?.isSymbolicLink()) throw new Error(`拒绝链接资源文件: ${mark}`)
  cpSync(join(source, publicAssetManifest.mark), mark)
  if (includeIntro) {
    const swept = sweepStaleIntroStages(destination)
    if (swept > 0) console.log(`✓ 已清理 ${swept} 个中断残留的暂存目录 → ${destination}`)
    const stage = mkdtempSync(join(destination, STAGE_PREFIX))
    try {
      cpSync(join(source, publicAssetManifest.intro), stage, { recursive: true })
      rmSync(join(destination, publicAssetManifest.intro), { recursive: true, force: true })
      renameSync(stage, join(destination, publicAssetManifest.intro))
    } finally { rmSync(stage, { recursive: true, force: true }) }
  }
}
