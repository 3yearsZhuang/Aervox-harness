import { defineUISurface } from '@aervox/ui-host';

/**
 * 思隅·素简文档（方向 G，minimalist-ui 语言）：暖单色文档式界面——
 * 桌宠小像边栏、文档条目式建议卡（01/02 + 理由行）、几乎无声的输入药丸。
 * 受信构建输入，与默认工作台、紧凑变体、主动陪伴并行，由组合根选择装配。
 */
export default defineUISurface({
  id: 'document-ui',
  apiVersion: 1,
  surface: 'main',
  platforms: ['web', 'desktop', 'mobile'],
  displayName: '素简文档',
  description: '暖纸文档式伴学：条目化建议与低存在输入。',
  load: async () => (await import('./DocumentCompanion.vue')).default,
});
