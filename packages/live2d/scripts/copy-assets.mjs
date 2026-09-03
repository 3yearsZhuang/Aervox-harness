/**
 * copy-assets.mjs — 把 @aervox/live2d 的 mizuki 模型资源拷贝到各消费端 public 目录
 *
 * W-15 收敛：mizuki 模型单份真源（packages/live2d/mizuki），
 * 各端（desktop/web）构建时从包拷贝到自己的 public 目录供运行时 fetch。
 * 消费端 public 下的 live2d/mizuki 是构建产物，已 gitignore，不入库。
 *
 * 由 @aervox/live2d 的 build 脚本触发（turbo dependsOn ^build 保证顺序）。
 */
import { cpSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(pkgDir, 'mizuki')

/** 消费端 public 目录：desktop 的 renderer/public 与 web 的 public */
const targets = [
  resolve(pkgDir, '../../apps/desktop/src/renderer/public/live2d'),
  resolve(pkgDir, '../../apps/web/public/live2d'),
]

if (!existsSync(source)) {
  throw new Error(`live2d 资源目录不存在: ${source}（请先初始化 submodule 或拉取 packages/live2d/mizuki）`)
}

for (const targetDir of targets) {
  mkdirSync(targetDir, { recursive: true })
  cpSync(source, join(targetDir, 'mizuki'), { recursive: true })
  console.log(`✓ 已拷贝 mizuki → ${join(targetDir, 'mizuki')}`)
}