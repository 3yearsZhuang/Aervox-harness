import { describe, expect, it, vi } from 'vitest'
import { fitLive2DModelToViewport } from '../src/live2d/layout.js'

describe('Live2D layout metrics', () => {
  it('uses drawable geometry without requiring a framebuffer pixel readback', () => {
    const scale = { set: vi.fn() }
    const position = { set: vi.fn() }
    const anchor = { set: vi.fn() }
    const model = {
      anchor,
      scale,
      position,
      internalModel: {
        originalWidth: 100,
        originalHeight: 200,
        width: 100,
        height: 200,
        getDrawableIDs: () => ['body', 'hidden-helper'],
        getDrawableBounds: (index: number) => index === 0
          ? { x: 10, y: 20, width: 80, height: 160 }
          : { x: 0, y: 0, width: 100, height: 200 },
        coreModel: {
          getDrawableDynamicFlagIsVisible: (index: number) => index === 0,
          getDrawableOpacity: () => 1,
        },
      },
    }
    const app = {
      renderer: { screen: { width: 1_000, height: 800 } },
    }

    fitLive2DModelToViewport(app as never, model as never)

    // The visible geometry is 80x160 around the model's local origin.  The
    // 6% headroom therefore produces a 4.7x scale and bottom-aligned center.
    expect(scale.set).toHaveBeenLastCalledWith(4.7)
    expect(position.set).toHaveBeenLastCalledWith(500, 424)
    expect(anchor.set).toHaveBeenCalledWith(0.5, 0.5)
  })

  it('includes the internal model layout translation in the final placement', () => {
    const scale = { set: vi.fn() }
    const position = { set: vi.fn() }
    const anchor = { set: vi.fn() }
    const model = {
      anchor,
      scale,
      position,
      internalModel: {
        originalWidth: 100,
        originalHeight: 200,
        width: 100,
        height: 200,
        localTransform: { a: 1, d: 1, tx: 10, ty: -20 },
        getDrawableIDs: () => ['body'],
        getDrawableBounds: () => ({ x: 10, y: 20, width: 80, height: 160 }),
        coreModel: {
          getDrawableDynamicFlagIsVisible: () => true,
          getDrawableOpacity: () => 1,
        },
      },
    }
    const app = { renderer: { screen: { width: 1_000, height: 800 } } }

    fitLive2DModelToViewport(app as never, model as never)

    expect(position.set).toHaveBeenLastCalledWith(453, 518)
  })

  it('falls back to drawable vertices for older internal model implementations', () => {
    const scale = { set: vi.fn() }
    const position = { set: vi.fn() }
    const anchor = { set: vi.fn() }
    const model = {
      anchor,
      scale,
      position,
      internalModel: {
        originalWidth: 100,
        originalHeight: 200,
        width: 100,
        height: 200,
        getDrawableIDs: () => ['body'],
        getDrawableVertices: () => new Float32Array([10, 20, 90, 20, 90, 180, 10, 180]),
        coreModel: {
          getDrawableDynamicFlagIsVisible: () => true,
          getDrawableOpacity: () => 1,
        },
      },
    }
    const app = { renderer: { screen: { width: 1_000, height: 800 } } }

    fitLive2DModelToViewport(app as never, model as never)

    expect(scale.set).toHaveBeenLastCalledWith(4.7)
    expect(position.set).toHaveBeenLastCalledWith(500, 424)
  })
})
