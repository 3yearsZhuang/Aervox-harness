// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { configureAervoxClient } from '@aervox/api-client'
import { DEFAULT_AERVOX_MODEL } from '@aervox/ui/live2d/model'

const renderer = vi.hoisted(() => ({ load: vi.fn(), destroy: vi.fn() }))
vi.mock('../../../packages/ui/src/live2d/controller', () => ({
  AervoxLive2DController: class { load = renderer.load; destroy = renderer.destroy },
}))
vi.mock('@aervox/api-client', async importOriginal => ({
  ...await importOriginal<typeof import('@aervox/api-client')>(),
  useAervoxLLM: () => ({
    presetProviders: [],
    loadProviders: async () => [],
    getConfig: async () => { throw new Error('First launch') },
  }),
}))
import OnboardingFlow from '../src/renderer/src/components/OnboardingFlow.vue'

enableAutoUnmount(afterEach)
afterEach(() => { vi.restoreAllMocks(); delete window.aervoxLive2D })

it('uses Mizuki in onboarding and offers retry without displaying a companion mark as a failed character', async () => {
  configureAervoxClient({ platform: {} })
  renderer.load.mockRejectedValue(new Error('GPU unavailable'))
  const wrapper = mount(OnboardingFlow)
  await flushPromises()
  expect(renderer.load).toHaveBeenCalledWith(DEFAULT_AERVOX_MODEL, { diversifyIdle: true })
  const character = wrapper.get('.welcome-character')
  expect(character.get('[data-status="error"]').text()).toContain('重试加载')
  expect(character.find('img, svg, .aervox-companion-mark, .character-fallback').exists()).toBe(false)
  expect(wrapper.get('.brand-mark .aervox-brand-mark').exists()).toBe(true)
})
