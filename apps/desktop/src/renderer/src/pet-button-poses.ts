/**
 * Aervox 桌宠 dock 按钮 — Live2D 独立动作 + 表情响应
 *
 * 每个按钮绑定互不重叠的姿态配对池（motion + expression 预搭配），
 * 点击时随机取用避免连续点击动作重复；无 Live2D 桥（PetHero 回退）时由
 * 调用方 optional-chain 静默跳过。
 */
import {MizukiExpression, MizukiMotion} from './live2d/model'

export interface PetButtonPose {
    motion: MizukiMotion
    expression: MizukiExpression
}

export type PetButtonPoseKind = 'greet' | 'happy' | 'farewell' | 'expand' | 'collapse' | 'think'

/** 打招呼：挥手问候 / 身体前倾示意 */
const GREET: PetButtonPose[] = [
    {motion: MizukiMotion.w_normal_greeting01, expression: MizukiExpression.face_wink_01},
    {motion: MizukiMotion.w_cute_poseforward02, expression: MizukiExpression.face_smile_01},
]
/** 开心：雀跃 / 害羞地高兴 */
const HAPPY: PetButtonPose[] = [
    {motion: MizukiMotion.w_cute_glad01, expression: MizukiExpression.face_sparkling_01},
    {motion: MizukiMotion.w_adult_glad01, expression: MizukiExpression.face_smile_03},
]
/** 关闭：挥手再见（配 1.6s 延迟关窗） */
const FAREWELL: PetButtonPose[] = [
    {motion: MizukiMotion.w_happy_shakehand01, expression: MizukiExpression.face_smile_02},
    {motion: MizukiMotion.w_cool_shakehand01, expression: MizukiExpression.face_smile_04},
]
/** 展开功能坞：凑近关注 / 指向示意 */
const EXPAND: PetButtonPose[] = [
    {motion: MizukiMotion.w_cute_forward01, expression: MizukiExpression.face_notice_01},
    {motion: MizukiMotion.w_normal_purpose01, expression: MizukiExpression.face_sparkling_01},
]
/** 收起功能坞：放松呼气 / 摇晃打盹 */
const COLLAPSE: PetButtonPose[] = [
    {motion: MizukiMotion.w_normal_relief01, expression: MizukiExpression.face_breath_01},
    {motion: MizukiMotion.w_normal_yurayura01, expression: MizukiExpression.face_sleepy_01},
]
/** 快捷消息发送（等待回复时）：思考 */
const THINK: PetButtonPose[] = [
    {motion: MizukiMotion.w_adult_think01, expression: MizukiExpression.face_normal_01},
    {motion: MizukiMotion.w_adult_think02, expression: MizukiExpression.face_smallmouth_01},
]

export const PET_BUTTON_POSES: Record<PetButtonPoseKind, PetButtonPose[]> = {
    greet: GREET,
    happy: HAPPY,
    farewell: FAREWELL,
    expand: EXPAND,
    collapse: COLLAPSE,
    think: THINK,
}

/** 从按钮姿态池随机取一组（池内避免与上次相同，池只有一组时原样返回） */
export function pickPetButtonPose(kind: PetButtonPoseKind, previous?: PetButtonPose): PetButtonPose {
    const pool = PET_BUTTON_POSES[kind]
    if (pool.length === 1) return pool[0]
    let picked = pool[Math.floor(Math.random() * pool.length)]
    if (previous && picked === previous) {
        picked = pool[(pool.indexOf(picked) + 1) % pool.length]
    }
    return picked
}
