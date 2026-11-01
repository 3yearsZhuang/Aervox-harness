import { defineConfig, mergeConfig } from 'vitest/config';
import sharedConfig from '../../vitest.shared';
import vue from '@vitejs/plugin-vue';

export default mergeConfig(sharedConfig, defineConfig({ plugins: [vue()], test: { environment: 'node' } }));
