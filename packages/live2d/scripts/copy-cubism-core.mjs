/**
 * copy-cubism-core.mjs — 把固定的 Cubism Core 制件同步到各消费端 public 目录
 *
 * 真源：packages/live2d/cubism/live2dcubismcore.min.js（受跟踪、按摘要校验）。
 * 各端（desktop/web）构建时从包拷贝，运行时由本地 `<script src>` 加载，
 * 不再从 cubism.live2d.com 拉取——否则离线启动与本地数据边界都不成立。
 *
 * 与 @aervox/mobile 的 prepare-native-assets 共用同一字节和 SHA-256 契约，
 * 三端不可能装载不同版本的 Core。
 */
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export const cubismCoreArtifact = Object.freeze({
  fileName: 'live2dcubismcore.min.js',
  sha256: '25ae938cb4fe282ce189b357bcc97e603d1e1f7ec78bf04150d401c23cdc792f',
  bytes: 207155,
  source: join(pkgDir, 'cubism', 'live2dcubismcore.min.js'),
})

/** Tampered or truncated bytes must fail the build; a "close enough" core is never accepted. */
export function verifyCubismCore(file = cubismCoreArtifact.source) {
  const bytes = readFileSync(file)
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (bytes.length !== cubismCoreArtifact.bytes || digest !== cubismCoreArtifact.sha256) {
    throw new Error(`Cubism Core 摘要不匹配：${file}（期望 ${cubismCoreArtifact.bytes} 字节 / ${cubismCoreArtifact.sha256}，实际 ${bytes.length} 字节 / ${digest}）`)
  }
  return bytes
}

/**
 * Consumers pass their own `public/` root; the destination always lives inside it.
 * The copy is a plain file overwrite because the target directory is build output.
 */
export function copyCubismCore(targetDirectory) {
  verifyCubismCore()
  const destination = resolve(targetDirectory)
  mkdirSync(destination, { recursive: true })
  const file = join(destination, cubismCoreArtifact.fileName)
  copyFileSync(cubismCoreArtifact.source, file)
  return file
}
