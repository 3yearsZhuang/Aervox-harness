import { createRouter, createWebHistory } from 'vue-router';
import ChatView from '@/views/ChatView.vue';
import LearningView from '@/views/LearningView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/chat' },
    { path: '/chat', name: 'chat', component: ChatView },
    { path: '/learning', name: 'learning', component: LearningView },
  ],
});