import { describe, expect, it } from 'vitest'
import { DEFAULT_DESKTOP_SESSION_ID, resolveDesktopSessionId } from '../src/main/runtime-config.js'

describe('resolveDesktopSessionId', () => {
  it('未配置环境变量时使用可由 API 自动创建的默认会话', () => {
    expect(resolveDesktopSessionId(undefined)).toBe(DEFAULT_DESKTOP_SESSION_ID)
    expect(resolveDesktopSessionId('   ')).toBe(DEFAULT_DESKTOP_SESSION_ID)
  })

  it('保留显式配置的会话 ID', () => {
    expect(resolveDesktopSessionId(' session_1 ')).toBe('session_1')
  })
})
