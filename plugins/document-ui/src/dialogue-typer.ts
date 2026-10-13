import { ref } from 'vue';

/**
 * 对话盒打字机：开场与整段文本逐字呈现；流式回复直接追加并闪烁光标。
 * 纯状态与小定时器，无副作用外泄；组件卸载时由 finish() 清理。
 */
export function useDialogueTyper(initial = '') {
  const shown = ref('');
  const streaming = ref(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  function clearTimer() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  /** 整段替换并以打字机呈现 */
  function say(text: string, _ctx?: string) {
    clearTimer();
    if (!text) {
      shown.value = '';
      streaming.value = true;
      return;
    }
    streaming.value = true;
    let i = 0;
    shown.value = '';
    timer = setInterval(() => {
      i += 1;
      shown.value = text.slice(0, i);
      if (i >= text.length) {
        clearTimer();
        streaming.value = false;
      }
    }, 26);
  }

  /** 流式增量直接追加（不打字机，避免追不上 token 流） */
  function appendDelta(text: string) {
    clearTimer();
    streaming.value = true;
    shown.value += text;
  }

  /** 流结束或组件卸载：停止光标闪烁与定时器 */
  function finish() {
    clearTimer();
    streaming.value = false;
  }

  if (initial) say(initial);
  return { shown, streaming, say, appendDelta, finish };
}
