import { describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { createMobileBackNavigation, mobileBackNavigationKey, type MobileBackHost } from '../src/material3/mobile-back-navigation';
import { material3ContextKey } from '../src/material3/context';
import AervoxDialog from '../src/primitives/dialog/AervoxDialog.vue';
import AervoxDrawer from '../src/primitives/drawer/AervoxDrawer.vue';

/** History traversal is deliberately asynchronous, just like browser popstate. */
class FakeHost implements MobileBackHost {
  location = { href: 'https://localhost/' };
  entries: { state: unknown; url: string }[] = [{ state: { hostField: 'preserved' }, url: this.location.href }];
  index = 0;
  pending: { index: number; committed?: () => void }[] = [];
  listeners = new Set<(event: PopStateEvent) => void>();
  navigation = {
    get currentEntry() { return this.host.navigation.entries()[this.host.index]!; },
    host: this,
    entries: vi.fn(() => this.entries.map((entry, index) => ({ key: `entry_${index}`, index, url: entry.url, sameDocument: true }))),
    traverseTo: vi.fn((key: string) => {
      const target = this.navigation.entries().find(entry => entry.key === key)?.index;
      if (target === undefined) throw new Error('Unknown navigation key');
      let committed!: () => void;
      const done = new Promise<void>(resolve => { committed = resolve; });
      this.pending.push({ index: target, committed });
      return { committed: done, finished: done };
    }),
  };
  history = {
    get state(): unknown { return this.host.entries[this.host.index]!.state; },
    host: this,
    pushState: vi.fn((state: unknown, _unused: string, url?: string | URL | null) => {
      this.entries.splice(this.index + 1);
      this.entries.push({ state: structuredClone(state), url: String(url ?? this.location.href) });
      this.index++;
    }),
    replaceState: vi.fn((state: unknown, _unused: string, url?: string | URL | null) => {
      this.entries[this.index] = { state: structuredClone(state), url: String(url ?? this.location.href) };
    }),
    back: vi.fn(() => { if (this.index > 0) this.pending.push({ index: this.index - 1 }); }),
  };
  addEventListener(_type: 'popstate', callback: (event: PopStateEvent) => void) { this.listeners.add(callback); }
  removeEventListener(_type: 'popstate', callback: (event: PopStateEvent) => void) { this.listeners.delete(callback); }
  pop() {
    const target = this.pending.shift();
    if (target === undefined) throw new Error('No pending traversal');
    const changed = this.index !== target.index;
    this.index = target.index; this.location.href = this.entries[target.index]!.url;
    if (changed) this.emit(this.history.state);
    target.committed?.();
  }
  emit(state: unknown) { for (const listener of this.listeners) listener({ state } as PopStateEvent); }
  userBack() { this.history.back(); this.pop(); }
}
function setup() {
  const host = new FakeHost(); let id = 0;
  const navigation = createMobileBackNavigation(host, () => String(++id));
  return { host, navigation };
}

describe('mobile history UI ownership', () => {
  it('does not change history until a mobile layer is registered', () => {
    const { host, navigation } = setup();
    expect(host.history.pushState).not.toHaveBeenCalled();
    navigation.dispose();
    expect(host.history.replaceState).not.toHaveBeenCalled();
    expect(host.history.back).not.toHaveBeenCalled();
  });
  it('backs through nested UI in order with one guard and preserves foreign state', () => {
    const { host, navigation } = setup(); const closed: string[] = [];
    navigation.registerLayer({ onBack: () => closed.push('input') });
    navigation.registerLayer({ onBack: () => closed.push('settings') });
    expect(host.entries).toHaveLength(2);
    expect((host.history.state as Record<string, unknown>).hostField).toBe('preserved');
    host.userBack(); expect(closed).toEqual(['settings']);
    expect(host.entries).toHaveLength(2);
    host.userBack(); expect(closed).toEqual(['settings', 'input']);
    expect(host.history.state).toEqual({ hostField: 'preserved' });
    expect(host.index).toBe(0); navigation.dispose();
  });
  it('queues a newly opened layer behind the preceding asynchronous UI close', () => {
    const { host, navigation } = setup(); const oldBack = vi.fn(), newBack = vi.fn();
    const oldLayer = navigation.registerLayer({ onBack: oldBack });
    oldLayer.close();
    navigation.registerLayer({ onBack: newBack });
    expect(host.history.back).toHaveBeenCalledTimes(1);
    expect(host.history.pushState).toHaveBeenCalledTimes(1);
    host.pop();
    expect(oldBack).not.toHaveBeenCalled(); expect(newBack).not.toHaveBeenCalled();
    expect(host.history.pushState).toHaveBeenCalledTimes(2);
    host.userBack(); expect(newBack).toHaveBeenCalledTimes(1); navigation.dispose();
  });
  it('does not consume history twice when Back also causes a close callback and watcher', () => {
    const { host, navigation } = setup();
    const layer = navigation.registerLayer({ onBack: () => layer.close() });
    host.userBack(); layer.close(); layer.dispose();
    expect(host.history.back).toHaveBeenCalledTimes(1);
    expect(host.pending).toHaveLength(0); navigation.dispose();
  });
  it('lets a close callback immediately open a new layer without consuming that new layer', () => {
    const { host, navigation } = setup(); const newBack = vi.fn();
    navigation.registerLayer({ onBack: () => { navigation.registerLayer({ onBack: newBack }); } });
    host.userBack(); expect(newBack).not.toHaveBeenCalled();
    host.userBack(); expect(newBack).toHaveBeenCalledTimes(1); navigation.dispose();
  });
  it('re-arms a blocked Back and reevaluates its current dismissal policy', () => {
    const { host, navigation } = setup(); let allowed = false; const close = vi.fn();
    navigation.registerLayer({ onBack: close, canDismiss: () => allowed });
    host.userBack(); expect(close).not.toHaveBeenCalled(); expect(host.index).toBe(1);
    allowed = true; host.userBack(); expect(close).toHaveBeenCalledTimes(1); expect(host.index).toBe(0); navigation.dispose();
  });
  it('allows an explicit close despite a disabled Back policy', () => {
    const { host, navigation } = setup(); const back = vi.fn();
    navigation.registerLayer({ onBack: back, canDismiss: () => false }).close();
    host.pop(); expect(back).not.toHaveBeenCalled(); expect(host.index).toBe(0); navigation.dispose();
  });
  it('retires an unmounted layer without traversing or disturbing a newer layer', () => {
    const { host, navigation } = setup(); const oldBack = vi.fn(), newBack = vi.fn();
    const oldLayer = navigation.registerLayer({ onBack: oldBack });
    navigation.registerLayer({ onBack: newBack }); oldLayer.dispose();
    expect(host.history.back).not.toHaveBeenCalled();
    host.userBack(); expect(newBack).toHaveBeenCalledTimes(1); expect(oldBack).not.toHaveBeenCalled(); navigation.dispose();
  });
  it('does not initiate traversal during layer or manager teardown', () => {
    const { host, navigation } = setup(); const back = vi.fn();
    navigation.registerLayer({ onBack: back }).dispose(); navigation.dispose();
    expect(host.history.back).not.toHaveBeenCalled(); expect(back).not.toHaveBeenCalled();
    expect(host.history.state).toEqual({ hostField: 'preserved' });
  });
  it('waits for the actual queued cleanup before allowing a document replacement', async () => {
    const { host, navigation } = setup(); const back = vi.fn();
    navigation.registerLayer({ onBack: back }).close();
    const leave = navigation.whenSettled().then(() => { host.location.href = 'https://localhost/?surface=workbench-ui'; });
    await Promise.resolve(); expect(host.location.href).toBe('https://localhost/');
    expect(host.pending).toHaveLength(1);
    host.pop(); await leave;
    expect(host.pending).toHaveLength(0);
    const replacements = host.history.replaceState.mock.calls.length;
    navigation.dispose(); host.emit({ stale: true });
    expect(host.history.replaceState).toHaveBeenCalledTimes(replacements);
    expect(host.location.href).toBe('https://localhost/?surface=workbench-ui');
    expect(host.history.back).toHaveBeenCalledTimes(1); expect(back).not.toHaveBeenCalled();
  });
  it('does not claim that disposal can cancel an already submitted browser traversal', async () => {
    const { host, navigation } = setup();
    navigation.registerLayer({ onBack: vi.fn() }).close();
    const settled = navigation.whenSettled();
    navigation.dispose();
    await expect(settled).rejects.toThrow('mobile_back_navigation_disposed');
    expect(host.pending).toHaveLength(1);
    expect(host.history.back).toHaveBeenCalledTimes(1);
  });
  it('ignores stale guards and another owner instead of closing current UI', () => {
    const { host, navigation } = setup(); const close = vi.fn();
    navigation.registerLayer({ onBack: close }); const guard = host.history.state;
    host.emit(guard); host.emit({ __aervoxMobileBack: { owner: 'elsewhere', token: '2', kind: 'base', original: null } });
    expect(close).not.toHaveBeenCalled(); expect(host.history.pushState).toHaveBeenCalledTimes(1); navigation.dispose();
  });
  it('keeps a throwing UI callback guarded instead of exiting past an open layer', () => {
    const { host, navigation } = setup(); const close = vi.fn(() => { throw new Error('UI failure'); });
    navigation.registerLayer({ onBack: close }); host.userBack();
    expect(close).toHaveBeenCalledTimes(1); expect(host.index).toBe(1); navigation.dispose();
  });
  it('leaves UI usable and restores the exact host state when history cannot be armed', () => {
    const { host, navigation } = setup();
    host.entries[0]!.state = 42;
    host.history.pushState.mockImplementationOnce(() => { throw new DOMException('blocked'); });
    const close = vi.fn(); const layer = navigation.registerLayer({ onBack: close });
    expect(host.history.state).toBe(42); layer.close();
    expect(host.history.back).not.toHaveBeenCalled(); navigation.dispose();
  });
});

describe('inherited mobile history after a cold reload', () => {
  let documentNumber = 0;
  function nextDocument(host: FakeHost) {
    // Browser reload retains the session history/state, but not old JS listeners.
    host.listeners.clear(); let id = 0; const documentId = ++documentNumber;
    return createMobileBackNavigation(host, () => `next_${documentId}_${++id}`);
  }
  it('consumes an inherited guard before registering a restored input and avoids growing history on repeated reload', async () => {
    const { host, navigation } = setup(); navigation.registerLayer({ onBack: vi.fn() });
    let current = navigation; const visibleBack = vi.fn();
    for (let reload = 0; reload < 3; reload++) {
      current = nextDocument(host);
      const pushes = host.history.pushState.mock.calls.length;
      current.registerLayer({ onBack: visibleBack });
      expect(host.history.pushState).toHaveBeenCalledTimes(pushes);
      expect(host.pending).toHaveLength(1);
      host.pop(); await flushPromises();
      expect(host.entries).toHaveLength(2);
      expect(JSON.stringify(host.history.state).match(/__aervoxMobileBack/g)).toHaveLength(1);
      expect(visibleBack).not.toHaveBeenCalled();
    }
    host.userBack(); expect(visibleBack).toHaveBeenCalledTimes(1);
    expect(host.index).toBe(0); expect(host.history.state).toEqual({ hostField: 'preserved' });
    current.dispose();
  });
  it('cleans an inherited guard even when no new layer is restored', async () => {
    const { host, navigation } = setup(); navigation.registerLayer({ onBack: vi.fn() });
    const current = nextDocument(host); host.pop(); await flushPromises();
    expect(host.index).toBe(0); expect(host.history.state).toEqual({ hostField: 'preserved' });
    expect(host.history.pushState).toHaveBeenCalledTimes(1); current.dispose();
  });
  it('consumes nested legacy guard pairs in order without putting old wrappers into a new guard', async () => {
    const { host, navigation } = setup(); navigation.registerLayer({ onBack: vi.fn() });
    const original = host.history.state;
    const legacy = (kind: 'base' | 'guard') => ({ __aervoxMobileBack: { owner: 'legacy', token: 'legacy_pair', kind, original } });
    host.history.replaceState(legacy('base'), '', host.location.href);
    host.history.pushState(legacy('guard'), '', host.location.href);
    const current = nextDocument(host); current.registerLayer({ onBack: vi.fn() });
    host.pop(); await flushPromises(); expect(host.pending).toHaveLength(1); host.pop(); await flushPromises();
    expect(host.entries).toHaveLength(2); expect(host.navigation.traverseTo.mock.calls.map(([key]) => key)).toEqual(['entry_1', 'entry_0']);
    expect(JSON.stringify(host.history.state).match(/__aervoxMobileBack/g)).toHaveLength(1);
    host.userBack(); expect(host.history.state).toEqual({ hostField: 'preserved' }); current.dispose();
  });
  it('normalizes a base inherited after the old traversal committed without traversing again', () => {
    const { host, navigation } = setup(); navigation.registerLayer({ onBack: vi.fn() });
    host.listeners.clear(); host.history.back(); host.pop();
    const current = nextDocument(host); current.registerLayer({ onBack: vi.fn() });
    expect(host.navigation.traverseTo).not.toHaveBeenCalled(); expect(host.entries).toHaveLength(2);
    host.userBack(); expect(host.history.state).toEqual({ hostField: 'preserved' }); current.dispose();
  });
  it('refuses automatic traversal to another URL or document and only strips its current metadata', () => {
    for (const wrong of ['url', 'document']) {
      const { host, navigation } = setup(); navigation.registerLayer({ onBack: vi.fn() });
      if (wrong === 'url') host.entries[0]!.url = 'https://localhost/other';
      else host.navigation.entries.mockImplementation(() => host.entries.map((entry, index) => ({ key: `entry_${index}`, index, url: entry.url, sameDocument: index !== 0 })));
      const current = nextDocument(host);
      expect(host.navigation.traverseTo).not.toHaveBeenCalled(); expect(host.pending).toHaveLength(0);
      expect(host.location.href).toBe('https://localhost/'); expect(host.history.state).toEqual({ hostField: 'preserved' }); current.dispose();
    }
  });
  it('finishes recovery without a second popstate when an old cleanup already reached the absolute target key', async () => {
    const { host, navigation } = setup(); const old = navigation.registerLayer({ onBack: vi.fn() });
    old.close();
    const current = nextDocument(host); const back = vi.fn(); current.registerLayer({ onBack: back });
    const barrier = current.whenSettled();
    expect(host.pending).toHaveLength(2);
    host.pop(); await flushPromises();
    expect(host.history.pushState).toHaveBeenCalledTimes(1); expect(back).not.toHaveBeenCalled();
    host.pop(); await barrier;
    expect(host.history.pushState).toHaveBeenCalledTimes(2); expect(back).not.toHaveBeenCalled();
    expect(host.entries).toHaveLength(2);
    host.userBack(); expect(back).toHaveBeenCalledTimes(1); expect(host.index).toBe(0); current.dispose();
  });
  it('rejects a waiting reload barrier when a nested inherited base cannot be restored', async () => {
    const { host, navigation } = setup(); navigation.registerLayer({ onBack: vi.fn() });
    const guard = host.history.state as Record<string, unknown>;
    const outer = guard.__aervoxMobileBack as Record<string, unknown>;
    const innerBase = { __aervoxMobileBack: { owner: 'inner', token: 'inner', kind: 'base', original: { hostField: 'preserved' } } };
    host.history.replaceState({ __aervoxMobileBack: { ...outer, original: innerBase } }, '', host.location.href);
    const current = nextDocument(host);
    const barrier = current.whenSettled();
    await Promise.resolve();
    host.history.replaceState.mockImplementationOnce((state, _unused, url) => {
      host.entries[host.index] = { state: structuredClone(state), url: String(url) };
    }).mockImplementationOnce(() => { throw new Error('nested base restoration blocked'); });
    host.pop();
    await expect(barrier).rejects.toThrow('mobile_back_inherited_cleanup_failed');
    expect(host.history.pushState).toHaveBeenCalledTimes(1); current.dispose();
  });
  it('catches both Navigation promises and rejects the reload barrier when inherited traversal fails', async () => {
    const { host, navigation } = setup(); navigation.registerLayer({ onBack: vi.fn() });
    host.navigation.traverseTo.mockImplementation(() => ({ committed: Promise.reject(new Error('committed failed')), finished: Promise.reject(new Error('finished failed')) }));
    const current = nextDocument(host);
    await expect(current.whenSettled()).rejects.toThrow('mobile_back_inherited_cleanup_failed');
    expect(host.history.pushState).toHaveBeenCalledTimes(1); current.dispose();
  });
});

describe('shared mobile layer registration', () => {
  it('flushes a queued model close before releasing the navigation barrier', async () => {
    const { host, navigation } = setup(); const open = ref(true);
    const shell = defineComponent({ setup: () => () => h(AervoxDialog, { modelValue: open.value, title: '设置' }) });
    const wrapper = mount(shell, { global: { provide: {
      [material3ContextKey as symbol]: true, [mobileBackNavigationKey as symbol]: navigation,
    } }, attachTo: document.body });
    await nextTick();
    open.value = false;
    let left = false;
    const leave = navigation.whenSettled().then(() => { left = true; });
    await nextTick(); await Promise.resolve();
    expect(host.pending).toHaveLength(1); expect(left).toBe(false);
    host.pop(); await leave; expect(left).toBe(true);
    wrapper.unmount(); navigation.dispose();
  });
  it('treats keyless native cancel as Back and only a shadow backdrop click as modal cancellation', async () => {
    const wrapper = mount(AervoxDialog, { props: { modelValue: true, title: '设置', closeOnClickModal: true, closeOnPressEscape: false },
      global: { provide: { [material3ContextKey as symbol]: true } }, attachTo: document.body });
    await nextTick();
    const host = document.querySelector('md-dialog')!;
    const nativeDialog = document.createElement('dialog');
    host.attachShadow({ mode: 'open' }).append(nativeDialog);
    const back = new Event('cancel', { cancelable: true }); host.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    nativeDialog.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const modal = new Event('cancel', { cancelable: true }); host.dispatchEvent(modal);
    expect(modal.defaultPrevented).toBe(false);
    await wrapper.setProps({ closeOnClickModal: false, closeOnPressEscape: true });
    nativeDialog.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    const blockedModal = new Event('cancel', { cancelable: true }); host.dispatchEvent(blockedModal);
    expect(blockedModal.defaultPrevented).toBe(true);
    const allowedBack = new Event('cancel', { cancelable: true }); host.dispatchEvent(allowedBack);
    expect(allowedBack.defaultPrevented).toBe(false);
    wrapper.unmount();
  });
  it('registers Material Dialog Back independently of backdrop policy and consumes close once', async () => {
    const { host, navigation } = setup();
    const wrapper = mount(AervoxDialog, { props: { modelValue: true, title: '设置', closeOnClickModal: false, closeOnPressEscape: false },
      global: { provide: { [material3ContextKey as symbol]: true, [mobileBackNavigationKey as symbol]: navigation } }, attachTo: document.body });
    await nextTick(); host.userBack(); expect(wrapper.emitted('update:modelValue')).toBeUndefined();
    await wrapper.setProps({ closeOnPressEscape: true }); host.userBack();
    expect(wrapper.emitted('update:modelValue')).toEqual([[false]]);
    await wrapper.setProps({ modelValue: false });
    expect(host.history.back).toHaveBeenCalledTimes(2);
    wrapper.unmount(); navigation.dispose();
  });
  it('registers the drawer with the injected owner and never traverses on unmount', async () => {
    const { host, navigation } = setup();
    const wrapper = mount(AervoxDrawer, { props: { modelValue: true },
      global: { provide: { [mobileBackNavigationKey as symbol]: navigation } }, attachTo: document.body });
    await nextTick(); host.userBack(); expect(wrapper.emitted('close')).toHaveLength(1);
    await wrapper.setProps({ modelValue: false });
    expect(host.history.back).toHaveBeenCalledTimes(1);
    wrapper.unmount(); navigation.dispose();
  });
});
