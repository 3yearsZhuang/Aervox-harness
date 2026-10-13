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

/** 多根界面试验田：同一包内的替代主界面，供组合根按用户选择装配。 */
export const compactSurface = defineUISurface({
  id: 'workbench-compact-ui',
  apiVersion: 1,
  surface: 'main',
  platforms: ['web', 'desktop', 'mobile'],
  displayName: '紧凑工作台',
  description: '单栏紧凑工作台：无侧栏与会话卡片，聚焦当前对话。',
  load: async () => (await import('./CompactWorkbench.vue')).default,
});
