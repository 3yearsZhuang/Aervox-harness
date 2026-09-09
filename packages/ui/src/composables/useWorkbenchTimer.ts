import { computed, onMounted, onUnmounted, ref } from 'vue';

// 环形表盘几何常数 (SVG viewBox 0 0 200 200, 中心 100,100, 半径 80)
export const DIAL_RADIUS = 80;
export const DIAL_CIRCUMFERENCE = 2 * Math.PI * DIAL_RADIUS;

// 番茄钟土司倒计时环几何常数 (SVG viewBox 0 0 44 44, 中心 22,22, 半径 18)
export const TOAST_RING_RADIUS = 18;
export const TOAST_RING_CIRCUMFERENCE = 2 * Math.PI * TOAST_RING_RADIUS;

export function useWorkbenchTimer(options?: { onSaveSettings?: () => void; onPetReact?: (kind: 'nod' | 'tilthead') => void }) {
  const timerMinutes = ref(25);
  const timerSeconds = ref(25 * 60);
  const timerRunning = ref(false);
  const timerDialRef = ref<SVGSVGElement | null>(null);
  const isDraggingDial = ref(false);

  const formattedTime = computed(() => {
    const minutes = String(Math.floor(timerSeconds.value / 60)).padStart(2, '0');
    const seconds = String(timerSeconds.value % 60).padStart(2, '0');
    return `${minutes}:${seconds}`;
  });

  const timerRatio = computed(() => {
    if (timerRunning.value) {
      const total = Math.max(timerMinutes.value * 60, 1);
      return Math.max(0, Math.min(1, timerSeconds.value / total));
    }
    return Math.max(0, Math.min(1, timerMinutes.value / 60));
  });

  const timerArcDashoffset = computed(() => {
    return DIAL_CIRCUMFERENCE * (1 - timerRatio.value);
  });

  const toastRingDashoffset = computed(() => {
    return TOAST_RING_CIRCUMFERENCE * (1 - timerRatio.value);
  });

  const thumbAngle = computed(() => {
    return timerRatio.value * 360;
  });

  function toggleTimer() {
    timerRunning.value = !timerRunning.value;
    if (timerRunning.value) {
      options?.onPetReact?.('nod');
    } else {
      options?.onPetReact?.('tilthead');
    }
  }

  function resetTimer() {
    timerRunning.value = false;
    timerSeconds.value = timerMinutes.value * 60;
  }

  function selectPresetMinutes(minutes: number) {
    if (timerRunning.value) return;
    timerMinutes.value = minutes;
    timerSeconds.value = minutes * 60;
    options?.onSaveSettings?.();
  }

  function calculateMinutesFromEvent(event: MouseEvent | TouchEvent): number | null {
    const svg = timerDialRef.value;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const clientX = 'touches' in event ? event.touches[0].clientX : event.clientX;
    const clientY = 'touches' in event ? event.touches[0].clientY : event.clientY;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = clientX - cx;
    const dy = clientY - cy;
    let deg = Math.atan2(dy, dx) * (180 / Math.PI) + 90;
    if (deg < 0) deg += 360;
    const rawMin = (deg / 360) * 60;
    return Math.max(1, Math.min(60, Math.round(rawMin)));
  }

  function handleDialPointerMove(event: MouseEvent | TouchEvent) {
    if (!isDraggingDial.value || timerRunning.value) return;
    if ('touches' in event) event.preventDefault();
    const min = calculateMinutesFromEvent(event);
    if (min !== null && min !== timerMinutes.value) {
      timerMinutes.value = min;
      timerSeconds.value = min * 60;
    }
  }

  function handleDialPointerUp() {
    if (isDraggingDial.value) {
      isDraggingDial.value = false;
      options?.onSaveSettings?.();
    }
    window.removeEventListener('mousemove', handleDialPointerMove);
    window.removeEventListener('mouseup', handleDialPointerUp);
    window.removeEventListener('touchmove', handleDialPointerMove);
    window.removeEventListener('touchend', handleDialPointerUp);
  }

  function handleDialPointerDown(event: MouseEvent | TouchEvent) {
    if (timerRunning.value) return;
    isDraggingDial.value = true;
    const min = calculateMinutesFromEvent(event);
    if (min !== null) {
      timerMinutes.value = min;
      timerSeconds.value = min * 60;
    }
    window.addEventListener('mousemove', handleDialPointerMove);
    window.addEventListener('mouseup', handleDialPointerUp);
    window.addEventListener('touchmove', handleDialPointerMove, { passive: false });
    window.addEventListener('touchend', handleDialPointerUp);
  }

  let timerInterval: number | undefined;

  onMounted(() => {
    timerInterval = window.setInterval(() => {
      if (timerRunning.value && timerSeconds.value > 0) {
        timerSeconds.value -= 1;
      }
      if (timerSeconds.value === 0) {
        timerRunning.value = false;
      }
    }, 1000);
  });

  onUnmounted(() => {
    if (timerInterval) window.clearInterval(timerInterval);
    window.removeEventListener('mousemove', handleDialPointerMove);
    window.removeEventListener('mouseup', handleDialPointerUp);
    window.removeEventListener('touchmove', handleDialPointerMove);
    window.removeEventListener('touchend', handleDialPointerUp);
  });

  return {
    timerMinutes,
    timerSeconds,
    timerRunning,
    timerDialRef,
    isDraggingDial,
    formattedTime,
    timerRatio,
    timerArcDashoffset,
    toastRingDashoffset,
    thumbAngle,
    toggleTimer,
    resetTimer,
    selectPresetMinutes,
    handleDialPointerDown,
  };
}

export type WorkbenchTimerComposable = ReturnType<typeof useWorkbenchTimer>;
