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
  widthRatio?: number
  heightRatio?: number
}

export function fitLive2DModelToViewport(
  app: Application,
  model: Live2DModel,
  options: Live2DViewportFitOptions = {},
): void {
  const width = app.renderer.screen.width
  const height = app.renderer.screen.height
  const scaleFactor = options.scaleFactor ?? 1
  const widthRatio = options.widthRatio ?? 0.78
  const heightRatio = options.heightRatio ?? 0.86

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
    model.scale.set(Math.min(
      width / model.internalModel.originalWidth,
      height / model.internalModel.originalHeight,
    ) * 0.82 * scaleFactor)
    model.position.set(width / 2, height / 2)
    return
  }

  const scale = Math.min(
    width * widthRatio / metrics.width,
    height * heightRatio / metrics.height,
  ) * scaleFactor
  model.scale.set(scale)
  model.position.set(
    width / 2 - metrics.offsetX * scale,
    height / 2 - metrics.offsetY * scale,
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
    let minX = pixelWidth
    let minY = pixelHeight
    let maxX = -1
    let maxY = -1

    for (let index = 3, pixel = 0; index < pixels.length; index += 4, pixel += 1) {
      if (pixels[index] < 12) continue
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
