import { defineConfig, mergeConfig } from 'vitest/config';
import sharedConfig from '../../vitest.shared';

export default mergeConfig(
  sharedConfig,
  defineConfig({
    plugins: [
      {
        name: 'stub-vue-sfc',
        transform(_code, id) {
          if (id.endsWith('.vue')) {
            const name = id.split('/').pop()?.replace('.vue', '') || 'VueComponent';
            return {
              code: `export default { __name: ${JSON.stringify(name)}, render: () => null };`,
              map: null,
            };
          }
        },
      },
    ],
  }),
);
