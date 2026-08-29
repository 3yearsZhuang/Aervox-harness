export const ONBOARDING_COMPLETION_KEY = 'aervox.onboarding.completed.v1'

export interface OnboardingStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export function hasCompletedOnboarding(storage: OnboardingStorage): boolean {
  return storage.getItem(ONBOARDING_COMPLETION_KEY) === 'true'
}

export function markOnboardingCompleted(storage: OnboardingStorage): void {
  storage.setItem(ONBOARDING_COMPLETION_KEY, 'true')
}
