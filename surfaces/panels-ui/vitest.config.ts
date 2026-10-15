import { defineConfig, mergeConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import sharedConfig from '../../vitest.shared';
import fs from 'node:fs';

const compilerFs = {
  fileExists: (file: string) => fs.existsSync(file),
  readFile: (file: string) => fs.readFileSync(file, 'utf8'),
};

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [vue({ script: { fs: compilerFs } })],
    test: {
      environment: 'happy-dom',
    },
  }),
);
