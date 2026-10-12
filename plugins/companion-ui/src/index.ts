import type { UISurfacePlugin } from '@aervox/ui-host';

/** Trusted, bundled surface; never loaded from a declaration bundle. */
export default {
  id: 'companion-ui',
  apiVersion: 1,
  surface: 'companion',
  platforms: ['desktop'],
  load: async () => (await import('./PetWindow.vue')).default,
} satisfies UISurfacePlugin;
