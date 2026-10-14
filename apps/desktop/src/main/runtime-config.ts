/** The desktop client may start before a user has created a named session. */
export const DEFAULT_DESKTOP_SESSION_ID = 'desktop_default'

export function resolveDesktopSessionId(value: string | undefined): string {
  return value?.trim() || DEFAULT_DESKTOP_SESSION_ID
}

/** Explicit renderer sessions must survive IPC; invalid values never fall back. */
export function resolveTurnSessionId(value: unknown, fallback?: string): string {
  if (value === undefined) return resolveDesktopSessionId(fallback)
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || /[\u0000-\u001f]/.test(value)) {
    throw new Error('invalid_session_id')
  }
  return value
}
