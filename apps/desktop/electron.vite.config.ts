import { manualChunks } from '../../scripts/vendor-chunks'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: { __AERVOX_NATIVE_PUBLIC_KEY__: JSON.stringify(process.env.AERVOX_NATIVE_RELEASE_PUBLIC_KEY ?? '') },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: 'index.js',
        },
      },
    },
  },
  renderer: {
    resolve: { alias: { '@': resolve('src/renderer/src') } },
    plugins: [vue()],
    // AERVOX_DESKTOP_PORT：本地端口被系统保留段占用时覆盖；默认 5174（被占用时 vite 自动顺延）
    server: { port: Number(process.env.AERVOX_DESKTOP_PORT) || 5174 },
    build: {
      chunkSizeWarningLimit: 500,
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          pet: resolve('src/renderer/pet.html'),
        },
        output: {
          manualChunks,
        },
      },
    },
  },
})
