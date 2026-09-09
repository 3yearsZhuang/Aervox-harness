import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
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
          manualChunks(id) {
            if (id.includes('node_modules')) {
              if (id.includes('@sekai-world/pixi-live2d-display-mulmotion')) {
                return 'vendor-live2d'
              }
              if (id.includes('pixi.js')) {
                return 'vendor-pixi'
              }
              if (id.includes('element-plus')) {
                return 'vendor-element'
              }
              if (id.includes('lucide-vue-next')) {
                return 'vendor-icons'
              }
              if (id.includes('vue')) {
                return 'vendor-vue'
              }
            }
          },
        },
      },
    },
  },
})
