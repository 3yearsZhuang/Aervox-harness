import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { copyPublicAssets } from '@aervox/public/build-assets'
import { copyModelAssets, modelAssetSource } from '@aervox/live2d/build-assets'

const publicDir = fileURLToPath(new URL('../public/', import.meta.url))
copyPublicAssets(publicDir, { includeIntro: false })
copyModelAssets(modelAssetSource, [join(publicDir, 'live2d')])
