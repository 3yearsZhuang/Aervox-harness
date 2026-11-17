import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AervoxLive2DController } from '../src/live2d/controller'
import type { AervoxLive2DModel } from '../src/live2d/model'

interface ApplicationProbe {
  view: HTMLCanvasElement
  renderer: {
    screen: { width: number; height: number }
    resolution: number
    resize: ReturnType<typeof vi.fn>
  }
  running: boolean
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
}

interface ObserverProbe {
  targets: Set<Element>
  deliver: () => void
}

const mock = vi.hoisted(() => ({
  assets: vi.fn(),
  model: vi.fn(),
  applications: [] as ApplicationProbe[],
  observers: [] as ObserverProbe[],
}))

vi.mock('../src/live2d/model', () => ({ fetchModel3Json: mock.assets }))
vi.mock('@sekai-world/pixi-live2d-display-mulmotion/cubism4', () => ({
  Live2DModel: { from: mock.model },
}))
vi.mock('pixi.js', () => ({
  Container: class {},
  Application: class {
    view = document.createElement('canvas')
    stage = { addChild: vi.fn() }
    ticker = { add: vi.fn(), remove: vi.fn(), start: vi.fn(), stop: vi.fn() }
    renderer: ApplicationProbe['renderer']
    running: boolean
    private target: HTMLElement | Window | null = null
    private resizeFrame: number | null = null
    render = vi.fn()
    start = vi.fn(() => { this.running = true })
    stop = vi.fn(() => { this.running = false })
    destroy = vi.fn(() => {
      window.removeEventListener('resize', this.queueResize)
      this.cancelResize()
      this.target = null
      this.running = false
      this.view.remove()
    })

    constructor(options: { width?: number; height?: number; resolution?: number; autoStart?: boolean; resizeTo?: HTMLElement | Window }) {
      const width = options.width ?? 800
      const height = options.height ?? 600
      const resolution = options.resolution ?? 1
      this.running = options.autoStart !== false
      this.renderer = {
        screen: { width, height },
        resolution,
        resize: vi.fn((nextWidth: number, nextHeight: number) => {
          this.renderer.screen.width = nextWidth
          this.renderer.screen.height = nextHeight
          this.view.width = Math.round(nextWidth * resolution)
          this.view.height = Math.round(nextHeight * resolution)
        }),
      }
      this.view.width = Math.round(width * resolution)
      this.view.height = Math.round(height * resolution)
      mock.applications.push(this)
      this.resizeTo = options.resizeTo ?? null
    }

    // Pixi 7's ResizePlugin resizes once on assignment and again in a queued
    // animation frame after window.resize. This path must not bypass the
    // controller's visibility guard when an ancestor becomes display:none.
    set resizeTo(target: HTMLElement | Window | null) {
      window.removeEventListener('resize', this.queueResize)
      this.target = target
      if (target) {
        window.addEventListener('resize', this.queueResize)
        this.resize()
      }
    }

    get resizeTo() { return this.target }

    private cancelResize = () => {
      if (this.resizeFrame !== null) window.cancelAnimationFrame(this.resizeFrame)
      this.resizeFrame = null
    }

    private queueResize = () => {
      if (!this.target) return
      this.cancelResize()
      this.resizeFrame = window.requestAnimationFrame(() => this.resize())
    }

    resize = () => {
      if (!this.target) return
      this.cancelResize()
      const target = this.target
      const width = target === window ? window.innerWidth : (target as HTMLElement).clientWidth
      const height = target === window ? window.innerHeight : (target as HTMLElement).clientHeight
      this.renderer.resize(width, height)
      this.render()
    }
  },
}))

const controllers: AervoxLive2DController[] = []
const hosts: HTMLElement[] = []
let documentHidden = false

function geometryModel() {
  const scale = { x: 1, y: 1, set: vi.fn((x: number, y = x) => { scale.x = x; scale.y = y }) }
  const position = { x: 0, y: 0, set: vi.fn((x: number, y: number) => { position.x = x; position.y = y }) }
  return {
    anchor: { set: vi.fn() },
    scale,
    position,
    focus: vi.fn(),
    motion: vi.fn(),
    expression: vi.fn(),
    destroy: vi.fn(),
    internalModel: {
      originalWidth: 100,
      originalHeight: 200,
      width: 100,
      height: 200,
      getDrawableIDs: () => ['body'],
      getDrawableBounds: () => ({ x: 10, y: 20, width: 80, height: 160 }),
      coreModel: {
        getDrawableDynamicFlagIsVisible: () => true,
        getDrawableOpacity: () => 1,
        setParameterValueById: vi.fn(),
      },
      motionManager: { definitions: {}, groups: { idle: 'Idle' } },
    },
  }
}

function measuredHost(width: number, height: number) {
  const host = document.createElement('div')
  const size = { width, height }
  Object.defineProperties(host, {
    clientWidth: { configurable: true, get: () => size.width },
    clientHeight: { configurable: true, get: () => size.height },
  })
  host.getBoundingClientRect = vi.fn(() => ({
    x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height,
    width: size.width, height: size.height, toJSON: () => ({}),
  }))
  document.body.appendChild(host)
  hosts.push(host)
  return { host, setSize: (nextWidth: number, nextHeight: number) => { size.width = nextWidth; size.height = nextHeight } }
}

async function loadAt(width: number, height: number) {
  const fixture = measuredHost(width, height)
  const model = geometryModel()
  mock.model.mockResolvedValueOnce(model)
  const controller = new AervoxLive2DController(fixture.host)
  controllers.push(controller)
  await controller.load({ scale: 1 } as AervoxLive2DModel)
  await vi.advanceTimersByTimeAsync(32)
  return { ...fixture, controller, model, app: mock.applications.at(-1)! }
}

async function resizeHost(host: HTMLElement) {
  for (const observer of mock.observers) {
    if (observer.targets.has(host)) observer.deliver()
  }
  window.dispatchEvent(new Event('resize'))
  await vi.advanceTimersByTimeAsync(32)
}

function expectNonzeroRendering(app: ApplicationProbe, model: ReturnType<typeof geometryModel>) {
  expect(app.renderer.screen).toEqual({ width: 400, height: 720 })
  expect(app.view.width).toBe(Math.round(400 * app.renderer.resolution))
  expect(app.view.height).toBe(Math.round(720 * app.renderer.resolution))
  expect(Number.isFinite(model.scale.x) && model.scale.x > 0).toBe(true)
  expect(Number.isFinite(model.scale.y) && model.scale.y > 0).toBe(true)
  expect(Number.isFinite(model.position.x) && Number.isFinite(model.position.y)).toBe(true)
  expect(app.running).toBe(true)
}

function expectNoZeroResize(app: ApplicationProbe, model: ReturnType<typeof geometryModel>) {
  expect(app.renderer.resize.mock.calls.some(([width, height]) => !(width > 0) || !(height > 0))).toBe(false)
  expect(model.scale.set.mock.calls.some(([x, y = x]) => !(x > 0) || !(y > 0))).toBe(false)
}

beforeEach(() => {
  vi.useFakeTimers()
  mock.assets.mockReset().mockResolvedValue({ manifest: { FileReferences: {} }, manifestUrl: 'http://localhost/model.json' })
  mock.model.mockReset()
  mock.applications.length = 0
  mock.observers.length = 0
  documentHidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => documentHidden)
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => window.setTimeout(() => callback(performance.now()), 16))
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => window.clearTimeout(id))
  vi.stubGlobal('ResizeObserver', class {
    targets = new Set<Element>()
    constructor(private callback: ResizeObserverCallback) { mock.observers.push(this) }
    observe(target: Element) { this.targets.add(target) }
    unobserve(target: Element) { this.targets.delete(target) }
    disconnect() { this.targets.clear() }
    deliver = () => this.callback([...this.targets].map(target => ({ target, contentRect: target.getBoundingClientRect() }) as ResizeObserverEntry), this as unknown as ResizeObserver)
  })
})

afterEach(() => {
  controllers.splice(0).forEach(controller => controller.destroy())
  hosts.splice(0).forEach(host => host.remove())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('keeps the framebuffer and model valid across a hidden host and resumes the same model at the same size', async () => {
  const { host, setSize, controller, model, app } = await loadAt(400, 720)
  expectNonzeroRendering(app, model)
  const visibleScale = model.scale.x
  setSize(0, 0)
  await resizeHost(host)
  expectNoZeroResize(app, model)
  expect(app.renderer.screen).toEqual({ width: 400, height: 720 })
  expect(app.view.width).toBe(Math.round(400 * app.renderer.resolution))
  expect(app.view.height).toBe(Math.round(720 * app.renderer.resolution))
  expect(model.scale.x).toBe(visibleScale)
  expect(app.running).toBe(false)
  const startsBeforeRestore = app.start.mock.calls.length
  setSize(400, 720)
  await resizeHost(host)
  expectNonzeroRendering(app, model)
  expect(app.start.mock.calls.length).toBeGreaterThan(startsBeforeRestore)
  expect(controller.status).toBe('ready')
  expect(controller.model).toBe(model)
  expect(mock.model).toHaveBeenCalledOnce()
})

it('loads while the host is hidden without creating a zero-sized framebuffer and fits when it first becomes visible', async () => {
  const { host, setSize, controller, model, app } = await loadAt(0, 0)
  expectNoZeroResize(app, model)
  expect(app.renderer.screen.width).toBeGreaterThan(0)
  expect(app.renderer.screen.height).toBeGreaterThan(0)
  expect(app.view.width).toBeGreaterThan(0)
  expect(app.view.height).toBeGreaterThan(0)
  expect(app.running).toBe(false)
  setSize(400, 720)
  await resizeHost(host)
  expectNonzeroRendering(app, model)
  expect(controller.status).toBe('ready')
  expect(controller.model).toBe(model)
  expect(mock.model).toHaveBeenCalledOnce()
})

it('does not restart a page returning to the foreground until its host is also visible', async () => {
  const { host, setSize, model, app } = await loadAt(400, 720)
  expectNonzeroRendering(app, model)
  documentHidden = true
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(32)
  expect(app.running).toBe(false)
  setSize(0, 0)
  await resizeHost(host)
  expectNoZeroResize(app, model)
  const startsBeforeForeground = app.start.mock.calls.length
  documentHidden = false
  document.dispatchEvent(new Event('visibilitychange'))
  await vi.advanceTimersByTimeAsync(32)
  expect(app.running).toBe(false)
  expect(app.start).toHaveBeenCalledTimes(startsBeforeForeground)
  expectNoZeroResize(app, model)
  setSize(400, 720)
  await resizeHost(host)
  expectNonzeroRendering(app, model)
  expect(mock.model).toHaveBeenCalledOnce()
})
