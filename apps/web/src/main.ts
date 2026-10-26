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

const client = createAervoxClient({
  apiBase: import.meta.env.VITE_API_URL,
  sessionStorage: (() => { try { return window.localStorage; } catch { return null; } })(),
  sessionId: import.meta.env.VITE_SESSION_ID,
});

const app = createApp(App);
provideAervoxClient(client, app);
const elementComponents = [
  ElButton,
  ElDialog,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElTooltip,
];
for (const comp of elementComponents) {
  app.use(comp);
}
async function mount() {
  if (import.meta.env.VITE_AERVOX_PLATFORM === 'mobile') {
    const { installMaterial3 } = await import('@aervox/ui/material3/register');
    installMaterial3(app);
  }
  app.mount('#app');
}
void mount();
