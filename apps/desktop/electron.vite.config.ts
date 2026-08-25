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
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          pet: resolve('src/renderer/pet.html'),
        },
      },
    },
  },
})
