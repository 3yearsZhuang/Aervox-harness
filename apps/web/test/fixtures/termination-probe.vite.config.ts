import { fileURLToPath } from 'node:url';
import { mergeConfig } from 'vite';
import production from '../../vite.config';

/** Explicit CLI config for a separate APK identity; normal builds never load it. */
export default mergeConfig(production, {
  resolve: { alias: [
    { find: /^\.\/native-channel$/, replacement: fileURLToPath(new URL('./native-process-channel.ts', import.meta.url)) },
    { find: /^\.\/native-model-provider$/, replacement: fileURLToPath(new URL('./native-process-model.ts', import.meta.url)) },
  ] },
  plugins: [{ name: 'deterministic-termination-probe', transformIndexHtml(html: string) {
    return html.replace('<body>', '<body data-termination-probe="v1"><aside id="termination-probe" data-model-starts="0" style="position:fixed;top:0;left:0;right:0;z-index:60000;background:#332d22;color:#fff;padding:3px 8px;font:12px sans-serif">专用确定性测试 · 模型启动 0</aside>');
  } }],
  build: { outDir: fileURLToPath(new URL('../../../mobile/dist/process-termination', import.meta.url)), emptyOutDir: true },
});
