import { createVNode, getCurrentInstance, inject, nextTick, onActivated, onBeforeUnmount, onDeactivated, render, watch, type Ref } from 'vue';
import { ElMessageBox } from '../utils/element';
import { material3ContextKey, useMaterial3 } from './context';
import { materialDialogOpenKey } from './dialog-owner';
import DialogPrompt from './DialogPrompt.vue';

let promptSequence = 0;

export interface DialogPromptOptions {
  type?: '' | 'primary' | 'success' | 'warning' | 'info' | 'error';
  confirmButtonText?: string;
  cancelButtonText?: string;
  inputValue?: string;
  inputPlaceholder?: string;
  inputPattern?: RegExp;
  inputValidator?: (value: string) => boolean | string;
  inputErrorMessage?: string;
  closeOnClickModal?: boolean;
  closeOnPressEscape?: boolean;
  distinguishCancelAndClose?: boolean;
}
export type DialogPromptAction = 'confirm' | 'cancel' | 'close';

/** Native modal prompts; ordinary hosts keep the original Element service. */
export function useDialogPrompts(
  fallback: Pick<typeof ElMessageBox, 'confirm' | 'prompt'> = ElMessageBox,
  ownerOpen?: Readonly<Ref<boolean>>,
) {
  if (!useMaterial3()) return fallback;
  const instance = getCurrentInstance();
  if (!instance) throw new Error('dialog_prompts_require_setup');
  const parentOpen = inject(materialDialogOpenKey, undefined);
  const ownerClosed = () => ownerOpen?.value === false || parentOpen?.value === false;
  const context = { ...instance.appContext, provides: {
    ...instance.appContext.provides, [material3ContextKey as symbol]: true,
  } };
  const pending = new Set<{ dismiss(): void; destroy(): void }>();
  let disposed = false;
  let active = true;

  function open(kind: 'confirm' | 'prompt', message: string, title: string, options: DialogPromptOptions = {}) {
    if (disposed || !active || ownerClosed()) return Promise.reject('cancel');
    return new Promise<{ value: string; action: 'confirm' }>((resolve, reject) => {
      const container = document.createElement('div');
      let settled = false;
      let destroyed = false;
      let answer: { action: DialogPromptAction; value: string } | undefined;
      const settle = (action: DialogPromptAction, value: string) => {
        if (settled) return;
        settled = true;
        if (action === 'confirm') resolve({ value, action });
        else reject(action === 'close' && options.distinguishCancelAndClose ? 'close' : 'cancel');
      };
      const destroy = () => {
        if (destroyed) return;
        destroyed = true;
        settle('close', '');
        render(null, container);
        container.remove();
        pending.delete(binding);
      };
      const dismiss = () => {
        if (destroyed) return;
        vnode.component?.exposed?.dismiss();
        settle('close', '');
        // Flush a live close before removal; page teardown only destroys.
        void nextTick(destroy);
      };
      const binding = { dismiss, destroy };
      const vnode = createVNode(DialogPrompt, {
        id: `avx-dialog-prompt-${++promptSequence}`, kind, message, title, options,
        onAnswer: (action: DialogPromptAction, value: string) => { answer ??= { action, value }; },
        onClosed: () => {
          // Native close restores the trigger's focus. Only then may the caller
          // open another prompt; otherwise it inherits a soon-to-be-removed target.
          if (answer) settle(answer.action, answer.value);
          destroy();
        },
      });
      vnode.appContext = context;
      pending.add(binding);
      document.body.append(container);
      try { render(vnode, container); }
      catch (error) { if (!settled) { settled = true; reject(error); } destroy(); }
    });
  }
  if (ownerOpen || parentOpen) watch(ownerClosed, closed => {
    if (closed) for (const prompt of [...pending]) prompt.dismiss();
  }, { flush: 'sync' });
  onActivated(() => { active = true; });
  onDeactivated(() => { active = false; for (const prompt of [...pending]) prompt.dismiss(); });
  onBeforeUnmount(() => {
    disposed = true;
    for (const prompt of [...pending]) prompt.destroy();
  });
  return {
    confirm: (message: string, title: string, options?: DialogPromptOptions) => open('confirm', message, title, options).then(() => 'confirm' as const),
    prompt: (message: string, title: string, options?: DialogPromptOptions) => open('prompt', message, title, options),
  };
}
