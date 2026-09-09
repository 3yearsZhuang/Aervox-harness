import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: { '@': resolve('src') },
  },
  server: {
    // AERVOX_WEB_PORT：本地端口被系统保留段（如 Windows WinNAT excludedportrange）占用时覆盖；默认 5173
    port: Number(process.env.AERVOX_WEB_PORT) || 5173,
  },
  build: {
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            if (id.includes('pixi.js') || id.includes('@sekai-world/pixi-live2d-display-mulmotion')) {
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
})
