import { createApp } from 'vue';
import ElementPlus from 'element-plus';
import 'element-plus/dist/index.css';
import { configureAervoxClient } from '@aervox/api-client';
import '@aervox/ui';
import App from './App.vue';
import './styles.css';

configureAervoxClient({
  apiBase: import.meta.env.VITE_API_URL,
  workspaceId: import.meta.env.VITE_WORKSPACE_ID,
  userId: import.meta.env.VITE_USER_ID,
  sessionId: import.meta.env.VITE_SESSION_ID,
});

createApp(App).use(ElementPlus).mount('#app');
