import { defineUISurface } from '@aervox/ui-host';

/** Trusted, bundled surface; never loaded from a declaration bundle. */
export default defineUISurface({
  id: 'workbench-ui',
  apiVersion: 1,
  surface: 'main',
  platforms: ['web', 'desktop', 'mobile'],
  displayName: '标准工作台',
  description: '完整工作台：侧栏导航、会话流、卡片与设置。',
  load: async () => (await import('./AervoxWorkbench.vue')).default,
});
