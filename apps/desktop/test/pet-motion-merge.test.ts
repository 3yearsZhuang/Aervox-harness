import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeExternalMotionData } from '../src/renderer/src/live2d/model.js'
import type { CubismModel3Json, ResolvedCubismAsset } from '../src/renderer/src/live2d/model.js'

const modelRoot = fileURLToPath(new URL('../src/renderer/public/live2d/mizuki', import.meta.url))
const manifestUrl = 'https://pet.local/live2d/mizuki/mizuki.model3.json'

function createAsset(): ResolvedCubismAsset {
  return {
    manifest: { Version: 3, FileReferences: { Moc: 'mizuki.moc3', Textures: [] } } as unknown as CubismModel3Json,
    manifestUrl,
    baseUrl: 'https://pet.local/live2d/mizuki/',
    resolve: (relativePath) => new URL(relativePath, 'https://pet.local/live2d/mizuki/').toString(),
  }
}

function stubMetadataFetch(): void {
  const metadata = JSON.parse(readFileSync(resolve(modelRoot, 'BuildMotionData.json'), 'utf8')) as unknown
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(metadata), { status: 200 })))
}

function assetFileToDiskPath(fileUrl: string): string {
  const pathname = decodeURIComponent(new URL(fileUrl).pathname)
  return resolve(fileURLToPath(new URL('../src/renderer/public', import.meta.url)), '.' + pathname)
}

describe('mergeExternalMotionData（桌宠窗口 Motion 路径回归）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('使用真实 BuildMotionData 合并后，Motion 组 URL 指向 motion/motion/ 且文件真实存在', async () => {
    stubMetadataFetch()
    const asset = createAsset()
    await mergeExternalMotionData(asset, '/live2d/mizuki/BuildMotionData.json', { includeExpressions: true })
    const motions = asset.manifest.FileReferences.Motions?.Motion ?? []
    expect(motions.length).toBeGreaterThan(100)
    for (const motion of motions) {
      expect(motion.File, `动作 ${motion.Name} 的 URL 层级错误`).toContain('/motion/motion/')
      expect(existsSync(assetFileToDiskPath(motion.File)), `动作资产缺失: ${motion.File}`).toBe(true)
    }
  })

  it('已知动作 w-normal-greeting01 可被命名解析且资产存在', async () => {
    stubMetadataFetch()
    const asset = createAsset()
    await mergeExternalMotionData(asset, '/live2d/mizuki/BuildMotionData.json', { includeExpressions: false })
    const motions = asset.manifest.FileReferences.Motions?.Motion ?? []
    const greeting = motions.find((motion) => motion.Name === 'w-normal-greeting01')
    expect(greeting).toBeTruthy()
    expect(existsSync(assetFileToDiskPath(greeting!.File))).toBe(true)
  })

  it('Facial 组 URL 指向 facial/ 且文件真实存在', async () => {
    stubMetadataFetch()
    const asset = createAsset()
    await mergeExternalMotionData(asset, '/live2d/mizuki/BuildMotionData.json', { includeExpressions: true })
    const facial = asset.manifest.FileReferences.Motions?.Facial ?? []
    expect(facial.length).toBeGreaterThan(0)
    for (const face of facial) {
      expect(face.File).toContain('/facial/')
      expect(existsSync(assetFileToDiskPath(face.File)), `表情资产缺失: ${face.File}`).toBe(true)
    }
  })
})
