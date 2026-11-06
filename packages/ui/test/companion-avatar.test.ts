import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { configureAervoxClient } from '@aervox/api-client'
import { DEFAULT_AERVOX_MODEL } from '../src/live2d/model'
import { getAvailableLive2DModels, resolveCompanionModel } from '../src/live2d/available-models'

const mock = vi.hoisted(() => ({ load: vi.fn(), instances: [] as Array<{ load: ReturnType<typeof vi.fn>; destroy: ReturnType<typeof vi.fn> }> }))
vi.mock('../src/live2d/controller', () => ({
  AervoxLive2DController: class {
    load = vi.fn((...args: unknown[]) => mock.load(...args))
    destroy = vi.fn()
    constructor() { mock.instances.push(this) }
  },
}))
import CompanionAvatar from '../src/components/CompanionAvatar.vue'

enableAutoUnmount(afterEach)
beforeEach(() => {
  mock.load.mockReset()
  mock.instances.length = 0
  configureAervoxClient({ platform: {} })
})
afterEach(() => { vi.restoreAllMocks(); delete window.aervoxLive2D })

it('offers only the bundled Mizuki model and leaves missing references unresolved in storage', () => {
  expect(getAvailableLive2DModels()).toEqual([DEFAULT_AERVOX_MODEL])
  expect(Object.isFrozen(getAvailableLive2DModels())).toBe(true)
  expect(resolveCompanionModel()).toEqual({ model: DEFAULT_AERVOX_MODEL, missing: false })
  expect(resolveCompanionModel('uninstalled-model')).toEqual({ model: DEFAULT_AERVOX_MODEL, missing: true })
})

it('loads Mizuki by default and shows only neutral status during loading and failure', async () => {
  let reject!: (cause: Error) => void
  mock.load.mockImplementation(() => new Promise((_resolve, failed) => { reject = failed }))
  const wrapper = mount(CompanionAvatar)
  expect(mock.load).toHaveBeenCalledWith(DEFAULT_AERVOX_MODEL, { diversifyIdle: true })
  expect(wrapper.get('[data-status="loading"]').text()).toContain('正在加载 Mizuki')
  expect(wrapper.find('img, svg, .sprite-pet, .pet-hero').exists()).toBe(false)
  reject(new Error('GPU unavailable'))
  await flushPromises()
  expect(wrapper.get('[data-status="error"]').text()).toContain('Mizuki 暂时无法加载')
  expect(wrapper.get('.aervox-live2d-pet__canvas').classes()).toContain('is-pending')
  expect(wrapper.find('img, svg, .sprite-pet, .pet-hero').exists()).toBe(false)
  expect(window.aervoxLive2D).toBeUndefined()
})

it('retries with a fresh controller and hands over to the Live2D canvas after success', async () => {
  mock.load.mockRejectedValueOnce(new Error('GPU unavailable')).mockResolvedValueOnce(undefined)
  const wrapper = mount(CompanionAvatar)
  await flushPromises()
  expect(mock.instances[0].destroy).toHaveBeenCalledOnce()
  await wrapper.get('.aervox-live2d-pet__status button').trigger('click')
  await flushPromises()
  expect(mock.instances).toHaveLength(2)
  expect(mock.instances.every(controller => controller.load.mock.calls.length === 1)).toBe(true)
  expect(wrapper.get('[data-status="ready"]').exists()).toBe(true)
  expect(wrapper.find('.aervox-live2d-pet__status').exists()).toBe(false)
  expect(wrapper.get('.aervox-live2d-pet__canvas').classes()).not.toContain('is-pending')
})

it('still loads the real model under reduced-motion preference', async () => {
  vi.spyOn(window, 'matchMedia').mockReturnValue({ matches: true } as MediaQueryList)
  mock.load.mockResolvedValue(undefined)
  const wrapper = mount(CompanionAvatar)
  await flushPromises()
  expect(mock.load).toHaveBeenCalledWith(DEFAULT_AERVOX_MODEL, { diversifyIdle: false })
  expect(wrapper.get('[data-status="ready"]').exists()).toBe(true)
})

it('keeps a newer model and its API when an older model finishes loading late', async () => {
  let finishOld!: () => void
  mock.load.mockImplementationOnce(() => new Promise<void>(resolve => { finishOld = resolve })).mockResolvedValueOnce(undefined)
  const wrapper = mount(CompanionAvatar)
  // A second definition exercises the renderer contract, not the selectable catalog.
  const replacement = { ...DEFAULT_AERVOX_MODEL, id: 'test-replacement' }
  await wrapper.setProps({ model: replacement })
  await flushPromises()
  const currentApi = window.aervoxLive2D
  expect(currentApi).toBeDefined()
  expect(mock.instances[0].destroy).toHaveBeenCalledOnce()
  finishOld()
  await flushPromises()
  expect(window.aervoxLive2D).toBe(currentApi)
  expect(wrapper.attributes('data-model-id')).toBe('test-replacement')
  expect(wrapper.get('[data-status="ready"]').exists()).toBe(true)
})

it('shows an unavailable binding notice without adding a placeholder and lets a failed binding refresh retry', async () => {
  mock.load.mockResolvedValue(undefined)
  const wrapper = mount(CompanionAvatar, { props: { bindingState: 'missing' } })
  await flushPromises()
  expect(wrapper.text()).toContain('绑定的形象不可用，正在使用 Mizuki')
  await wrapper.setProps({ bindingState: 'error' })
  await wrapper.get('.aervox-companion-avatar__notice button').trigger('click')
  expect(wrapper.emitted('retryBinding')).toHaveLength(1)
  expect(wrapper.find('img, svg, .sprite-pet, .pet-hero').exists()).toBe(false)
})

it('removes the retired hero and fallback implementation from every shared source entry', () => {
  const root = path.resolve(__dirname, '../src')
  const files = readdirSync(root, { recursive: true }).map(file => String(file)).filter(file => /\.(ts|vue|css)$/.test(file))
  for (const file of files) {
    expect(readFileSync(path.join(root, file), 'utf8'), file).not.toMatch(/PetHero|PetWithFallback|hero\.css|--avx-hero-/)
  }
  expect(existsSync(path.join(root, 'components/PetHero.vue'))).toBe(false)
  expect(existsSync(path.join(root, 'components/PetWithFallback.vue'))).toBe(false)
  expect(existsSync(path.join(root, 'theme/hero.css'))).toBe(false)
  expect(existsSync(path.join(root, 'components/SpritePet.vue'))).toBe(true)
})
