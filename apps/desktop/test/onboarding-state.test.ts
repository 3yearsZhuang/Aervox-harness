import {describe, expect, it} from 'vitest'
import {
  hasCompletedOnboarding,
  markOnboardingCompleted,
  ONBOARDING_COMPLETION_KEY,
  type OnboardingStorage,
} from '../src/renderer/src/onboarding-state.js'

function createStorage(initial?: string): OnboardingStorage {
  const values = new Map<string, string>()
  if (initial !== undefined) values.set(ONBOARDING_COMPLETION_KEY, initial)
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

describe('desktop onboarding completion state', () => {
  it('首次启动时保持未完成', () => {
    expect(hasCompletedOnboarding(createStorage())).toBe(false)
  })

  it('只有明确完成标记才跳过引导', () => {
    expect(hasCompletedOnboarding(createStorage('false'))).toBe(false)
    expect(hasCompletedOnboarding(createStorage('1'))).toBe(false)
    expect(hasCompletedOnboarding(createStorage('true'))).toBe(true)
  })

  it('完成后写入版本化本地标记', () => {
    const storage = createStorage()
    markOnboardingCompleted(storage)
    expect(hasCompletedOnboarding(storage)).toBe(true)
  })
})
