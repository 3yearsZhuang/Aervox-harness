import { defineUISurface } from '@aervox/ui-host';

/**
 * 思隅·主动陪伴（方向 D）：视觉小说式对话盒 + 两张主动建议卡 + 淡化输入。
 * 受信构建输入，与默认工作台并行存在，由组合根按用户选择装配（CR-065 切片六延伸）。
 */
export default defineUISurface({
  id: 'proactive-ui',
  apiVersion: 1,
  surface: 'main',
  platforms: ['web', 'desktop', 'mobile'],
  displayName: '思隅·主动陪伴',
  description: '对话盒与主动建议为主，输入淡化为一枚药丸。',
  load: async () => (await import('./ProactiveCompanion.vue')).default,
});
