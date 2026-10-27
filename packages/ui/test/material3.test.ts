import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { build } from 'esbuild';
import { createContext, runInContext } from 'node:vm';
import { resolve } from 'node:path';
import { AervoxButton, AervoxSwitch, AervoxDialog } from '../src/primitives';
import { material3ContextKey } from '../src/material3/context';

const global = { provide: { [material3ContextKey as symbol]: true } };
describe('explicit Material 3 primitive adaptation', () => {
  it('uses official Material buttons only when the host opts in, preserving disabled/loading control', async () => {
    const desktop = mount(AervoxButton, { slots: { default: '发送' } });
    expect(desktop.element.tagName).toBe('BUTTON'); desktop.unmount();
    const button = mount(AervoxButton, { props: { variant: 'primary', loading: true }, slots: { default: '发送' }, global });
    expect(button.element.tagName).toBe('MD-FILLED-BUTTON');
    await button.trigger('click'); expect(button.emitted('click')).toBeUndefined();
    await button.setProps({ loading: false }); await button.trigger('click'); expect(button.emitted('click')).toHaveLength(1);
    await button.setProps({ iconOnly: true }); expect(button.element.tagName).toBe('MD-ICON-BUTTON'); button.unmount();
  });
  it('restores a controlled Material switch when an authorization request is declined', async () => {
    const wrapper = mount(AervoxSwitch, { props: { modelValue: false }, global });
    const element = wrapper.element as HTMLElement & { selected: boolean };
    expect(element.tagName).toBe('MD-SWITCH');
    element.selected = true; await wrapper.trigger('change'); await nextTick();
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]]);
    const event = wrapper.emitted('change')![0]![0] as Event;
    expect((event.target as HTMLInputElement).checked).toBe(false);
    (event.target as HTMLInputElement).checked = true; expect(element.selected).toBe(true);
    (event.target as HTMLInputElement).checked = false; expect(element.selected).toBe(false); wrapper.unmount();
  });
  it('keeps dialog content through closing, forwards lifecycle and honors Escape policy', async () => {
    const wrapper = mount(AervoxDialog, { props: { modelValue: true, title: '设置', destroyOnClose: true, closeOnPressEscape: false },
      slots: { default: '<input aria-label="保留草稿" />' }, global, attachTo: document.body });
    await nextTick(); const dialog = document.querySelector('md-dialog')!;
    expect((dialog as HTMLElement & { open: boolean }).open).toBe(true);
    const key = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    dialog.dispatchEvent(key); expect(key.defaultPrevented).toBe(true);
    const cancel = new Event('cancel', { cancelable: true }); dialog.dispatchEvent(cancel); expect(cancel.defaultPrevented).toBe(true);
    await wrapper.setProps({ modelValue: false });
    expect(dialog.querySelector('input')).not.toBeNull();
    dialog.dispatchEvent(new Event('close')); dialog.dispatchEvent(new Event('closed')); await nextTick();
    expect(wrapper.emitted('closed')).toHaveLength(1);
    expect(dialog.querySelector('input')).toBeNull(); wrapper.unmount();
  });
  it('generates complete light/dark role palettes with readable semantic pairings from the official utility', async () => {
    // Bundle the actual browser entry: upstream 0.4 includes extensionless ESM
    // imports that native Node resolution cannot load without a bundler.
    const built = await build({ entryPoints: [resolve('src/material3/palette.ts')], bundle: true,
      platform: 'browser', format: 'iife', globalName: 'Palette', write: false, logLevel: 'silent' });
    const context = createContext({}); runInContext(built.outputFiles![0]!.text, context);
    const palettes = runInContext('[Palette.material3Palette(false), Palette.material3Palette(true)]', context) as Record<string, string>[];
    const luminance = (hex: string) => {
      const rgb = hex.slice(1).match(/../g)!.map(x => parseInt(x, 16) / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
      return .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]!;
    };
    for (const palette of palettes) {
      for (const role of ['surface-container-lowest','surface-container','surface-container-highest','surface-variant','shadow','scrim']) expect(palette[`--md-sys-color-${role}`]).toMatch(/^#[0-9a-f]{6}$/);
      for (const [fg,bg] of [['on-surface','surface'],['on-surface-variant','surface-container-high'],['on-primary','primary'],['on-primary-container','primary-container'],['on-error','error']]) {
        const a=luminance(palette[`--md-sys-color-${fg}`]!), b=luminance(palette[`--md-sys-color-${bg}`]!);
        expect((Math.max(a,b)+.05)/(Math.min(a,b)+.05), `${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(palettes[0]!['--md-sys-color-surface']).not.toBe(palettes[1]!['--md-sys-color-surface']);
  });
});
