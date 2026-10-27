<script setup lang="ts">
import type { CampusPlan } from '../domain/index.js';
import { clock, dateLabel } from './time.js';
defineProps<{ plan: CampusPlan; compact?: boolean }>();
const labels: Record<CampusPlan['departureStatus'], string> = {
  relaxed: '时间充裕', soon: '准备出发', leave_now: '现在出发', late: '可能迟到',
  no_schedule: '暂无待出发行程', route_unavailable: '需要补充路线',
};
</script>

<template>
  <div class="campus-plan" :data-status="plan.departureStatus">
    <template v-if="plan.nextEvent">
      <p class="campus-eyebrow">下一程 · {{ dateLabel(plan.nextEvent.startAt, plan.timezone) }}</p>
      <h3>{{ plan.nextEvent.title }}</h3>
      <p class="campus-muted">{{ clock(plan.nextEvent.startAt, plan.timezone) }} 开始 · {{ plan.destination?.name ?? '地点待补充' }}</p>
      <div class="campus-departure">
        <div><span class="campus-muted">建议出发</span><strong>{{ clock(plan.departureAt, plan.timezone) }}</strong></div>
        <span class="campus-status">{{ labels[plan.departureStatus] }}</span>
      </div>
      <p v-if="plan.routeStatus === 'unavailable'" class="campus-plan-warning">{{ !plan.origin ? '请先设置当前出发地点。' : '这两个地点之间还没有路线耗时。' }}补充后才会计算出发时间。</p>
      <p v-else-if="plan.routeStatus === 'not_needed'" class="campus-muted">已在目的地点；预留时间仍按你的缓冲设置计算。</p>
      <p v-else-if="plan.route" class="campus-muted">{{ plan.origin?.name }} → {{ plan.destination?.name }} · 约 {{ Math.ceil(plan.route.durationSeconds / 60) }} 分钟<br />{{ plan.route.source === 'manual' ? '手工估算，不含实时路况' : `路线记录于 ${dateLabel(plan.route.observedAt, plan.timezone)} ${clock(plan.route.observedAt, plan.timezone)}` }}</p>
      <p v-if="plan.isLate" class="campus-plan-warning">按当前时间与已记录耗时估算可能迟到，请核对行程。</p>
    </template>
    <template v-else>
      <p class="campus-eyebrow">给今天留一点余地</p>
      <h3>暂无待出发行程</h3>
      <p class="campus-muted">添加课程或日程，再根据地点与耗时安排出发。</p>
    </template>
    <div v-if="plan.nextEvent && plan.routeStatus !== 'unavailable'" class="campus-free-time">
      <strong>{{ plan.freeMinutes }} 分钟</strong><span class="campus-muted">出发前可用</span>
    </div>
    <div v-if="!compact && plan.recommendedTasks.length" class="campus-plan-tasks">
      <h4>这段空档可以做</h4>
      <ul><li v-for="task in plan.recommendedTasks" :key="task.id"><span>{{ task.title }}</span><small>{{ task.estimatedMinutes }} 分钟</small></li></ul>
    </div>
    <p v-if="plan.conflicts.length" class="campus-plan-warning" role="status">有 {{ plan.conflicts.length }} 个日程时间重叠，请在课表中核对。</p>
    <p v-if="!compact" class="campus-muted campus-plan-updated">计算时间 {{ clock(plan.at, plan.timezone) }} · {{ plan.timezone }}。后台提醒与实时定位尚未接入。</p>
  </div>
</template>

<style scoped>
.campus-plan { min-width: 0; color: var(--text-primary); }
.campus-plan h3 { margin: 8px 0; font-size: 22px; line-height: 1.4; overflow-wrap: anywhere; }
.campus-plan h4 { margin: 0 0 12px; font-size: 15px; }
.campus-eyebrow { margin: 0; font-size: 12px; letter-spacing: .03em; color: var(--text-secondary); }
.campus-muted { color: var(--text-secondary); font-size: 13px; line-height: 1.65; margin: 6px 0; overflow-wrap: anywhere; }
.campus-departure { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 16px; margin: 24px 0 16px; }
.campus-departure > div { display: grid; gap: 4px; }
.campus-departure strong { font-size: 36px; font-weight: 500; font-variant-numeric: tabular-nums; line-height: 1.1; }
.campus-status { border-radius: 999px; padding: 7px 12px; font-size: 13px; background: var(--accent-soft); color: var(--accent); }
.campus-plan[data-status="late"] .campus-status, .campus-plan[data-status="leave_now"] .campus-status { background: var(--md-sys-color-error-container, #fce7e7); color: var(--md-sys-color-on-error-container, #9b2b2b); }
.campus-plan-warning { color: var(--md-sys-color-error, var(--text-secondary)); font-size: 13px; line-height: 1.65; margin: 12px 0; }
.campus-free-time { display: flex; align-items: baseline; gap: 10px; border-top: 1px solid var(--border); padding-top: 16px; margin-top: 16px; }
.campus-free-time strong { font-weight: 500; font-size: 18px; }
.campus-plan-tasks { margin-top: 28px; }
.campus-plan-tasks ul { padding: 0; margin: 0; list-style: none; }
.campus-plan-tasks li { display: flex; justify-content: space-between; gap: 16px; padding: 12px 0; border-bottom: 1px solid var(--border); }
.campus-plan-tasks li span { overflow-wrap: anywhere; }
.campus-plan-tasks small { white-space: nowrap; color: var(--text-secondary); }
.campus-plan-updated { margin-top: 24px; font-size: 12px; }
</style>
