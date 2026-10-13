/// <reference types="vite/client" />

declare module '*.png' {
  const src: string
  export default src
}

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

interface Window {
  aervoxLive2D?: {
    readonly motions: readonly string[]
    readonly expressions: readonly string[]
    lookAt: (target: string | Element) => void
    playMotion: (motion: string) => boolean
    playExpression: (expression: string) => void
    playPose: (pose: { motion?: string; expression?: string }) => void
  }
}
