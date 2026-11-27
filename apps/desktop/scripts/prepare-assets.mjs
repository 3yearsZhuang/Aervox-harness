import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { copyPublicAssets } from '@aervox/public/build-assets'
import { copyModelAssets, modelAssetSource } from '@aervox/live2d/build-assets'
import { copyCubismCore } from '@aervox/live2d/build-cubism-core'

const publicDir = fileURLToPath(new URL('../src/renderer/public/', import.meta.url))
copyPublicAssets(publicDir, { includeIntro: true })
copyModelAssets(modelAssetSource, [join(publicDir, 'live2d')])
// Cubism Core 随包分发：运行时不再从 cubism.live2d.com 拉取（离线与本地数据边界）。
copyCubismCore(join(publicDir, 'vendor'))
