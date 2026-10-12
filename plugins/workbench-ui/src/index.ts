import type { UISurfacePlugin } from '@aervox/ui-host';

/** Trusted, bundled surface; never loaded from a declaration bundle. */
export default {
  id: 'workbench-ui',
  apiVersion: 1,
  surface: 'main',
  platforms: ['web', 'desktop', 'mobile'],
  load: async () => (await import('./AervoxWorkbench.vue')).default,
} satisfies UISurfacePlugin;
