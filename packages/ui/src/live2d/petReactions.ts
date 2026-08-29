/**
 * Live2D 桌宠操作反馈事件总线。
 *
 * 沿用工作台既有的 window 自定义事件惯例（如 `aervox:open-settings`），
 * 任何组件都可调用 `petReact()` 让桌宠对用户操作做出动作 / 表情 / 视线反馈，
 * 而 Live2DPet 组件统一监听并驱动控制器，避免组件间直接耦合。
 */

export const PET_REACT_EVENT = 'aervox:pet-react'

export interface PetReactionDetail {
  /** Motion 组内的具名动作（如 `w-cute-glad01`），缺省时仅做视线/表情反馈 */
  motion?: string
  /** Facial 组内的具名表情（如 `face_smile_01`） */
  expression?: string
  /** 看向的目标：CSS 选择器或元素引用（操作卡片时传对应卡片即可） */
  lookAtEl?: string | Element
  /** 视线停留时长（ms）；到时后回到鼠标位置或画布中心，默认 2600 */
  lookDuration?: number
  /** 触发口型开合的文本（用于 AI 回复时的说话反馈） */
  speak?: string
}

/** 派发一次桌宠反馈；Live2D 未就绪（如 reduced-motion 回退）时静默忽略 */
export function petReact(detail: PetReactionDetail): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent<PetReactionDetail>(PET_REACT_EVENT, { detail }))
}

/** 解析看向目标：字符串按选择器查询，元素引用原样返回 */
export function resolveLookAtElement(target: string | Element | undefined): Element | null {
  if (!target) return null
  if (typeof target === 'string') return document.querySelector(target)
  return target
}
