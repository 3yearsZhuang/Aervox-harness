/** Shared Web/Desktop vendor chunk policy. Ordering matters for Vue-based packages. */
export function manualChunks(id: string): string | undefined {
  if (!id.includes('node_modules')) return;
  for (const [dependency, chunk] of [
    ['@sekai-world/pixi-live2d-display-mulmotion', 'vendor-live2d'],
    ['pixi.js', 'vendor-pixi'], ['element-plus', 'vendor-element'],
    ['lucide-vue-next', 'vendor-icons'], ['vue', 'vendor-vue'],
  ]) {
    if (id.includes(dependency)) return chunk;
  }
}
