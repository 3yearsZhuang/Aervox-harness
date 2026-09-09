/**
 * Live2D 桌宠操作反馈事件总线。
 *
 * 沿用工作台既有的 window 自定义事件惯例（如 `aervox:open-settings`），
 * 任何组件都可调用 `petReact()` 让桌宠对用户操作做出动作 / 表情 / 视线反馈，
 * 而 Live2DPet 组件统一监听并驱动控制器，避免组件间直接耦合。
 */
import { MizukiExpression, MizukiMotion } from './model';

export const PET_REACT_EVENT = 'aervox:pet-react';

export interface PetReactionDetail {
  /** Motion 组内的具名动作（如 `w-cute-glad01`），缺省时仅做视线/表情反馈 */
  motion?: string;
  /** Facial 组内的具名表情（如 `face_smile_01`） */
  expression?: string;
  /** 看向的目标：CSS 选择器或元素引用（操作卡片时传对应卡片即可） */
  lookAtEl?: string | Element;
  /** 视线停留时长（ms）；到时后回到鼠标位置或画布中心，默认 2600 */
  lookDuration?: number;
  /** 触发口型开合的文本（用于 AI 回复时的说话反馈） */
  speak?: string;
}

/** 派发一次桌宠反馈；Live2D 未就绪（如 reduced-motion 回退）时静默忽略 */
export function petReact(detail: PetReactionDetail): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent<PetReactionDetail>(PET_REACT_EVENT, { detail }));
}

/** 解析看向目标：字符串按选择器查询，元素引用原样返回 */
export function resolveLookAtElement(target: string | Element | undefined): Element | null {
  if (!target) return null;
  if (typeof target === 'string') return document.querySelector(target);
  return target;
}

/** Live2D 操作反馈动作池：按语义挑选 Mizuki 动作子集，随机取用避免重复 */
export const PET_MOTION_POOLS = {
  glad: [MizukiMotion.w_cute_glad01, MizukiMotion.w_cute_glad03, MizukiMotion.w_adult_glad01, MizukiMotion.w_happy_glad01, MizukiMotion.w_normal_glad01],
  nod: [MizukiMotion.w_cute_nod01, MizukiMotion.w_normal_nod01, MizukiMotion.w_adult_nod01, MizukiMotion.w_happy_nod01],
  think: [MizukiMotion.w_adult_think01, MizukiMotion.w_adult_think02],
  shake: [MizukiMotion.w_normal_shakehead01, MizukiMotion.w_happy_shakehead01, MizukiMotion.w_cute_shakehead01],
  greet: [MizukiMotion.w_normal_greeting01, MizukiMotion.w_cute_poseforward02],
  forward: [MizukiMotion.w_cute_forward01, MizukiMotion.w_normal_forward01, MizukiMotion.w_happy_forward01],
  tilthead: [MizukiMotion.w_normal_tilthead01, MizukiMotion.w_cute_tilthead01, MizukiMotion.w_adult_tilthead01],
  sad: [MizukiMotion.w_normal_sad01, MizukiMotion.w_happy_sad01, MizukiMotion.w_cool_sad01],
} as const;

export type PetReactionKind = keyof typeof PET_MOTION_POOLS;

/** 按语义派发桌宠反馈：动作 + 表情 + 看向目标 + 说话 */
export function petReactKind(
  kind: PetReactionKind,
  options: {
    expression?: MizukiExpression;
    lookAtEl?: string | Element;
    speak?: string;
    lookDuration?: number;
  } = {},
): void {
  const pool = PET_MOTION_POOLS[kind];
  petReact({
    motion: pool[Math.floor(Math.random() * pool.length)],
    expression: options.expression,
    lookAtEl: options.lookAtEl,
    lookDuration: options.lookDuration,
    speak: options.speak,
  });
}
