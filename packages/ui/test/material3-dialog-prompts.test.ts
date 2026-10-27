import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOMWrapper, mount } from '@vue/test-utils';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { ElMessageBox } from '../src/utils/element';
import { material3ContextKey } from '../src/material3/context';
import { materialDialogOpenKey } from '../src/material3/dialog-owner';
import { useDialogPrompts } from '../src/material3/dialog-prompts';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await nextTick();
  document.body.innerHTML = '';
});
function fixture(material = true, keepAlive = false) {
  let prompts!: ReturnType<typeof useDialogPrompts>;
  const ownerOpen = ref(true), requestOpen = ref(true), visible = ref(true);
  const Consumer = defineComponent({ setup() { prompts = useDialogPrompts(ElMessageBox, requestOpen); return () => h('div'); } });
  const wrapper = mount(defineComponent({ setup: () => () => keepAlive
    ? h(KeepAlive, () => visible.value ? h(Consumer) : null) : h(Consumer) }), {
    attachTo: document.body,
    global: { provide: { [material3ContextKey as symbol]: material, [materialDialogOpenKey as symbol]: ownerOpen } },
  });
  cleanups.push(() => wrapper.unmount());
  return { prompts, ownerOpen, requestOpen, visible, wrapper };
}
const dialog = () => document.querySelector('md-dialog')!;
// Vue Test Utils timestamps synthetic clicks after listener registration,
// including the dialog's capture listener and the button's target listener.
const click = (selector: string) => new DOMWrapper(dialog().querySelector(selector)!).trigger('click');
const closed = async () => { dialog().dispatchEvent(new Event('closed')); await nextTick(); };

describe('Material prompts owned by the requesting panel', () => {
  it('preserves the exact Element service for ordinary hosts', () => {
    expect(fixture(false).prompts).toBe(ElMessageBox);
    expect(document.querySelector('md-dialog')).toBeNull();
  });

  it('settles once only after native close restores focus and removes the detached root', async () => {
    const { prompts } = fixture();
    const result = prompts.confirm('删除预设？', '删除确认');
    const confirmed = vi.fn();
    void result.then(confirmed);
    await nextTick();
    await click('md-filled-button'); await click('md-filled-button');
    expect(confirmed).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    await closed(); expect(dialog()).toBeNull();
    await expect(result).resolves.toBe('confirm');
    expect(confirmed).toHaveBeenCalledTimes(1);
  });

  it('validates input and ignores IME Enter before accepting the original draft', async () => {
    const { prompts } = fixture();
    const validator = vi.fn((value: string) => value === 'ok' || '名称不能为空');
    const result = prompts.prompt('名称', '新建', { inputValue: '', inputValidator: validator });
    await nextTick();
    const input = dialog().querySelector('input')!;
    click('md-filled-button'); await nextTick();
    expect(dialog().querySelector('[role=alert]')?.textContent).toBe('名称不能为空');
    input.value = 'ok'; input.dispatchEvent(new Event('input')); await nextTick();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }));
    expect(validator).toHaveBeenCalledTimes(1);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await closed();
    await expect(result).resolves.toEqual({ value: 'ok', action: 'confirm' });
  });

  it('keeps thrown validators visible and does not mutate caller regex state', async () => {
    const { prompts } = fixture();
    const pattern = /ok/g;
    pattern.lastIndex = 2;
    const validator = vi.fn().mockImplementationOnce(() => { throw new Error('invalid'); }).mockReturnValue(true);
    const result = prompts.prompt('名称', '新建', { inputValue: 'ok', inputPattern: pattern, inputValidator: validator });
    await nextTick(); click('md-filled-button'); await nextTick();
    expect(dialog().querySelector('[role=alert]')?.textContent).toBe('无法验证输入，请重试');
    expect(pattern.lastIndex).toBe(2);
    await click('md-filled-button');
    await closed();
    await expect(result).resolves.toMatchObject({ value: 'ok' });
  });

  it('assigns distinct description IDs to overlapping detached prompt roots', async () => {
    const { prompts, wrapper } = fixture();
    const first = expect(prompts.prompt('第一个说明', '新建一')).rejects.toBe('cancel');
    const second = expect(prompts.prompt('第二个说明', '新建二')).rejects.toBe('cancel');
    await nextTick();
    const inputs = [...document.querySelectorAll('md-dialog input')];
    const descriptions = inputs.map(input => document.getElementById(input.getAttribute('aria-describedby')!));
    expect(descriptions.map(description => description?.textContent)).toEqual(['第一个说明', '第二个说明']);
    wrapper.unmount(); await Promise.all([first, second]);
  });

  it.each([false, true])('preserves cancel versus close policy (distinguish=%s)', async distinguish => {
    const { prompts } = fixture();
    const result = prompts.confirm('删除？', '确认', { distinguishCancelAndClose: distinguish });
    const rejected = expect(result).rejects.toBe(distinguish ? 'close' : 'cancel');
    await nextTick(); dialog().dispatchEvent(new Event('close')); await closed(); await rejected;
    const cancel = prompts.confirm('删除？', '确认', { distinguishCancelAndClose: distinguish });
    const cancelled = expect(cancel).rejects.toBe('cancel');
    await nextTick(); await click('md-filled-tonal-button'); await closed(); await cancelled;
  });

  it.each(['close', 'request-close', 'unmount', 'deactivate'] as const)('cancels pending work on owner %s and prevents a late confirmation', async action => {
    const { prompts, ownerOpen, requestOpen, visible, wrapper } = fixture(true, action === 'deactivate');
    const result = prompts.prompt('名称', '新建');
    const rejected = expect(result).rejects.toBe('cancel');
    await nextTick(); const button = dialog().querySelector('md-filled-button') as HTMLElement;
    if (action === 'close') ownerOpen.value = false;
    else if (action === 'request-close') requestOpen.value = false;
    else if (action === 'unmount') wrapper.unmount();
    else visible.value = false;
    await nextTick(); await nextTick(); await rejected;
    button.click(); expect(dialog()).toBeNull();
    await expect(prompts.confirm('删除？', '确认')).rejects.toBe('cancel');
    if (action === 'deactivate') {
      visible.value = true; await nextTick();
      const again = prompts.confirm('删除？', '确认');
      await nextTick(); await click('md-filled-button'); await closed(); await expect(again).resolves.toBe('confirm');
    }
  });

  it('cancels an answered prompt if its owner unmounts before native close completes', async () => {
    const { prompts, wrapper } = fixture();
    const result = prompts.confirm('删除？', '确认');
    const rejected = expect(result).rejects.toBe('cancel');
    await nextTick(); await click('md-filled-button');
    wrapper.unmount(); await rejected;
    expect(dialog()).toBeNull();
  });
});
