import { defineConfig, mergeConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import sharedConfig from '../../vitest.shared';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [vue()],
    test: {
      environment: 'happy-dom',
    },
  }),
);
