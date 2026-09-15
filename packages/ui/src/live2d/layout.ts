import type { Application } from 'pixi.js'
import type { Live2DModel } from '@sekai-world/pixi-live2d-display-mulmotion'

interface VisibleBounds {
  width: number
  height: number
  centerX: number
  centerY: number
}

interface ModelLayoutMetrics {
  width: number
  height: number
  offsetX: number
  offsetY: number
}

const metricsCache = new WeakMap<object, ModelLayoutMetrics>()

export interface Live2DViewportFitOptions {
  scaleFactor?: number
  heightRatio?: number
  /** 顶部动画余量（占视口高度比例）：动作时发饰/头饰可能上探超出静态可见范围，预留空间避免被画布上缘裁切 */
  headroomRatio?: number
}

export function fitLive2DModelToViewport(
  app: Application,
  model: Live2DModel,
  options: Live2DViewportFitOptions = {},
): void {
  const width = app.renderer.screen.width
  const height = app.renderer.screen.height
  const scaleFactor = options.scaleFactor ?? 1
  // 沉浸式工作台：模型可见高度撑满视口（仅按高度驱动，横向居中，超宽部分裁剪）。
  const heightRatio = options.heightRatio ?? 1
  // 顶部预留动画余量：底边仍严格对齐视口底部，仅整体略缩，动作上探的发饰不再被裁切。
  const headroomRatio = Math.min(Math.max(options.headroomRatio ?? 0.06, 0), 0.3)

  model.anchor.set(0.5, 0.5)
  let metrics = metricsCache.get(model)
  if (!metrics) {
    const measurementScale = Math.min(
      width / model.internalModel.originalWidth,
      height / model.internalModel.originalHeight,
    ) * 0.55
    model.scale.set(measurementScale)
    model.position.set(width / 2, height / 2)
    // Do not read back the entire WebGL framebuffer here.  ReadPixels stalls
    // the GPU and scans millions of RGBA values on every newly-created model.
    // The Live2D internal model already exposes drawable vertices in canvas
    // coordinates, which is enough to calculate stable layout metrics.
    const natural = measureVisibleBounds(model)
    if (natural) {
      metrics = {
        width: natural.width,
        height: natural.height,
        offsetX: natural.centerX,
        offsetY: natural.centerY,
      }
      metricsCache.set(model, metrics)
    }
  }

  if (!metrics) {
    model.anchor.set(0.5, 1)
    model.scale.set(height * (1 - headroomRatio) / model.internalModel.originalHeight * scaleFactor)
    model.position.set(width / 2, height)
    return
  }

  const scale = height * Math.max(heightRatio - headroomRatio, 0.1) / metrics.height * scaleFactor
  model.scale.set(scale)
  // 水平居中；模型实际像素底边对齐视口底部，控制台浮层叠加其上。
  model.position.set(
    width / 2 - metrics.offsetX * scale,
    height - (metrics.offsetY + metrics.height / 2) * scale,
  )
}

/**
 * Calculate the model's visible canvas bounds from Cubism drawable geometry.
 *
 * `InternalModel.getDrawableBounds()` (and its vertex fallback) returns
 * coordinates in the original model canvas space (origin at the top-left).
 * Converting those bounds to the centered local space used by Pixi gives the
 * same width/offset contract as the old framebuffer scan without synchronizing
 * the CPU with the GPU.
 */
function measureVisibleBounds(model: Live2DModel): VisibleBounds | null {
  try {
    const internal = model.internalModel as typeof model.internalModel & {
      getDrawableIDs?: () => string[]
      getDrawableBounds?: (index: number, bounds?: { x: number; y: number; width: number; height: number }) => {
        x: number
        y: number
        width: number
        height: number
      }
      getDrawableVertices?: (index: number | string) => ArrayLike<number>
      coreModel?: {
        getDrawableOpacity?: (index: number) => number
        getDrawableDynamicFlagIsVisible?: (index: number) => boolean
      }
      localTransform?: {
        a?: number
        d?: number
        tx?: number
        ty?: number
      }
    }
    const getDrawableBounds = internal.getDrawableBounds?.bind(internal)
    const getDrawableVertices = internal.getDrawableVertices?.bind(internal)
    const drawableIds = internal.getDrawableIDs?.()
    if ((!getDrawableBounds && !getDrawableVertices) || !drawableIds?.length) return null

    const originalWidth = Number(internal.originalWidth)
    const originalHeight = Number(internal.originalHeight)
    const modelWidth = Number(internal.width)
    const modelHeight = Number(internal.height)
    if (!(originalWidth > 0) || !(originalHeight > 0)) return null
    const localTransform = internal.localTransform
    const scaleX = Number(localTransform?.a) || (modelWidth > 0 ? modelWidth / originalWidth : 1)
    const scaleY = Number(localTransform?.d) || (modelHeight > 0 ? modelHeight / originalHeight : 1)
    const translateX = Number(localTransform?.tx) || 0
    const translateY = Number(localTransform?.ty) || 0
    const core = internal.coreModel
    let minX = Number.POSITIVE_INFINITY
    let minY = Number.POSITIVE_INFINITY
    let maxX = Number.NEGATIVE_INFINITY
    let maxY = Number.NEGATIVE_INFINITY
    let consideredDrawables = 0
    const reusableBounds = { x: 0, y: 0, width: 0, height: 0 }

    for (let index = 0; index < drawableIds.length; index += 1) {
      // Match the old alpha threshold closely enough to ignore hidden helper
      // meshes and fully transparent clipping geometry.
      if (core?.getDrawableDynamicFlagIsVisible?.(index) === false) continue
      const opacity = core?.getDrawableOpacity?.(index)
      if (opacity !== undefined && opacity <= 40 / 255) continue
      consideredDrawables += 1
      if (getDrawableBounds) {
        const bounds = getDrawableBounds(index, reusableBounds)
        const left = (Number(bounds.x) - originalWidth / 2) * scaleX + translateX
        const right = (Number(bounds.x + bounds.width) - originalWidth / 2) * scaleX + translateX
        const top = (Number(bounds.y) - originalHeight / 2) * scaleY + translateY
        const bottom = (Number(bounds.y + bounds.height) - originalHeight / 2) * scaleY + translateY
        if (![left, right, top, bottom].every(Number.isFinite)) continue
        minX = Math.min(minX, left, right)
        minY = Math.min(minY, top, bottom)
        maxX = Math.max(maxX, left, right)
        maxY = Math.max(maxY, top, bottom)
        continue
      }

      const vertices = getDrawableVertices?.(index)
      if (!vertices || vertices.length < 2) continue
      for (let vertex = 0; vertex + 1 < vertices.length; vertex += 2) {
        const x = (Number(vertices[vertex]) - originalWidth / 2) * scaleX + translateX
        const y = (Number(vertices[vertex + 1]) - originalHeight / 2) * scaleY + translateY
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue
        minX = Math.min(minX, x)
        minY = Math.min(minY, y)
        maxX = Math.max(maxX, x)
        maxY = Math.max(maxY, y)
      }
    }
    if (!consideredDrawables || !Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
      return null
    }
    return {
      width: Math.max(maxX - minX, 1),
      height: Math.max(maxY - minY, 1),
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2,
    }
  } catch {
    return null
  }
}
