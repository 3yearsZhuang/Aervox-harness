import { manualChunks } from '../../scripts/vendor-chunks'
import { cspMetaPlugin, LOOPBACK_ORIGINS } from '../../scripts/security-csp'
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  // 单用户本机实例：渲染层只允许同源与 loopback API（含插件 Page iframe）。
  plugins: [vue(), cspMetaPlugin({ extraConnect: [...LOOPBACK_ORIGINS] })],
  resolve: {
    alias: { '@': resolve('src') },
  },
  server: {
    // AERVOX_WEB_PORT：本地端口被系统保留段（如 Windows WinNAT excludedportrange）占用时覆盖；默认 5173
    port: Number(process.env.AERVOX_WEB_PORT) || 5173,
  },
  build: {
    chunkSizeWarningLimit: 500,
    rollupOptions: {
      output: {
        manualChunks,
      },
    },
  },
})
