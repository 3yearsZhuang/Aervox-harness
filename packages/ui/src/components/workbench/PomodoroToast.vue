<script setup lang="ts">
import { Pause, TimerReset } from 'lucide-vue-next';
import { useWorkbenchContext } from '../../composables/workbench-context';
import { TOAST_RING_RADIUS, TOAST_RING_CIRCUMFERENCE } from '../../composables/useWorkbenchTimer';

const { timer } = useWorkbenchContext();
const {
  timerRunning,
  timerMinutes,
  formattedTime,
  toastRingDashoffset,
  toggleTimer,
  resetTimer,
} = timer;
</script>

<template>
  <Transition name="timer-toast">
    <div v-if="timerRunning" class="timer-toast" role="status" aria-live="polite" aria-label="番茄钟倒计时通知">
      <svg class="timer-toast-ring" viewBox="0 0 44 44" aria-hidden="true">
        <circle class="timer-toast-track" cx="22" cy="22" :r="TOAST_RING_RADIUS" />
        <circle
          class="timer-toast-progress"
          cx="22"
          cy="22"
          :r="TOAST_RING_RADIUS"
          :stroke-dasharray="TOAST_RING_CIRCUMFERENCE"
          :stroke-dashoffset="toastRingDashoffset"
        />
      </svg>
      <div class="timer-toast-body">
        <strong class="timer-toast-time">{{ formattedTime }}</strong>
        <small class="timer-toast-label">专注中 · {{ timerMinutes }} 分钟回合</small>
      </div>
      <div class="timer-toast-ops">
        <button type="button" aria-label="暂停专注" @click="toggleTimer()">
          <Pause :size="14" />
        </button>
        <button type="button" aria-label="重置番茄钟" @click="resetTimer()">
          <TimerReset :size="14" />
        </button>
      </div>
    </div>
  </Transition>
</template>
