/// <reference types="vite/client" />
interface Window {
  fairyDesktop?: {
    minimize: () => Promise<void>
    toggleMaximize: () => Promise<boolean>
    close: () => Promise<void>
    getTheme: () => Promise<'light' | 'dark'>
    setTheme: (theme: 'light' | 'dark') => Promise<'light' | 'dark'>
    onThemeChange: (callback: (theme: 'light' | 'dark') => void) => () => void
    streamTurn: (content: string, callback: (message: unknown) => void) => () => void
  }
}
