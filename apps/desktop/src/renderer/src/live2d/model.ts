export interface CubismMotionReference {
  File: string
  Sound?: string
  Name?: string
  FadeInTime?: number
  FadeOutTime?: number
}

export interface CubismExpressionReference {
  File: string
  Name?: string
}

export interface CubismFileReferences {
  Moc: string
  Textures: string[]
  Physics?: string
  DisplayInfo?: string
  Motions?: Record<string, CubismMotionReference[]>
  Expressions?: CubismExpressionReference[] | Record<string, never>
  Pose?: string
  UserData?: string
}

export interface CubismModel3Json {
  Version: 3
  FileReferences: CubismFileReferences
  Groups?: Array<{ Target: string; Name: string; Ids?: string[] }>
  name?: string
}

export interface AervoxLive2DModel {
  id: string
  displayName: string
  modelUrl: string
  /** Optional initial scale multiplier for assets with different canvas bounds. */
  scale?: number
  motionDataUrl?: string
  additionalMotionDataUrl?: string
}

export interface Live2DModelCatalogEntry {
  modelName: string
  modelBase: string
  modelPath: string
  modelFile: string
}

export const LIVE2D_MODEL_CATALOG_URL = 'https://storage.sekai.best/sekai-live2d-assets/live2d/model_list.json'

export async function fetchLive2DModelCatalog(url = LIVE2D_MODEL_CATALOG_URL): Promise<Live2DModelCatalogEntry[]> {
  const response = await fetch(url, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Live2D model catalog request failed (HTTP ${response.status})`)
  const value = await response.json()
  if (!Array.isArray(value)) throw new Error('Live2D model catalog must be an array')
  return value.filter((entry): entry is Live2DModelCatalogEntry =>
    !!entry && typeof entry === 'object' && typeof entry.modelName === 'string' && typeof entry.modelPath === 'string' && typeof entry.modelFile === 'string')
}

export async function findLive2DModelCatalogEntry(modelName: string, url = LIVE2D_MODEL_CATALOG_URL): Promise<Live2DModelCatalogEntry | undefined> {
  const catalog = await fetchLive2DModelCatalog(url)
  return catalog.find((entry) => entry.modelName === modelName)
}

export type Live2DPose = {
  motion?: MizukiMotion | string
  expression?: MizukiExpression | string
}

export enum MizukiMotion {
  w_adult_blushed01 = 'w-adult-blushed01', w_adult_blushed02 = 'w-adult-blushed02', w_adult_blushed03 = 'w-adult-blushed03', w_adult_blushed04 = 'w-adult-blushed04',
  w_adult_delicious01 = 'w-adult-delicious01', w_adult_delicious02 = 'w-adult-delicious02', w_adult_delicious03 = 'w-adult-delicious03', w_adult_glad01 = 'w-adult-glad01', w_adult_glad02 = 'w-adult-glad02', w_adult_glad03 = 'w-adult-glad03',
  w_adult_nod01 = 'w-adult-nod01', w_adult_nod02 = 'w-adult-nod02', w_adult_nod03 = 'w-adult-nod03', w_adult_nod04 = 'w-adult-nod04', w_adult_nod05 = 'w-adult-nod05', w_adult_posenod02 = 'w-adult-posenod02', w_adult_posetilthead01 = 'w-adult-posetilthead01', w_adult_posetilthead03 = 'w-adult-posetilthead03', w_adult_posetrouble02 = 'w-adult-posetrouble02', w_adult_relief01 = 'w-adult-relief01', w_adult_shakehand01 = 'w-adult-shakehand01', w_adult_shakehead01 = 'w-adult-shakehead01', w_adult_think01 = 'w-adult-think01', w_adult_think02 = 'w-adult-think02', w_adult_tilthead01 = 'w-adult-tilthead01', w_adult_tilthead02 = 'w-adult-tilthead02', w_adult_tilthead03 = 'w-adult-tilthead03', w_adult_tilthead04 = 'w-adult-tilthead04', w_adult_tilthead05 = 'w-adult-tilthead05', w_adult_trouble01 = 'w-adult-trouble01', w_adult_trouble02 = 'w-adult-trouble02',
  w_animal_fidget01 = 'w-animal-fidget01', w_animal_fidget02 = 'w-animal-fidget02', w_animal_lookaway01 = 'w-animal-lookaway01', w_animal_nod01 = 'w-animal-nod01', w_animal_nod02 = 'w-animal-nod02', w_animal_nodtilthead0101 = 'w-animal-nodtilthead0101', w_animal_posenod01 = 'w-animal-posenod01', w_animal_shy01 = 'w-animal-shy01', w_animal_tilthead01 = 'w-animal-tilthead01', w_animal_tiltheadnod0101 = 'w-animal-tiltheadnod0101', w_animalnormal_nodtilthead0101 = 'w-animalnormal-nodtilthead0101',
  w_cool_angry01 = 'w-cool-angry01', w_cool_blushed01 = 'w-cool-blushed01', w_cool_forward01 = 'w-cool-forward01', w_cool_forward02 = 'w-cool-forward02', w_cool_glad01 = 'w-cool-glad01', w_cool_nod01 = 'w-cool-nod01', w_cool_nod02 = 'w-cool-nod02', w_cool_nod03 = 'w-cool-nod03', w_cool_nodtilthead0102 = 'w-cool-nodtilthead0102', w_cool_posenod01 = 'w-cool-posenod01', w_cool_posenod02 = 'w-cool-posenod02', w_cool_posenod03 = 'w-cool-posenod03', w_cool_posesad01 = 'w-cool-posesad01', w_cool_posetilthead03 = 'w-cool-posetilthead03', w_cool_posetilthead04 = 'w-cool-posetilthead04', w_cool_sad01 = 'w-cool-sad01', w_cool_shakehand01 = 'w-cool-shakehand01', w_cool_shakehead01 = 'w-cool-shakehead01', w_cool_shakehead02 = 'w-cool-shakehead02', w_cool_sigh01 = 'w-cool-sigh01', w_cool_sigh02 = 'w-cool-sigh02', w_cool_tilthead01 = 'w-cool-tilthead01', w_cool_tilthead0102 = 'w-cool-tilthead0102', w_cool_tilthead02 = 'w-cool-tilthead02', w_cool_tilthead0201 = 'w-cool-tilthead0201', w_cool_tilthead0204 = 'w-cool-tilthead0204', w_cool_tilthead03 = 'w-cool-tilthead03', w_cool_tilthead04 = 'w-cool-tilthead04', w_cool_tilthead0402 = 'w-cool-tilthead0402', w_cool_tiltheadnod0201 = 'w-cool-tiltheadnod0201', w_cool_trouble01 = 'w-cool-trouble01',
  w_cute_angry01 = 'w-cute-angry01', w_cute_delicious01 = 'w-cute-delicious01', w_cute_delicious02 = 'w-cute-delicious02', w_cute_fidget01 = 'w-cute-fidget01', w_cute_forward01 = 'w-cute-forward01', w_cute_forward02 = 'w-cute-forward02', w_cute_forward03 = 'w-cute-forward03', w_cute_forward03r = 'w-cute-forward03r', w_cute_glad01 = 'w-cute-glad01', w_cute_glad02 = 'w-cute-glad02', w_cute_glad03 = 'w-cute-glad03', w_cute_glad04 = 'w-cute-glad04', w_cute_glad05 = 'w-cute-glad05', w_cute_glad06 = 'w-cute-glad06', w_cute_glad06r = 'w-cute-glad06r', w_cute_nod01 = 'w-cute-nod01', w_cute_nod02 = 'w-cute-nod02', w_cute_nod03 = 'w-cute-nod03', w_cute_nod04 = 'w-cute-nod04', w_cute_nod05 = 'w-cute-nod05', w_cute_nod06 = 'w-cute-nod06', w_cute_poseforward02 = 'w-cute-poseforward02', w_cute_posenod01 = 'w-cute-posenod01', w_cute_posenod02 = 'w-cute-posenod02', w_cute_posetilthead04 = 'w-cute-posetilthead04', w_cute_posetilthead07 = 'w-cute-posetilthead07', w_cute_posetilthead08 = 'w-cute-posetilthead08', w_cute_shakehead01 = 'w-cute-shakehead01', w_cute_shakehead02 = 'w-cute-shakehead02', w_cute_shakehead03 = 'w-cute-shakehead03', w_cute_shy01 = 'w-cute-shy01', w_cute_shy02 = 'w-cute-shy02', w_cute_shy03 = 'w-cute-shy03', w_cute_sleep01 = 'w-cute-sleep01', w_cute_sleep02 = 'w-cute-sleep02', w_cute_sleep03_nb = 'w-cute-sleep03_nb', w_cute_smug01 = 'w-cute-smug01', w_cute_tilthead01 = 'w-cute-tilthead01', w_cute_tilthead02 = 'w-cute-tilthead02', w_cute_tilthead0203 = 'w-cute-tilthead0203', w_cute_tilthead0207 = 'w-cute-tilthead0207', w_cute_tilthead03 = 'w-cute-tilthead03', w_cute_tilthead0302 = 'w-cute-tilthead0302', w_cute_tilthead0308 = 'w-cute-tilthead0308', w_cute_tilthead04 = 'w-cute-tilthead04', w_cute_tilthead05 = 'w-cute-tilthead05', w_cute_tilthead06 = 'w-cute-tilthead06', w_cute_tilthead07 = 'w-cute-tilthead07', w_cute_tilthead0702 = 'w-cute-tilthead0702', w_cute_tilthead0708 = 'w-cute-tilthead0708', w_cute_tilthead08 = 'w-cute-tilthead08', w_cute_tilthead0803 = 'w-cute-tilthead0803', w_cute_tilthead0807 = 'w-cute-tilthead0807', w_cute_tilthead09 = 'w-cute-tilthead09', w_cute_wink01 = 'w-cute-wink01', w_cute_wink02 = 'w-cute-wink02', w_cutehappy_shakeheadsad0201 = 'w-cutehappy-shakeheadsad0201', w_cutenormal_tilthead0705 = 'w-cutenormal-tilthead0705',
  w_happy_angry01 = 'w-happy-angry01', w_happy_angry02 = 'w-happy-angry02', w_happy_forward01 = 'w-happy-forward01', w_happy_forward02 = 'w-happy-forward02', w_happy_glad01 = 'w-happy-glad01', w_happy_glad02 = 'w-happy-glad02', w_happy_lookaway01 = 'w-happy-lookaway01', w_happy_nod01 = 'w-happy-nod01', w_happy_nod02 = 'w-happy-nod02', w_happy_nod03 = 'w-happy-nod03', w_happy_nod04 = 'w-happy-nod04', w_happy_nod05 = 'w-happy-nod05', w_happy_poseglad02 = 'w-happy-poseglad02', w_happy_posenod03 = 'w-happy-posenod03', w_happy_posetilthead02 = 'w-happy-posetilthead02', w_happy_purpose01 = 'w-happy-purpose01', w_happy_sad01 = 'w-happy-sad01', w_happy_sad02 = 'w-happy-sad02', w_happy_shakehand01 = 'w-happy-shakehand01', w_happy_shakehead01 = 'w-happy-shakehead01', w_happy_shakehead02 = 'w-happy-shakehead02', w_happy_shakehead03 = 'w-happy-shakehead03', w_happy_shakehead05 = 'w-happy-shakehead05', w_happy_sigh01 = 'w-happy-sigh01', w_happy_tilthead01 = 'w-happy-tilthead01', w_happy_tilthead02 = 'w-happy-tilthead02', w_happy_tilthead03 = 'w-happy-tilthead03', w_happy_tilthead04 = 'w-happy-tilthead04', w_happy_wandahoi01 = 'w-happy-wandahoi01',
  w_normal_angry01 = 'w-normal-angry01', w_normal_armescape01l = 'w-normal-armescape01l', w_normal_armescape01n = 'w-normal-armescape01n', w_normal_armescape01r = 'w-normal-armescape01r', w_normal_armescape02l = 'w-normal-armescape02l', w_normal_armescape02n = 'w-normal-armescape02n', w_normal_armescape02r = 'w-normal-armescape02r', w_normal_armescape03ll = 'w-normal-armescape03ll', w_normal_armescape03ln = 'w-normal-armescape03ln', w_normal_armescape03lr = 'w-normal-armescape03lr', w_normal_armescape03rl = 'w-normal-armescape03rl', w_normal_armescape03rn = 'w-normal-armescape03rn', w_normal_armescape03rr = 'w-normal-armescape03rr', w_normal_armescape04ll = 'w-normal-armescape04ll', w_normal_armescape04ln = 'w-normal-armescape04ln', w_normal_armescape04lr = 'w-normal-armescape04lr', w_normal_armescape04rl = 'w-normal-armescape04rl', w_normal_armescape04rn = 'w-normal-armescape04rn', w_normal_armescape04rr = 'w-normal-armescape04rr', w_normal_blushed01 = 'w-normal-blushed01', w_normal_default01 = 'w-normal-default01', w_normal_fidget01 = 'w-normal-fidget01', w_normal_forward01 = 'w-normal-forward01', w_normal_forward02 = 'w-normal-forward02', w_normal_forward03 = 'w-normal-forward03', w_normal_glad01 = 'w-normal-glad01', w_normal_glad02 = 'w-normal-glad02', w_normal_greeting01 = 'w-normal-greeting01', w_normal_lookaway01 = 'w-normal-lookaway01', w_normal_nod01 = 'w-normal-nod01', w_normal_nod01r = 'w-normal-nod01r', w_normal_nod02 = 'w-normal-nod02', w_normal_nod03 = 'w-normal-nod03', w_normal_nod0301 = 'w-normal-nod0301', w_normal_nod04 = 'w-normal-nod04', w_normal_nod05 = 'w-normal-nod05', w_normal_nod06 = 'w-normal-nod06', w_normal_pose01 = 'w-normal-pose01', w_normal_pose02 = 'w-normal-pose02', w_normal_pose03 = 'w-normal-pose03', w_normal_pose04 = 'w-normal-pose04', w_normal_pose05 = 'w-normal-pose05', w_normal_pose06 = 'w-normal-pose06', w_normal_posenod02 = 'w-normal-posenod02', w_normal_posetrouble02 = 'w-normal-posetrouble02', w_normal_purpose01 = 'w-normal-purpose01', w_normal_relief01 = 'w-normal-relief01', w_normal_sad01 = 'w-normal-sad01', w_normal_shakehead01 = 'w-normal-shakehead01', w_normal_shakehead01r = 'w-normal-shakehead01r', w_normal_shakehead02 = 'w-normal-shakehead02', w_normal_shakehead03 = 'w-normal-shakehead03', w_normal_shakehead04 = 'w-normal-shakehead04', w_normal_shakehead05 = 'w-normal-shakehead05', w_normal_shakehead06 = 'w-normal-shakehead06', w_normal_shakehead06r = 'w-normal-shakehead06r', w_normal_shy01 = 'w-normal-shy01', w_normal_sigh01 = 'w-normal-sigh01', w_normal_tilthead01 = 'w-normal-tilthead01', w_normal_tilthead0103 = 'w-normal-tilthead0103', w_normal_tilthead0106 = 'w-normal-tilthead0106', w_normal_tilthead01r = 'w-normal-tilthead01r', w_normal_tilthead02 = 'w-normal-tilthead02', w_normal_tilthead0206 = 'w-normal-tilthead0206', w_normal_tilthead03 = 'w-normal-tilthead03', w_normal_tilthead0301 = 'w-normal-tilthead0301', w_normal_tilthead0302 = 'w-normal-tilthead0302', w_normal_tilthead0305 = 'w-normal-tilthead0305', w_normal_tilthead04 = 'w-normal-tilthead04', w_normal_tilthead0406 = 'w-normal-tilthead0406', w_normal_tilthead05 = 'w-normal-tilthead05', w_normal_tilthead0503 = 'w-normal-tilthead0503', w_normal_tilthead0506 = 'w-normal-tilthead0506', w_normal_tilthead06 = 'w-normal-tilthead06', w_normal_tilthead0601 = 'w-normal-tilthead0601', w_normal_tilthead0602 = 'w-normal-tilthead0602', w_normal_tilthead0605 = 'w-normal-tilthead0605', w_normal_trouble01 = 'w-normal-trouble01', w_normal_trouble02 = 'w-normal-trouble02', w_normal_yurayura01 = 'w-normal-yurayura01', w_normalanimal_tiltheadnod0101 = 'w-normalanimal-tiltheadnod0101', w_normalcool_tilthead0204 = 'w-normalcool-tilthead0204', w_normalcute_nodshakehead0302 = 'w-normalcute-nodshakehead0302',
}

export enum MizukiExpression {
  face_angry_01 = 'face_angry_01', face_angry_02 = 'face_angry_02', face_angry_03 = 'face_angry_03', face_breath_01 = 'face_breath_01', face_closeeye_01 = 'face_closeeye_01', face_closeeye_02 = 'face_closeeye_02', face_closeeye_03 = 'face_closeeye_03', face_closeeye_04 = 'face_closeeye_04', face_coldeyes_01 = 'face_coldeyes_01', face_coldeyes_02 = 'face_coldeyes_02', face_coldeyes_03 = 'face_coldeyes_03', face_cry_01 = 'face_cry_01', face_cry_02 = 'face_cry_02', face_disgust_01 = 'face_disgust_01', face_e_01 = 'face_e_01', face_lookaway_01 = 'face_lookaway_01', face_nhicoldeyes_01 = 'face_nhicoldeyes_01', face_nhinormal_01 = 'face_nhinormal_01', face_nhisad_02 = 'face_nhisad_02', face_nhisad_05 = 'face_nhisad_05', face_normal_01 = 'face_normal_01', face_notice_01 = 'face_notice_01', face_sad_01 = 'face_sad_01', face_sad_02 = 'face_sad_02', face_sad_03 = 'face_sad_03', face_sad_04 = 'face_sad_04', face_sad_05 = 'face_sad_05', face_sad_06 = 'face_sad_06', face_serious_01 = 'face_serious_01', face_shy_01 = 'face_shy_01', face_sleepy_01 = 'face_sleepy_01', face_sleepy_02 = 'face_sleepy_02', face_smallmouth_01 = 'face_smallmouth_01', face_smile_01 = 'face_smile_01', face_smile_02 = 'face_smile_02', face_smile_03 = 'face_smile_03', face_smile_04 = 'face_smile_04', face_smile_05 = 'face_smile_05', face_smile_06 = 'face_smile_06', face_smile_07 = 'face_smile_07', face_smile_08 = 'face_smile_08', face_smile_09 = 'face_smile_09', face_smile_10 = 'face_smile_10', face_smile_11 = 'face_smile_11', face_smile_12 = 'face_smile_12', face_smug_01 = 'face_smug_01', face_sneeze_01 = 'face_sneeze_01', face_sparkling_01 = 'face_sparkling_01', face_surprise_01 = 'face_surprise_01', face_surprise_02 = 'face_surprise_02', face_trouble_01 = 'face_trouble_01', face_trouble_02 = 'face_trouble_02', face_wink_01 = 'face_wink_01', face_worry_01 = 'face_worry_01',
}

export const MIZUKI_MOTIONS = Object.values(MizukiMotion)
export const MIZUKI_EXPRESSIONS = Object.values(MizukiExpression)

export interface ResolvedCubismAsset {
  manifest: CubismModel3Json
  manifestUrl: string
  baseUrl: string
  resolve: (relativePath: string) => string
}

const MODEL_FILE_PATTERN = /\.model3\.json$/i
const OPTIONAL_FILE_REFERENCE_KEYS = ['Physics', 'DisplayInfo', 'Pose', 'UserData'] as const

export function assertModelUrl(modelUrl: string): URL {
  const browserBaseUrl = typeof window === 'undefined' ? 'http://localhost/' : window.location.href
  const url = new URL(modelUrl, browserBaseUrl)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Live2D model URL must use http(s)')
  }
  if (!MODEL_FILE_PATTERN.test(url.pathname)) {
    throw new Error('Live2D model URL must point to a .model3.json file')
  }
  return url
}

export function parseModel3Json(value: unknown, manifestUrl: string): ResolvedCubismAsset {
  if (!value || typeof value !== 'object') throw new Error('Invalid Live2D model manifest')
  const manifest = value as Partial<CubismModel3Json>
  if (manifest.Version !== 3 || !manifest.FileReferences || typeof manifest.FileReferences !== 'object') {
    throw new Error('Unsupported Live2D model manifest; expected Version 3')
  }
  const files = manifest.FileReferences as Partial<CubismFileReferences>
  if (typeof files.Moc !== 'string' || !Array.isArray(files.Textures) || files.Textures.some((file) => typeof file !== 'string')) {
    throw new Error('Live2D model manifest is missing Moc or Textures')
  }
  const manifestUrlObject = assertModelUrl(manifestUrl)
  const baseUrl = new URL('.', manifestUrlObject).toString()
  const resolve = (relativePath: string): string => {
    if (!relativePath || relativePath.includes('\\') || relativePath.startsWith('/')) {
      throw new Error('Live2D asset path must be a relative POSIX path')
    }
    const resolved = new URL(relativePath, baseUrl)
    if (resolved.origin !== manifestUrlObject.origin || !resolved.href.startsWith(baseUrl)) {
      throw new Error('Live2D asset path escapes the model directory')
    }
    return resolved.toString()
  }
  resolve(files.Moc)
  files.Textures.forEach(resolve)
  for (const key of OPTIONAL_FILE_REFERENCE_KEYS) {
    const file = files[key]
    if (file !== undefined) {
      if (typeof file !== 'string') throw new Error(`Live2D model manifest has an invalid ${key} reference`)
      resolve(file)
    }
  }
  if (files.Motions !== undefined) {
    if (typeof files.Motions !== 'object' || Array.isArray(files.Motions)) throw new Error('Live2D model manifest has invalid Motions')
    for (const motions of Object.values(files.Motions)) {
      if (!Array.isArray(motions)) throw new Error('Live2D model manifest has invalid motion group')
      for (const motion of motions) {
        if (!motion || typeof motion.File !== 'string') throw new Error('Live2D model manifest has invalid motion reference')
        resolve(motion.File)
        if (motion.Sound !== undefined) {
          if (typeof motion.Sound !== 'string') throw new Error('Live2D model manifest has invalid motion sound reference')
          resolve(motion.Sound)
        }
      }
    }
  }
  if (files.Expressions !== undefined && !Array.isArray(files.Expressions) && Object.keys(files.Expressions).length !== 0) {
    throw new Error('Live2D model manifest has invalid Expressions')
  }
  if (files.Expressions !== undefined && !Array.isArray(files.Expressions)) {
    delete files.Expressions
  }
  if (Array.isArray(files.Expressions)) {
    for (const expression of files.Expressions) {
      if (!expression || typeof expression.File !== 'string') throw new Error('Live2D model manifest has invalid expression reference')
      resolve(expression.File)
    }
  }
  return {
    manifest: manifest as CubismModel3Json,
    manifestUrl: manifestUrlObject.toString(),
    baseUrl,
    resolve,
  }
}

export async function fetchModel3Json(model: AervoxLive2DModel): Promise<ResolvedCubismAsset> {
  const modelUrl = assertModelUrl(model.modelUrl).toString()
  const response = await fetch(modelUrl, { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Live2D manifest request failed (HTTP ${response.status})`)
  const resolved = parseModel3Json(await response.json(), modelUrl)
  for (const metadataUrl of [model.motionDataUrl, model.additionalMotionDataUrl]) {
    if (metadataUrl) {
      await mergeExternalMotionData(resolved, metadataUrl, {
        includeExpressions: import.meta.env.VITE_AERVOX_LIVE2D_ENABLE_EXPRESSIONS !== 'false',
      })
    }
  }
  return resolved
}

interface ExternalMotionData { motions?: string[]; expressions?: string[] }

export async function mergeExternalMotionData(asset: ResolvedCubismAsset, metadataUrl: string, options: { includeExpressions: boolean }): Promise<void> {
  const url = new URL(metadataUrl, asset.manifestUrl)
  if (url.origin !== new URL(asset.manifestUrl).origin || !url.href.startsWith(asset.baseUrl)) {
    throw new Error('Live2D metadata must stay inside the model directory')
  }
  const response = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
  if (!response.ok) throw new Error(`Live2D motion metadata request failed (HTTP ${response.status})`)
  const metadata = await response.json() as ExternalMotionData
  const references = asset.manifest.FileReferences
  const groups = references.Motions ?? (references.Motions = {})
  const metadataBaseUrl = new URL('.', url.toString()).toString()
  for (const name of metadata.motions ?? []) {
    const motionGroup = groups.Motion ?? (groups.Motion = [])
    const file = name.endsWith('.motion3.json') ? name : `${name}.motion3.json`
    // 模型资产里动作文件实际位于 motion/motion/ 嵌套目录（model3.json 原始 Idle 条目同构），
    // 拼错层级会导致整个 Motion 组 404、所有动作静默失效（与 packages/ui 同步的上游修复）。
    const motionPath = file.includes('/') ? file : `motion/motion/${file}`
    const fileUrl = new URL(motionPath, metadataBaseUrl).toString()
    if (!fileUrl.startsWith(asset.baseUrl)) throw new Error('Live2D motion metadata path escapes the model directory')
    if (!motionGroup.some((motion) => motion.Name === name || motion.File === fileUrl)) motionGroup.push({ Name: name, File: fileUrl })
  }
  if (options.includeExpressions && metadata.expressions?.length) {
    const facialGroup = groups.Facial ?? (groups.Facial = [])
    for (const name of metadata.expressions) {
      const file = name.endsWith('.motion3.json') ? name : `${name}.motion3.json`
      const fileUrl = new URL(`facial/${file}`, metadataBaseUrl).toString()
      if (!fileUrl.startsWith(asset.baseUrl)) throw new Error('Live2D expression metadata path escapes the model directory')
      if (!facialGroup.some((motion) => motion.Name === name || motion.File === fileUrl)) facialGroup.push({ Name: name, File: fileUrl })
    }
  }
}

export const DEFAULT_AERVOX_MODEL: AervoxLive2DModel = {
  id: 'mizuki-default',
  displayName: 'Mizuki',
  modelUrl: '/live2d/mizuki/mizuki.model3.json',
  motionDataUrl: '/live2d/mizuki/BuildMotionData.json',
  scale: 1,
}
