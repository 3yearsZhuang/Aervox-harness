import { afterEach, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { AERVOX_CLIENT, createAervoxClient, notifyPersonaChanged, useAervoxPersonas, type AervoxTransport } from '@aervox/api-client'
import type { Persona, PersonaDetailResponse, PersonaListResponse } from '@aervox/contracts'
import { useCompanionAvatarBinding } from '../src/composables/useCompanionAvatarBinding'
import { DEFAULT_AERVOX_MODEL } from '../src/live2d/model'

enableAutoUnmount(afterEach)
afterEach(() => { vi.restoreAllMocks() })
const now = '2026-11-06T00:00:00.000Z'
function persona(personaId = 'persona-a'): Persona {
  return { id: personaId, workspaceId: 'local', subjectUserId: 'default', name: 'Persona', description: '', source: 'user_created', status: 'active', reviewStatus: 'draft', reviewNotes: '', reviewedAt: null, currentRevisionId: 'latest-revision', createdAt: now, updatedAt: now }
}
function list(personaId = 'persona-a', revisionId = 'active-revision'): PersonaListResponse {
  return { personas: [persona(personaId)], active: { workspaceId: 'local', subjectUserId: 'default', personaId, revisionId, selectedAt: now } }
}
function detail(modelId?: string, personaId = 'persona-a', revisionId = 'active-revision'): PersonaDetailResponse {
  return { persona: persona(personaId), active: true, revision: { id: revisionId, personaId, revision: 1, config: { systemPromptAppend: 'Persona instruction', ...(modelId === undefined ? {} : { live2dModelId: modelId }) }, checksum: 'a'.repeat(64), createdAt: now } }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(request: ReturnType<typeof vi.fn>) {
  const transport = { request } as unknown as AervoxTransport
  let binding!: ReturnType<typeof useCompanionAvatarBinding>
  let mutations!: ReturnType<typeof useAervoxPersonas>
  const wrapper = mount(defineComponent({ setup() { binding = useCompanionAvatarBinding(); mutations = useAervoxPersonas(); return () => h('div') } }), {
    global: { provide: { [AERVOX_CLIENT as symbol]: createAervoxClient({ transport }) } },
  })
  return { wrapper, binding, transport, mutations }
}

it('resolves only the exact active revision, even when the persona has a newer revision', async () => {
  const request = vi.fn().mockResolvedValueOnce(list()).mockResolvedValueOnce(detail('mizuki-default'))
  const { binding } = fixture(request)
  await flushPromises()
  expect(request.mock.calls.map(call => call.slice(0, 2))).toEqual([
    ['GET', '/v1/personas'], ['GET', '/v1/personas/persona-a?revisionId=active-revision'],
  ])
  expect(binding.state.value).toBe('bound')
  expect(binding.model.value).toEqual(DEFAULT_AERVOX_MODEL)
})

it.each([undefined, 'removed-model'])('uses Mizuki for an omitted or missing binding and never writes its stored reference (%s)', async modelId => {
  const request = vi.fn().mockResolvedValueOnce(list()).mockResolvedValueOnce(detail(modelId))
  const { binding } = fixture(request)
  await flushPromises()
  expect(binding.model.value).toEqual(DEFAULT_AERVOX_MODEL)
  expect(binding.requestedModelId.value).toBe(modelId)
  expect(binding.state.value).toBe(modelId ? 'missing' : 'default')
  expect(request.mock.calls.every(([method]) => method === 'GET')).toBe(true)
})

it('uses the default when no persona is active without reading a latest revision', async () => {
  const request = vi.fn().mockResolvedValue({ personas: [], active: null })
  const { binding } = fixture(request)
  await flushPromises()
  expect(request).toHaveBeenCalledOnce()
  expect(binding.state.value).toBe('default')
})

it.each([
  detail('removed-model', 'other-persona'),
  detail('removed-model', 'persona-a', 'latest-revision'),
  { ...detail(), revision: null },
])('rejects persona or revision mismatches rather than taking a latest binding', async response => {
  const request = vi.fn().mockResolvedValueOnce(list()).mockResolvedValueOnce(response)
  const { binding } = fixture(request)
  await flushPromises()
  expect(binding.state.value).toBe('error')
  expect(binding.requestedModelId.value).toBeUndefined()
})

it('does not let an old persona detail replace a newer selection after invalidation', async () => {
  const old = deferred<PersonaDetailResponse>()
  const request = vi.fn().mockResolvedValueOnce(list()).mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(list('persona-b', 'revision-b')).mockResolvedValueOnce(detail('mizuki-default', 'persona-b', 'revision-b'))
  const { binding, transport } = fixture(request)
  await flushPromises()
  notifyPersonaChanged(transport)
  await flushPromises()
  expect(binding.state.value).toBe('bound')
  old.resolve(detail('removed-model'))
  await flushPromises()
  expect(binding.state.value).toBe('bound')
  expect(binding.requestedModelId.value).toBe('mizuki-default')
})

it('ignores an older list response after a newer refresh has selected another persona', async () => {
  const old = deferred<PersonaListResponse>()
  const request = vi.fn().mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(list('persona-b', 'revision-b')).mockResolvedValueOnce(detail('mizuki-default', 'persona-b', 'revision-b'))
  const { binding, transport } = fixture(request)
  notifyPersonaChanged(transport)
  await flushPromises()
  old.resolve(list())
  await flushPromises()
  expect(binding.state.value).toBe('bound')
  expect(request.mock.calls.some(([, route]) => route.includes('persona-a?'))).toBe(false)
})

it.each(['activate', 'update', 'delete', 'import'] as const)('refreshes the active binding after a successful %s mutation from another view', async operation => {
  let changed = false
  const request = vi.fn(async (method: string, route: string) => {
    if (method === 'GET' && route === '/v1/personas') return changed && operation === 'delete' ? { personas: [], active: null } : list()
    if (method === 'GET') return detail(changed ? 'mizuki-default' : 'removed-model')
    changed = true
    if (operation === 'activate') return list().active
    if (operation === 'delete') return { deleted: true, personaId: 'persona-a' }
    const response = detail('mizuki-default')
    return { persona: response.persona, revision: response.revision, ...(operation === 'import' ? { skills: [], missingDependencies: [] } : {}) }
  })
  const { binding, mutations } = fixture(request)
  await flushPromises()
  expect(binding.state.value).toBe('missing')
  if (operation === 'activate') await mutations.activatePersona('persona-a', 'active-revision')
  if (operation === 'update') await mutations.updatePersona('persona-a', { expectedRevision: 1, config: { systemPromptAppend: 'Saved instruction', live2dModelId: 'mizuki-default' } })
  if (operation === 'delete') await mutations.deletePersona('persona-a')
  if (operation === 'import') await mutations.importPersona('encoded-persona')
  await flushPromises()
  expect(binding.state.value).toBe(operation === 'delete' ? 'default' : 'bound')
  expect(binding.requestedModelId.value).toBe(operation === 'delete' ? undefined : 'mizuki-default')
})

it('does not resolve a list response or detail that arrives after unmount', async () => {
  const lateList = deferred<PersonaListResponse>()
  const first = fixture(vi.fn().mockReturnValueOnce(lateList.promise))
  first.wrapper.unmount()
  lateList.resolve(list())
  await flushPromises()
  expect(first.binding.state.value).toBe('loading')

  const lateDetail = deferred<PersonaDetailResponse>()
  const request = vi.fn().mockResolvedValueOnce(list()).mockReturnValueOnce(lateDetail.promise)
  const second = fixture(request)
  await flushPromises()
  second.wrapper.unmount()
  lateDetail.resolve(detail('removed-model'))
  await flushPromises()
  expect(second.binding.requestedModelId.value).toBeUndefined()
  notifyPersonaChanged(second.transport)
  await second.binding.refresh()
  expect(request).toHaveBeenCalledTimes(2)
})

it('retains the last validated binding on a read failure and retries with fresh data', async () => {
  const request = vi.fn().mockResolvedValueOnce(list()).mockResolvedValueOnce(detail('removed-model'))
    .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ personas: [], active: null })
  const { binding } = fixture(request)
  await flushPromises()
  await binding.refresh()
  expect(binding.state.value).toBe('error')
  expect(binding.requestedModelId.value).toBe('removed-model')
  await binding.refresh()
  expect(binding.state.value).toBe('default')
  expect(binding.requestedModelId.value).toBeUndefined()
})

it('revalidates on focus and visibility while keeping notifications scoped to the captured transport', async () => {
  const request = vi.fn().mockResolvedValue({ personas: [], active: null })
  const otherRequest = vi.fn().mockResolvedValue({ personas: [], active: null })
  const first = fixture(request)
  const second = fixture(otherRequest)
  await flushPromises()
  notifyPersonaChanged(second.transport)
  await flushPromises()
  expect(request).toHaveBeenCalledTimes(1)
  expect(otherRequest).toHaveBeenCalledTimes(2)
  window.dispatchEvent(new Event('focus'))
  await flushPromises()
  expect(request).toHaveBeenCalledTimes(2)
  const visibility = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
  document.dispatchEvent(new Event('visibilitychange'))
  await flushPromises()
  expect(request).toHaveBeenCalledTimes(2)
  visibility.mockReturnValue(false)
  document.dispatchEvent(new Event('visibilitychange'))
  await flushPromises()
  expect(request).toHaveBeenCalledTimes(3)
  first.wrapper.unmount()
  second.wrapper.unmount()
  window.dispatchEvent(new Event('focus'))
  document.dispatchEvent(new Event('visibilitychange'))
  await flushPromises()
  expect(request).toHaveBeenCalledTimes(3)
})
