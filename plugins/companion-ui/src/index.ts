import { defineUISurface } from '@aervox/ui-host';

/** Trusted, bundled surface; never loaded from a declaration bundle. */
export default defineUISurface({
  id: 'companion-ui',
  apiVersion: 1,
  surface: 'companion',
  platforms: ['desktop'],
  displayName: '桌宠窗口',
  description: '桌面常驻桌宠：快捷对话、姿态互动与功能坞。',
  load: async () => (await import('./PetWindow.vue')).default,
});
