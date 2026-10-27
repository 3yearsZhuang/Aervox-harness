import { shallowRef } from 'vue';
import { useMaterial3 } from '@aervox/ui/material3';
import type { ElMessage } from '@aervox/ui/utils/element';

export interface SettingsNotice { kind: 'success' | 'error' | 'warning'; text: string }

/** Keep phone feedback inside its modal surface; ordinary hosts keep toasts. */
export function useSettingsNotice(fallback: Pick<typeof ElMessage, 'success' | 'error' | 'warning'>) {
  const material3 = useMaterial3();
  const notice = shallowRef<SettingsNotice | null>(null);
  function show(kind: SettingsNotice['kind'], text: string) {
    if (material3) notice.value = {kind, text};
    else fallback[kind](text);
  }
  return { notice, clearNotice: () => { notice.value = null; }, notify: {
    success: (text: string) => show('success', text),
    error: (text: string) => show('error', text),
    warning: (text: string) => show('warning', text),
  } };
}
