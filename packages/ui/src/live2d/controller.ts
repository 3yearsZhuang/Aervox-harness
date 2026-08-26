import { Application, Container } from 'pixi.js'
import type { Live2DModel as Live2DModelType } from '@sekai-world/pixi-live2d-display-mulmotion'
import { fetchModel3Json, type AervoxLive2DModel, type Live2DPose, type ResolvedCubismAsset } from './model'
import { fitLive2DModelToViewport } from './layout'

export type Live2DControllerStatus = 'idle' | 'loading' | 'ready' | 'error'

export class AervoxLive2DController {
  readonly app: Application
  readonly stage: Container
  status: Live2DControllerStatus = 'idle'
  model: Live2DModelType | null = null
  assets: ResolvedCubismAsset | null = null
  private resizeListener: (() => void) | null = null
  private idleTimer: number | null = null
  private blinkTimer: number | null = null
  private blinkReleaseTimer: number | null = null
  private speakingTimer: number | null = null
  private idleEnabled = true

  constructor(private readonly host: HTMLElement) {
    this.app = new Application({
      antialias: true,
      autoDensity: true,
      backgroundAlpha: 0,
      resolution: Math.min(window.devicePixelRatio || 1, 2),
      resizeTo: host,
    })
    host.appendChild(this.app.view as HTMLCanvasElement)
    this.stage = this.app.stage as Container
  }

  async load(modelDefinition: AervoxLive2DModel): Promise<void> {
    this.status = 'loading'
    try {
      this.assets = await fetchModel3Json(modelDefinition)
      // Load the renderer lazily so a missing optional browser runtime cannot
      // crash the host application before the PetHero fallback can render.
      const { Live2DModel } = await import('@sekai-world/pixi-live2d-display-mulmotion')
      // Pass the validated JSON so external motion metadata reaches the runtime.
      const loadedModel = await Live2DModel.from({ ...this.assets.manifest, url: this.assets.manifestUrl }, {
        autoHitTest: false,
        autoFocus: false,
        autoUpdate: true,
        ticker: this.app.ticker,
      })
      this.model = loadedModel
      this.stage.addChild(loadedModel)
      const scaleFactor = modelDefinition.scale ?? 1
      this.resizeListener = () => {
        if (!this.model) return
        fitLive2DModelToViewport(this.app, this.model, { scaleFactor })
      }
      this.resizeListener()
      window.addEventListener('resize', this.resizeListener)
      this.model.eventMode = 'static'
      this.model.cursor = 'pointer'
      this.status = 'ready'
      this.configureNaturalMovements()
      this.scheduleIdleMotion()
      this.scheduleBlink()
    } catch (error) {
      this.status = 'error'
      this.destroy()
      throw error
    }
  }

  playMotion(group: string, index = 0): void {
    if (this.model) void this.model.motion(group, index)
  }

  playExpression(index: number): void {
    if (this.model) void this.model.expression(index)
  }

  playExpressionByName(name: string): void {
    const definitions = this.model?.internalModel.motionManager?.expressionManager?.definitions ?? []
    const index = definitions.findIndex((definition: { Name?: string; name?: string }) =>
      definition.Name === name || definition.name === name || definition.Name?.toLowerCase() === name.toLowerCase() || definition.name?.toLowerCase() === name.toLowerCase())
    if (index >= 0) {
      this.playExpression(index)
      return
    }
    this.playFacialByName(name)
  }

  playFacialByName(name: string): void {
    this.playNamedMotion('Facial', name)
  }

  playNamedMotion(group: string, name: string, priority = 2): boolean {
    const definitions = this.model?.internalModel.motionManager?.definitions[group] ?? []
    const index = definitions.findIndex((definition: { Name?: string; name?: string; File?: string }) =>
      definition.Name === name || definition.name === name || definition.File?.endsWith(`/${name}.motion3.json`) || definition.File?.endsWith(`/${name}`))
    if (index < 0 || !this.model) return false
    void this.model.motion(group, index, priority)
    return true
  }

  playPose(pose: Live2DPose): void {
    if (pose.expression) this.playFacialByName(pose.expression)
    if (pose.motion) this.playNamedMotion('Motion', pose.motion)
  }

  listMotions(): string[] {
    return Object.values(this.model?.internalModel.motionManager?.definitions ?? {}).flatMap((definitions) =>
      (definitions ?? []).map((definition: { Name?: string; name?: string; File?: string }) => definition.Name ?? definition.name ?? definition.File ?? ''))
  }

  listExpressions(): string[] {
    const facial = this.model?.internalModel.motionManager?.definitions.Facial ?? []
    return facial.map((definition: { Name?: string; name?: string; File?: string }) => definition.Name ?? definition.name ?? definition.File ?? '')
  }

  setIdleEnabled(enabled: boolean): void {
    this.idleEnabled = enabled
    if (!enabled && this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
    if (enabled) this.scheduleIdleMotion()
  }

  setFocus(x: number, y: number): void {
    this.model?.focus(x, y)
  }

  setMouthOpen(value: number): void {
    const core = this.model?.internalModel?.coreModel as { setParameterValueById?: (id: string, value: number, weight?: number) => void } | undefined
    core?.setParameterValueById?.('ParamMouthOpenY', Math.max(0, Math.min(1, value)), 1)
  }

  speakText(text: string): void {
    if (!text.trim()) return
    if (this.speakingTimer !== null) window.clearInterval(this.speakingTimer)
    const endAt = Date.now() + Math.min(5_000, Math.max(650, text.length * 55))
    this.speakingTimer = window.setInterval(() => {
      if (Date.now() >= endAt) {
        if (this.speakingTimer !== null) window.clearInterval(this.speakingTimer)
        this.speakingTimer = null
        this.setMouthOpen(0)
        return
      }
      this.setMouthOpen(0.2 + Math.random() * 0.8)
    }, 85)
  }

  private configureNaturalMovements(): void {
    const internal = this.model?.internalModel as { breath?: { setParameters: (params: unknown[]) => void } } | undefined
    internal?.breath?.setParameters([
      { parameterId: 'ParamAngleX', offset: 0, peak: 8, cycle: 6.5, weight: 0.5 },
      { parameterId: 'ParamAngleY', offset: 0, peak: 5, cycle: 3.5, weight: 0.5 },
      { parameterId: 'ParamAngleZ', offset: 0, peak: 4, cycle: 5.5, weight: 0.5 },
      { parameterId: 'ParamBodyAngleX', offset: 0, peak: 3, cycle: 15.5, weight: 0.5 },
      { parameterId: 'ParamBreath', offset: 0, peak: 0.5, cycle: 3.2, weight: 0.5 },
    ])
  }

  private scheduleIdleMotion(): void {
    if (!this.idleEnabled || !this.model || this.idleTimer !== null) return
    this.idleTimer = window.setTimeout(() => {
      this.idleTimer = null
      const idleGroup = this.model?.internalModel.motionManager?.groups.idle ?? 'Idle'
      const definitions = this.model?.internalModel.motionManager?.definitions[idleGroup] ?? []
      if (definitions.length) void this.model?.motion(idleGroup, Math.floor(Math.random() * definitions.length), 1)
      this.scheduleIdleMotion()
    }, 7000 + Math.random() * 6000)
  }

  private scheduleBlink(): void {
    if (!this.model || this.blinkTimer !== null) return
    this.blinkTimer = window.setTimeout(() => {
      this.blinkTimer = null
      const internal = this.model?.internalModel as { coreModel?: { setParameterValueById?: (id: string, value: number, weight?: number) => void }; settings?: { getEyeBlinkParameters?: () => string[] | undefined } } | undefined
      const core = internal?.coreModel
      const parameterIds = internal?.settings?.getEyeBlinkParameters?.() ?? ['ParamEyeLOpen', 'ParamEyeROpen']
      parameterIds.forEach((id) => core?.setParameterValueById?.(id, 0, 1))
      this.blinkReleaseTimer = window.setTimeout(() => {
        parameterIds.forEach((id) => core?.setParameterValueById?.(id, 1, 1))
        this.blinkReleaseTimer = null
      }, 120)
      this.scheduleBlink()
    }, 2_500 + Math.random() * 4_500)
  }

  playFirstAvailableMotion(pattern: RegExp): void {
    const groups = this.model?.internalModel.motionManager?.definitions ?? {}
    const directGroup = Object.entries(groups).find(([name, definitions]) => pattern.test(name) && (definitions ?? []).length > 0)
    if (directGroup) {
      this.playMotion(directGroup[0], Math.floor(Math.random() * (directGroup[1] ?? []).length))
      return
    }
    for (const [group, definitions] of Object.entries(groups)) {
      const matchIndex = (definitions ?? []).findIndex((definition: { Name?: string; name?: string; File?: string }) =>
        pattern.test(definition.Name ?? definition.name ?? definition.File ?? ''))
      if (matchIndex >= 0) {
        this.playMotion(group, matchIndex)
        return
      }
    }
  }

  destroy(): void {
    if (this.idleTimer !== null) window.clearTimeout(this.idleTimer)
    if (this.blinkTimer !== null) window.clearTimeout(this.blinkTimer)
    if (this.blinkReleaseTimer !== null) window.clearTimeout(this.blinkReleaseTimer)
    if (this.speakingTimer !== null) window.clearInterval(this.speakingTimer)
    if (this.resizeListener) window.removeEventListener('resize', this.resizeListener)
    this.model?.destroy({ children: true })
    this.app.destroy(true, { children: true, texture: true, baseTexture: true })
    this.resizeListener = null
    this.model = null
    this.assets = null
    this.blinkTimer = null
    this.blinkReleaseTimer = null
    this.idleTimer = null
    this.speakingTimer = null
  }
}
