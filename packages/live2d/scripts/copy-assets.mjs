/**
 * copy-assets.mjs — 把 @aervox/live2d 的 mizuki 模型资源拷贝到各消费端 public 目录
 *
 * W-15 收敛：mizuki 模型单份真源（packages/live2d/mizuki），
 * 各端（desktop/web）构建时从包拷贝到自己的 public 目录供运行时 fetch。
 * 消费端 public 下的 live2d/mizuki 是构建产物，已 gitignore，不入库。
 *
 * 消费端显式传入自己的输出目录。
 */
import { cpSync, mkdirSync, existsSync, mkdtempSync, rmSync, renameSync, lstatSync, realpathSync } from 'node:fs'
import { dirname, join, resolve, relative, sep, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(pkgDir, 'mizuki')

export const modelAssetSource = source

export function copyModelAssets(source, targets) {
  if (!existsSync(source)) throw new Error(`live2d 资源目录不存在: ${source}`)
  // Anchor to the shared checkout/fixture root. OS aliases such as /var -> /private/var
  // are allowed above it; linked consumer directories below it are rejected.
  let root = dirname(resolve(source))
  const within = (parent, child) => {
    const rel = relative(parent, resolve(child))
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  }
  while (targets.some(target => !within(root, target))) {
    if (root === dirname(root)) throw new Error('资源目标必须位于同一文件系统根目录')
    root = dirname(root)
  }
  const canonicalRoot = realpathSync(root)
  const destinations = targets.map(target => join(canonicalRoot, relative(root, resolve(target))))
  for (const targetDir of destinations) {
    let parent = canonicalRoot
    for (const part of relative(canonicalRoot, targetDir).split(sep).filter(Boolean)) {
      parent = join(parent, part)
      if (lstatSync(parent, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`拒绝链接资源目录: ${parent}`)
    }
  }
  for (const targetDir of destinations) {
    mkdirSync(targetDir, { recursive: true })
    const stage = mkdtempSync(join(targetDir, '.mizuki-stage-'))
    try {
      cpSync(source, stage, { recursive: true })
      // Only this generated subtree is owned by this package; adjacent models are user-owned.
      rmSync(join(targetDir, 'mizuki'), { recursive: true, force: true })
      renameSync(stage, join(targetDir, 'mizuki'))
    } finally { rmSync(stage, { recursive: true, force: true }) }
    console.log(`✓ 已同步 mizuki → ${join(targetDir, 'mizuki')}`)
  }
}
