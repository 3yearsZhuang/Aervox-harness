import { createApp } from 'vue';
import { ElButton } from 'element-plus/es/components/button/index.mjs';
import { ElDialog } from 'element-plus/es/components/dialog/index.mjs';
import { ElDropdown, ElDropdownItem, ElDropdownMenu } from 'element-plus/es/components/dropdown/index.mjs';
import { ElTooltip } from 'element-plus/es/components/tooltip/index.mjs';
import 'element-plus/dist/index.css';
import { createAervoxClient, provideAervoxClient } from '@aervox/api-client';
import App from './App.vue';
import './styles.css';
import '@aervox/ui/theme';

async function bootstrap() {
  const native = Boolean(window.AervoxM0Native);
  // The APK CSP forbids generated JavaScript. Install Pixi's static uniform
  // synchronizer before mounting a surface that constructs its renderer.
  if (native) await import('./mobile/native-renderer');
  const { nativeStorage, hydrateNativeStorage } = await import('./mobile/native-storage');
  if (native) await hydrateNativeStorage();
  const nativeTransport = native
    ? await import('./mobile/native-runtime').then(module => module.initializeNativeRuntime())
    : undefined;
  const client = createAervoxClient({
    ...(nativeTransport ? { transport: nativeTransport } : {}),
    apiBase: import.meta.env.VITE_API_URL,
    sessionStorage: native ? nativeStorage : (() => { try { return window.localStorage; } catch { return null; } })(),
    sessionId: import.meta.env.VITE_SESSION_ID,
  });
  const app = createApp(App);
  provideAervoxClient(client, app);
  for (const component of [ElButton, ElDialog, ElDropdown, ElDropdownItem, ElDropdownMenu, ElTooltip]) app.use(component);
  if (import.meta.env.VITE_AERVOX_PLATFORM === 'mobile') {
    const { installMaterial3 } = await import('@aervox/ui/material3/register');
    installMaterial3(app);
  }
  app.mount('#app');
}
void bootstrap().catch(() => {
  const root = document.getElementById('app');
  if (root) {
    root.textContent = '本机运行暂不可用，已有数据已保留。请关闭应用后重试。';
    root.setAttribute('role', 'alert');
  }
});
