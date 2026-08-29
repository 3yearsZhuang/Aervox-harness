/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_AERVOX_LIVE2D_MODEL_URL?: string
  readonly VITE_AERVOX_LIVE2D_MOTION_DATA_URL?: string
  readonly VITE_AERVOX_LIVE2D_ADDITIONAL_MOTION_DATA_URL?: string
  readonly VITE_AERVOX_LIVE2D_SCALE?: string
  readonly VITE_AERVOX_LIVE2D_ENABLE_EXPRESSIONS?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
interface ApiRequestResult<T = unknown> {
  status: number
  ok: boolean
  json: T | null
  text: string
}
interface Window {
  aervoxLive2D?: {
    readonly motions: readonly string[]
    readonly expressions: readonly string[]
    playMotion: (motion: string) => boolean
    playExpression: (expression: string) => void
    playPose: (pose: { motion?: string; expression?: string }) => void
  }
  fairyDesktop?: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<boolean>
    close: () => Promise<void>
    openExternal?: (url: string) => Promise<void>
    onPetCommand: (callback: (command: unknown) => void) => () => void
    getTheme: () => Promise<'light' | 'dark'>
    setTheme: (theme: 'light' | 'dark') => Promise<'light' | 'dark'>
    onThemeChange: (callback: (theme: 'light' | 'dark') => void) => () => void
    streamTurn: (
      content: string,
      options: {
        toolApprovalMode: 'ask' | 'full_access'
        attachments?: Array<{attachmentId: string; name?: string; mediaType?: string}>
        requestId?: string
      },
      callback: (message: unknown) => void,
    ) => () => void
    cancelTurn?: (requestId: string) => void
    apiRequest: <T = unknown>(method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<ApiRequestResult<T>>
    proactive: import('@aervox/contracts/proactive').ProactiveDesktopBridge
    uploadAttachment?: (payload: {fileName: string; mediaType: string; purpose: string; dataBase64: string; idempotencyKey?: string}) => Promise<unknown>
  }
}
