/** The desktop client may start before a user has created a named session. */
export const DEFAULT_DESKTOP_SESSION_ID = 'desktop_default'

export function resolveDesktopSessionId(value: string | undefined): string {
  return value?.trim() || DEFAULT_DESKTOP_SESSION_ID
}
