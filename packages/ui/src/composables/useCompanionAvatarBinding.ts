import { getClientTransport, subscribePersonaChanges, useAervoxPersonas } from '@aervox/api-client'
import { onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { resolveCompanionModel } from '../live2d/available-models'
import { DEFAULT_AERVOX_MODEL, type AervoxLive2DModel } from '../live2d/model'

export type CompanionAvatarBindingState = 'loading' | 'default' | 'bound' | 'missing' | 'error'

/** Project the active revision's visual binding through the view's captured host. */
export function useCompanionAvatarBinding() {
  const transport = getClientTransport()
  const personas = useAervoxPersonas()
  const model = shallowRef<AervoxLive2DModel>(DEFAULT_AERVOX_MODEL)
  const state = ref<CompanionAvatarBindingState>('loading')
  const requestedModelId = ref<string>()
  let generation = 0
  let disposed = false
  let unsubscribe: (() => void) | undefined

  const refresh = async (): Promise<void> => {
    if (disposed) return
    const current = ++generation
    state.value = 'loading'
    try {
      await personas.loadPersonas()
      if (disposed || current !== generation) return
      // loadPersonas retains its last projection on failure. Never resolve it
      // as if this foreground validation had succeeded.
      if (personas.error.value) throw new Error(personas.error.value)
      const active = personas.activePersona.value
      if (!active) {
        model.value = DEFAULT_AERVOX_MODEL
        requestedModelId.value = undefined
        state.value = 'default'
        return
      }
      const { personaId, revisionId } = active
      const detail = await personas.getPersonaDetail(personaId, { revisionId })
      if (disposed || current !== generation) return
      if (detail.persona.id !== personaId || detail.revision?.personaId !== personaId || detail.revision.id !== revisionId) {
        throw new Error('PERSONA_REVISION_MISMATCH')
      }
      const modelId = detail.revision.config.live2dModelId
      const resolved = resolveCompanionModel(modelId)
      requestedModelId.value = modelId
      model.value = resolved.model
      state.value = resolved.missing ? 'missing' : modelId ? 'bound' : 'default'
    } catch {
      if (!disposed && current === generation) state.value = 'error'
    }
  }

  const revalidate = () => { void refresh() }
  const onVisibility = () => { if (!document.hidden) revalidate() }

  onMounted(() => {
    unsubscribe = subscribePersonaChanges(revalidate, transport)
    window.addEventListener('focus', revalidate)
    document.addEventListener('visibilitychange', onVisibility)
    revalidate()
  })
  onBeforeUnmount(() => {
    disposed = true
    generation++
    unsubscribe?.()
    window.removeEventListener('focus', revalidate)
    document.removeEventListener('visibilitychange', onVisibility)
  })

  return { model, state, requestedModelId, refresh }
}
