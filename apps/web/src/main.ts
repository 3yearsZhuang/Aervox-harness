import { createApp } from 'vue';
import { ElButton } from 'element-plus/es/components/button/index.mjs';
import { ElDialog } from 'element-plus/es/components/dialog/index.mjs';
import { ElDropdown, ElDropdownItem, ElDropdownMenu } from 'element-plus/es/components/dropdown/index.mjs';
import { ElTooltip } from 'element-plus/es/components/tooltip/index.mjs';
import 'element-plus/dist/index.css';
import { configureAervoxClient } from '@aervox/api-client';
import App from './App.vue';
import './styles.css';

configureAervoxClient({
  apiBase: import.meta.env.VITE_API_URL,
  sessionId: import.meta.env.VITE_SESSION_ID,
});

const app = createApp(App);
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
app.mount('#app');
