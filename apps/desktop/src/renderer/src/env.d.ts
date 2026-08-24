/// <reference types="vite/client" />
interface ApiRequestResult<T = unknown> {
  status: number
  ok: boolean
  json: T | null
  text: string
}
interface Window {
  fairyDesktop?: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<boolean>
    close: () => Promise<void>
    getTheme: () => Promise<'light' | 'dark'>
    setTheme: (theme: 'light' | 'dark') => Promise<'light' | 'dark'>
    onThemeChange: (callback: (theme: 'light' | 'dark') => void) => () => void
    streamTurn: (content: string, callback: (message: unknown) => void) => () => void
    apiRequest: <T = unknown>(method: string, path: string, body?: unknown) => Promise<ApiRequestResult<T>>
  }
}
