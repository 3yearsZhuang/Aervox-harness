import { describe, expect, it, vi } from 'vitest';
import { setImmediate as flushPromises } from 'node:timers/promises';
import { createMobileSurfaceLocation } from '../src/mobile-surface-location';
import { createSurfaceNavigation } from '../../../packages/ui-host/src/resolve-surface';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function setup(wait: () => Promise<void>) {
  const target = { href: 'https://localhost/?x=1#anchor', replace: vi.fn(), reload: vi.fn() };
  const failure = vi.fn();
  const wrapper = createMobileSurfaceLocation(target, wait, failure);
  const preferences = new Map<string, string>();
  const navigation = createSurfaceNavigation([{ id: 'home' }, { id: 'workbench' }], {
    currentSurfaceId: 'home', defaultSurfaceId: 'home', storageKey: 'choice',
    storage: { setItem: (key, value) => { preferences.set(key, value); } }, location: wrapper.location,
  });
  return { target, failure, wrapper, navigation, preferences };
}

describe('mobile composition root surface replacement', () => {
  it('waits for cleanup for both trusted select and openDefault without changing route or preference rules', async () => {
    const first = deferred(), second = deferred();
    const wait = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { target, failure, navigation, preferences } = setup(wait);
    navigation.select('workbench');
    expect(preferences.get('choice')).toBe('workbench');
    expect(target.replace).not.toHaveBeenCalled();
    first.resolve(); await flushPromises();
    expect(target.replace).toHaveBeenLastCalledWith('https://localhost/?x=1&surface=workbench#anchor');
    navigation.openDefault();
    expect(preferences.get('choice')).toBe('home');
    expect(target.replace).toHaveBeenCalledTimes(1);
    second.resolve(); await flushPromises();
    expect(target.replace).toHaveBeenLastCalledWith('https://localhost/?x=1&surface=home#anchor');
    expect(wait).toHaveBeenCalledTimes(2); expect(failure).not.toHaveBeenCalled();
    expect(() => navigation.select('untrusted')).toThrow('not registered');
    expect(wait).toHaveBeenCalledTimes(2);
  });
  it('reports a rejected cleanup and never replaces the document', async () => {
    const gate = deferred(); const { target, failure, navigation } = setup(() => gate.promise);
    navigation.select('workbench'); gate.reject(new Error('cleanup failed'));
    await flushPromises(); expect(failure).toHaveBeenCalledTimes(1); expect(target.replace).not.toHaveBeenCalled();
  });
  it('honors the latest selection when old waits finish after newer waits', async () => {
    const first = deferred(), second = deferred();
    const wait = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { target, failure, navigation, preferences } = setup(wait);
    navigation.select('workbench'); navigation.openDefault();
    second.resolve(); await flushPromises();
    first.resolve(); await flushPromises();
    expect(target.replace).toHaveBeenCalledTimes(1);
    expect(target.replace).toHaveBeenCalledWith('https://localhost/?x=1&surface=home#anchor');
    expect(preferences.get('choice')).toBe('home'); expect(failure).not.toHaveBeenCalled();
  });
  it('does not report an obsolete failed intent after a newer intent succeeded', async () => {
    const first = deferred(), second = deferred();
    const wait = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { target, failure, navigation } = setup(wait);
    navigation.select('workbench'); navigation.openDefault();
    second.resolve(); await flushPromises(); first.reject(new Error('old intent'));
    await flushPromises(); expect(failure).not.toHaveBeenCalled(); expect(target.replace).toHaveBeenCalledTimes(1);
  });
  it('retires pending replacements and notifications when the app unmounts', async () => {
    const first = deferred(), second = deferred();
    const wait = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { target, failure, navigation, wrapper } = setup(wait);
    navigation.select('workbench'); navigation.openDefault(); wrapper.dispose();
    first.resolve(); second.reject(new Error('old document'));
    await flushPromises(); expect(target.replace).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled();
    navigation.openDefault(); expect(wait).toHaveBeenCalledTimes(2);
  });
  it('contains synchronous barrier or replacement failures without an unhandled rejection', async () => {
    const { target, failure, navigation } = setup(() => { throw new Error('barrier unavailable'); });
    navigation.openDefault(); await flushPromises();
    expect(target.replace).not.toHaveBeenCalled(); expect(failure).toHaveBeenCalledTimes(1);
    const available = setup(async () => {});
    available.target.replace.mockImplementation(() => { throw new Error('navigation blocked'); });
    available.navigation.openDefault(); await flushPromises(); expect(available.failure).toHaveBeenCalledTimes(1);
  });
  it('uses the same cleanup barrier and latest intent for a reload', async () => {
    const first = deferred(), second = deferred();
    const wait = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { target, failure, navigation, wrapper } = setup(wait);
    navigation.select('workbench'); wrapper.reload();
    first.resolve(); await flushPromises();
    expect(target.replace).not.toHaveBeenCalled(); expect(target.reload).not.toHaveBeenCalled();
    second.resolve(); await flushPromises();
    expect(target.reload).toHaveBeenCalledTimes(1); expect(failure).not.toHaveBeenCalled();
  });
  it('blocks failed reloads and retires a pending reload when the document unmounts', async () => {
    const failed = deferred(); const first = setup(() => failed.promise);
    first.wrapper.reload(); failed.reject(new Error('cleanup failed')); await flushPromises();
    expect(first.target.reload).not.toHaveBeenCalled(); expect(first.failure).toHaveBeenCalledTimes(1);
    const pending = deferred(); const second = setup(() => pending.promise);
    second.wrapper.reload(); second.wrapper.dispose(); pending.resolve(); await flushPromises();
    expect(second.target.reload).not.toHaveBeenCalled(); expect(second.failure).not.toHaveBeenCalled();
  });

});
