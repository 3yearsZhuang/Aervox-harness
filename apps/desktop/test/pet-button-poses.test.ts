import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PET_BUTTON_POSES, pickPetButtonPose } from '../src/renderer/src/pet-button-poses.js'

const modelRoot = fileURLToPath(new URL('../src/renderer/public/live2d/mizuki', import.meta.url))

describe('PET_BUTTON_POSES', () => {
  it('每个按钮都绑定了至少一组动作+表情', () => {
    for (const [kind, poses] of Object.entries(PET_BUTTON_POSES)) {
      expect(poses.length, `按钮 ${kind} 姿态池为空`).toBeGreaterThan(0)
      for (const pose of poses) {
        expect(pose.motion, `按钮 ${kind} 缺动作`).toBeTruthy()
        expect(pose.expression, `按钮 ${kind} 缺表情`).toBeTruthy()
      }
    }
  })

  it('所有动作名都对应模型 motion 资产文件', () => {
    for (const [kind, poses] of Object.entries(PET_BUTTON_POSES)) {
      for (const { motion } of poses) {
        const file = resolve(modelRoot, 'motion/motion', `${motion}.motion3.json`)
        expect(existsSync(file), `按钮 ${kind} 动作资产缺失: ${file}`).toBe(true)
      }
    }
  })

  it('所有表情名都对应模型 facial 资产文件', () => {
    for (const [kind, poses] of Object.entries(PET_BUTTON_POSES)) {
      for (const { expression } of poses) {
        const file = resolve(modelRoot, 'facial', `${expression}.motion3.json`)
        expect(existsSync(file), `按钮 ${kind} 表情资产缺失: ${file}`).toBe(true)
      }
    }
  })

  it('不同按钮之间的动作互不重叠（各自独立响应）', () => {
    const seen = new Map<string, string>()
    for (const [kind, poses] of Object.entries(PET_BUTTON_POSES)) {
      for (const { motion } of poses) {
        expect(seen.has(motion), `动作 ${motion} 同时绑定在 ${seen.get(motion)} 与 ${kind}`).toBe(false)
        seen.set(motion, kind)
      }
    }
  })

  it('pickPetButtonPose 返回池内姿态，且与上一次不同（池大于 1 时）', () => {
    const first = pickPetButtonPose('greet')
    expect(PET_BUTTON_POSES.greet).toContainEqual(first)
    const second = pickPetButtonPose('greet', first)
    expect(PET_BUTTON_POSES.greet).toContainEqual(second)
    expect(second).not.toEqual(first)
  })
})
