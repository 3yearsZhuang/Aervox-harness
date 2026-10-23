import { readFileSync, statSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { modelAssetSource } from './copy-assets.mjs'
const model = JSON.parse(readFileSync(join(modelAssetSource, 'mizuki.model3.json'), 'utf8'))
const references = model.FileReferences
const files = [references.Moc, references.Physics, ...references.Textures,
  ...Object.values(references.Motions).flat().map(motion => motion.File)]
for (const file of files) {
  const resolved = resolve(modelAssetSource, file)
  const rel = relative(modelAssetSource, resolved)
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !statSync(resolved).isFile()) throw new Error(`Invalid model reference: ${file}`)
}
