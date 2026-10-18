/// <reference types="@aervox/ui/env" />
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
// Transport methods are declared once by @aervox/api-client; merge shell-only methods.
interface FairyDesktopBridge {
  minimize: () => Promise<void>
  toggleMaximize: () => Promise<boolean>
  close: () => Promise<void>
  openExternal?: (url: string) => Promise<void>
  onPetCommand: (callback: (command: unknown) => void) => () => void
  getTheme: () => Promise<'light' | 'dark'>
  setTheme: (theme: 'light' | 'dark') => Promise<'light' | 'dark'>
  onThemeChange: (callback: (theme: 'light' | 'dark') => void) => () => void
  proactive: import('@aervox/contracts/proactive').ProactiveDesktopBridge
}
