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
    const natural = measureVisibleBounds(app)
    if (natural) {
      metrics = {
        width: natural.width / measurementScale,
        height: natural.height / measurementScale,
        offsetX: (natural.centerX - width / 2) / measurementScale,
        offsetY: (natural.centerY - height / 2) / measurementScale,
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

function measureVisibleBounds(app: Application): VisibleBounds | null {
  try {
    app.renderer.render(app.stage)
    const pixelWidth = app.renderer.width
    const pixelHeight = app.renderer.height
    const logicalWidth = app.renderer.screen.width
    const logicalHeight = app.renderer.screen.height
    const pixels = app.renderer.extract.pixels()
    // 仅统计真实可见像素（alpha ≥ 40/255），剔除模型软阴影与
    // 半透明杂散像素，保证底边对齐的是肉眼可见的“实际像素底部”。
    const alphaThreshold = 40
    let minX = pixelWidth
    let minY = pixelHeight
    let maxX = -1
    let maxY = -1

    for (let index = 3, pixel = 0; index < pixels.length; index += 4, pixel += 1) {
      if (pixels[index] < alphaThreshold) continue
      const x = pixel % pixelWidth
      const y = Math.floor(pixel / pixelWidth)
      minX = Math.min(minX, x)
      minY = Math.min(minY, y)
      maxX = Math.max(maxX, x)
      maxY = Math.max(maxY, y)
    }
    if (maxX < minX || maxY < minY) return null

    const logicalX = logicalWidth / pixelWidth
    const logicalY = logicalHeight / pixelHeight
    return {
      width: (maxX - minX + 1) * logicalX,
      height: (maxY - minY + 1) * logicalY,
      centerX: (minX + maxX + 1) / 2 * logicalX,
      centerY: (minY + maxY + 1) / 2 * logicalY,
    }
  } catch {
    return null
  }
}
