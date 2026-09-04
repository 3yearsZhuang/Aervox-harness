/**
 * copy-assets.mjs — 把 @aervox/public 的共享静态资产拷贝到各消费端 public 目录
 *
 * 收敛：favicon（aervox-mark.svg）与产品介绍页（aervox-intro）单份真源，
 * 各端构建时从包拷贝到自己的 public 目录供运行时引用。
 * 消费端 public 下的对应文件是构建产物。
 *
 * 由 @aervox/public 的 build 脚本触发（turbo dependsOn ^build 保证顺序）。
 */
import { cpSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 消费端 public 目录：desktop 的 renderer/public 与 web 的 public */
const desktopPublic = resolve(pkgDir, '../../apps/desktop/src/renderer/public')
const webPublic = resolve(pkgDir, '../../apps/web/public')

/** svg：两端共有，都拷 */
for (const targetDir of [desktopPublic, webPublic]) {
  const src = join(pkgDir, 'aervox-mark.svg')
  if (!existsSync(src)) throw new Error(`共享资产不存在: ${src}`)
  mkdirSync(targetDir, { recursive: true })
  cpSync(src, join(targetDir, 'aervox-mark.svg'))
  console.log(`✓ 已拷贝 aervox-mark.svg → ${join(targetDir, 'aervox-mark.svg')}`)
}

/** intro：desktop 专属（web 不消费，不拷，避免未跟踪冗余与路径歧义） */
const introSrc = join(pkgDir, 'aervox-intro')
if (!existsSync(introSrc)) throw new Error(`共享资产不存在: ${introSrc}`)
mkdirSync(desktopPublic, { recursive: true })
cpSync(introSrc, join(desktopPublic, 'aervox-intro'), { recursive: true })
console.log(`✓ 已拷贝 aervox-intro → ${join(desktopPublic, 'aervox-intro')}`)