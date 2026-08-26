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
