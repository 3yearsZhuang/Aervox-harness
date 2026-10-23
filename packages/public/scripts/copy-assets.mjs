/** Shared asset manifest and consumer-invoked copy operation. */
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const publicAssetManifest = Object.freeze({mark: 'aervox-mark.svg', intro: 'aervox-intro'})

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
    const stage = mkdtempSync(join(destination, '.intro-stage-'))
    try {
      cpSync(join(source, publicAssetManifest.intro), stage, { recursive: true })
      rmSync(join(destination, publicAssetManifest.intro), { recursive: true, force: true })
      renameSync(stage, join(destination, publicAssetManifest.intro))
    } finally { rmSync(stage, { recursive: true, force: true }) }
  }
}
