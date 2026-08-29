import { Application, Container } from 'pixi.js'
import type { Live2DModel as Live2DModelType } from '@sekai-world/pixi-live2d-display-mulmotion'
import { fetchModel3Json, type AervoxLive2DModel, type Live2DPose, type ResolvedCubismAsset } from './model'
import { fitLive2DModelToViewport } from './layout'

export type Live2DControllerStatus = 'idle' | 'loading' | 'ready' | 'error'

/**
 * 待机手部动作样式池：每个池一种风格，节拍间切换风格避免重复。
 * 依次为：摆姿势 / 小摆弄 / 挥手互动 / 轻松摇摆 / 默认体态。
 */
const IDLE_HAND_STYLES: readonly (readonly string[])[] = [
  ['w-normal-pose01', 'w-normal-pose02', 'w-normal-pose03', 'w-normal-pose04', 'w-normal-pose05', 'w-normal-pose06'],
  ['w-normal-fidget01', 'w-cute-fidget01', 'w-animal-fidget01', 'w-animal-fidget02'],
  ['w-adult-shakehand01', 'w-cool-shakehand01', 'w-happy-shakehand01', 'w-happy-wandahoi01'],
  ['w-normal-yurayura01', 'w-normal-default01', 'w-happy-purpose01'],
  ['w-normal-armescape01n', 'w-normal-armescape02n', 'w-normal-armescape03ln', 'w-normal-armescape03rn'],
]

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
  /** 上一次播放的待机动作下标：随机挑选时避开，避免同一动作来回重复 */
  private lastIdleIndex: number | null = null
  /** 上一次待机手部风格池下标：节拍间切换风格，避免连续同风格 */
  private lastIdleStyleIndex: number | null = null
  /** 上一次播放的待机手部动作名：同风格内也避开立即重复 */
  private lastIdleMotionName: string | null = null
  /** 视线占用截止时间戳：操作反馈看向卡片期间，待机视线游移不打断 */
  private gazeHoldUntil = 0
  /** 平滑视线跟随：目标点与当前点按帧插值，避免 focus() 瞬移 */
  private focusCurrent: { x: number; y: number } | null = null
  private focusTarget: { x: number; y: number } | null = null
  private readonly focusTicker = (): void => {
    if (!this.model || !this.focusCurrent || !this.focusTarget) return
    const dx = this.focusTarget.x - this.focusCurrent.x
    const dy = this.focusTarget.y - this.focusCurrent.y
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
    this.focusCurrent.x += dx * 0.12
    this.focusCurrent.y += dy * 0.12
    this.model.focus(this.focusCurrent.x, this.focusCurrent.y)
  }

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
      // Idle 组常只有一个动作，库的动作结束自动循环会永远重复它（僵硬）；
      // 替换成多样待机池后，库的 idle 随机循环本身就足够自然。
      this.diversifyIdleGroup()
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
      this.resetFocusPoint()
      this.app.ticker.add(this.focusTicker)
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

  /** 将视线平滑移向视口坐标（自动换算为画布局部坐标）；holdMs 期间待机视线游移不打断 */
  focusViewportPoint(clientX: number, clientY: number, holdMs = 0): void {
    const rect = this.host.getBoundingClientRect()
    this.focusTarget = { x: clientX - rect.left, y: clientY - rect.top }
    if (holdMs > 0) this.gazeHoldUntil = Date.now() + holdMs
  }

  /** 视线回到画布中心偏上（默认朝向观众） */
  focusViewportCenter(): void {
    const rect = this.host.getBoundingClientRect()
    this.focusTarget = { x: rect.width / 2, y: rect.height * 0.38 }
  }

  private resetFocusPoint(): void {
    const rect = this.host.getBoundingClientRect()
    const center = { x: rect.width / 2, y: rect.height * 0.38 }
    this.focusCurrent = { ...center }
    this.focusTarget = center
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
      // 大多数待机节拍只游移视线（轻微张望），偶尔换一种不同于上次风格的待机手部动作
      if (Math.random() < 0.6 && !this.playIdleHandMotion()) {
        const idleGroup = this.model?.internalModel.motionManager?.groups.idle ?? 'Idle'
        const definitions = this.model?.internalModel.motionManager?.definitions[idleGroup] ?? []
        if (definitions.length > 0) {
          let index = Math.floor(Math.random() * definitions.length)
          if (definitions.length > 1 && index === this.lastIdleIndex) {
            index = (index + 1 + Math.floor(Math.random() * (definitions.length - 1))) % definitions.length
          }
          this.lastIdleIndex = index
          void this.model?.motion(idleGroup, index, 1)
        }
      }
      this.wanderGaze()
      this.scheduleIdleMotion()
    }, 8_000 + Math.random() * 9_000)
  }

  /**
   * 播放一种待机手部动作：先切换到不同于上次的风格池，再在池内避开上次的动作名。
   * 用 NORMAL 优先级保证能打断库的 idle 自动循环（IDLE 级），又不会打断用户操作反馈（同级被拒）。
   * 找不到具名动作（模型不含该 Motion）时返回 false，由调用方回退模型自带 Idle 组。
   */
  private playIdleHandMotion(): boolean {
    if (IDLE_HAND_STYLES.length === 0) return false
    let styleIndex = Math.floor(Math.random() * IDLE_HAND_STYLES.length)
    if (IDLE_HAND_STYLES.length > 1 && styleIndex === this.lastIdleStyleIndex) {
      styleIndex = (styleIndex + 1 + Math.floor(Math.random() * (IDLE_HAND_STYLES.length - 1))) % IDLE_HAND_STYLES.length
    }
    const pool = IDLE_HAND_STYLES[styleIndex]
    const candidates = pool.filter((name) => name !== this.lastIdleMotionName)
    const choices = candidates.length > 0 ? candidates : pool
    const name = choices[Math.floor(Math.random() * choices.length)]
    if (!this.playNamedMotion('Motion', name, 2)) return false
    this.lastIdleStyleIndex = styleIndex
    this.lastIdleMotionName = name
    return true
  }

  /**
   * 把模型 manifest 的 Idle 组替换为多样待机池（复用 Motion 组里已解析的 File 引用）。
   * 库的动作播完会自动随机播放 Idle 组：单一动作意味着永远重复同一个（僵硬的根源）。
   */
  private diversifyIdleGroup(): void {
    const motions = this.assets?.manifest.FileReferences.Motions
    if (!motions) return
    const motionGroup = motions.Motion ?? []
    const idleEntries = IDLE_HAND_STYLES.flat()
      .map((name) => motionGroup.find((entry) => entry.Name === name))
      .filter((entry): entry is { File: string; Name?: string; Sound?: string; FadeInTime?: number; FadeOutTime?: number } => entry !== undefined)
      .map((entry) => ({ ...entry, Name: entry.Name ?? entry.File }))
    if (idleEntries.length > 0) motions.Idle = idleEntries
  }

  /** 待机视线游移：在中心附近随机取一个点缓慢漂过去，操作反馈占用期间不打断 */
  private wanderGaze(): void {
    if (!this.model || Date.now() < this.gazeHoldUntil) return
    const rect = this.host.getBoundingClientRect()
    this.focusTarget = {
      x: rect.width * (0.5 + (Math.random() - 0.5) * 0.32),
      y: rect.height * (0.38 + (Math.random() - 0.5) * 0.24),
    }
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
    this.app.ticker.remove(this.focusTicker)
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
