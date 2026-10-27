<script setup lang="ts">
import { ArrowUpRight, CalendarClock } from 'lucide-vue-next';
import { AervoxButton, AervoxCard } from '@aervox/ui/primitives';
import CampusPlanSummary from './CampusPlanSummary.vue';
import { useCampusStore } from './store.js';
const props = defineProps<{ beforeOpen?: () => void }>();
const store = useCampusStore();
const { plan, loading, planning, error, planError } = store;
function open() { props.beforeOpen?.(); store.open('today'); }
</script>

<template>
  <AervoxCard class="campus-home-card" aria-label="只争朝夕 · 出发计划" :aria-busy="loading || planning">
    <div class="campus-card-heading"><CalendarClock :size="18" aria-hidden="true" /><span>只争朝夕</span></div>
    <p v-if="loading" class="campus-card-message" role="status">正在读取课程与行程…</p>
    <p v-else-if="error" class="campus-card-message" role="alert">{{ error }}</p>
    <p v-else-if="planError" class="campus-card-message" role="alert">{{ planError }}</p>
    <CampusPlanSummary v-else-if="plan" :plan="plan" compact />
    <p v-else class="campus-card-message" role="status">{{ planning ? '正在计算出发计划…' : '录入课程、地点和路线耗时，留出从容出发的时间。' }}</p>
    <div class="campus-card-actions">
      <AervoxButton variant="primary" @click="open">查看与管理<ArrowUpRight :size="16" aria-hidden="true" /></AervoxButton>
      <AervoxButton v-if="error || planError" variant="secondary" :disabled="loading" @click="store.reload()">重新加载</AervoxButton>
    </div>
  </AervoxCard>
</template>

<style scoped>
.campus-home-card { padding: 24px; width: 100%; min-width: 0; box-sizing: border-box; text-align: left; }
.campus-card-heading { display: flex; align-items: center; gap: 8px; color: var(--text-secondary); font-size: 13px; margin-bottom: 20px; }
.campus-card-message { font-size: 14px; color: var(--text-secondary); line-height: 1.7; margin: 12px 0 24px; overflow-wrap: anywhere; }
.campus-card-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 22px; }
@media (max-width: 480px) { .campus-home-card { padding: 20px; } }
</style>
