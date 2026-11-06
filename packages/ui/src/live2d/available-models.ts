import { DEFAULT_AERVOX_MODEL, type AervoxLive2DModel } from './model'

/** Only models bundled and supported by this application are selectable. */
const availableModels: readonly AervoxLive2DModel[] = Object.freeze([
  Object.freeze({ ...DEFAULT_AERVOX_MODEL }),
])

export function getAvailableLive2DModels(): readonly AervoxLive2DModel[] {
  return availableModels
}

/** Missing references remain in the persona revision; resolution never writes them. */
export function resolveCompanionModel(modelId?: string): { model: AervoxLive2DModel; missing: boolean } {
  const selected = availableModels.find(model => model.id === modelId)
  return { model: selected ?? DEFAULT_AERVOX_MODEL, missing: modelId !== undefined && !selected }
}
