import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, ref, watchSyncEffect } from 'vue';
import { createUIRegistry } from '../src/registry/ui-registry';
import type { UIPluginContext } from '../src/composables/ui-plugin-context';
import { createPluginEventBus } from '../src/composables/plugin-events';
import { createWorkbenchPluginRuntime, type BuiltinUIPlugin, type UIPluginLifecycle } from '../src/plugins/plugin-runtime';

const Component = defineComponent({ render: () => null });
const enabled = [{ id: 'probe', enabled: 1 }];
const config = async () => ({ values: {} });
const context = () => ({ pluginEvents: createPluginEventBus() }) as UIPluginContext;

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('UI plugin activation ownership', () => {
  it('rolls back partial setup and reports failed instead of available, then permits retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = createUIRegistry();
    registry.registerSlotItem('header:actions', Component, { id: 'host' });
    registry.overrideComponent('ComposerDock', Component);
    const replacement = defineComponent({ render: () => null });
    const events = createPluginEventBus();
    const listener = vi.fn();
    let fail = true;
    const getConfig = vi.fn(config);
    const runtime = createWorkbenchPluginRuntime(registry, () => ({ pluginEvents: events }) as UIPluginContext, [{
      id: 'probe',
      setup(scoped, ctx, life) {
        scoped.registerSlotItem('header:actions', replacement, { id: 'probe:item' });
        scoped.overrideComponent('ComposerDock', replacement);
        scoped.registerMessageTransformer('probe:transform', (text) => `changed:${text}`);
        scoped.registerCard({ id: 'probe:card', label: 'probe', description: '', icon: Component, summary: () => '', action() {} });
        life!.onDispose(ctx!.pluginEvents!.on(listener));
        if (fail) throw new Error('activation fault');
      },
      onConfig: vi.fn(),
    }]);
    await runtime.sync(enabled, getConfig);
    expect(runtime.isPluginAvailable('probe')).toBe(false);
    expect(runtime.getPluginState('probe')).toMatchObject({ status: 'failed', error: expect.any(Error) });
    expect(getConfig).not.toHaveBeenCalled();
    expect(registry.getSlotComponents('header:actions').map((item) => item.id)).toEqual(['host']);
    expect(registry.getComponent('ComposerDock')).toBe(Component);
    expect(registry.getCards()).toEqual([]);
    expect(registry.transformMessage('hello').text).toBe('hello');
    events.emit('probe', {});
    expect(listener).not.toHaveBeenCalled();
    fail = false;
    await runtime.sync(enabled, getConfig);
    expect(runtime.getPluginState('probe').status).toBe('active');
    expect(registry.getSlotComponents('header:actions')).toHaveLength(2);
    runtime.destroy();
    expect(registry.getSlotComponents('header:actions')).toHaveLength(1);
  });

  it('tracks a void-returning setup once and releases its registrations on disable', async () => {
    const registry = createUIRegistry();
    const setup = vi.fn((scoped) => { scoped.registerSlotItem('header:actions', Component, { id: 'probe:item' }); });
    const onDisable = vi.fn();
    const runtime = createWorkbenchPluginRuntime(registry, context, [{ id: 'probe', setup, onDisable }]);
    await runtime.sync(enabled, config);
    await runtime.sync(enabled, config);
    expect(setup).toHaveBeenCalledTimes(1);
    await runtime.sync([], config);
    await runtime.sync([], config);
    expect(onDisable).toHaveBeenCalledTimes(1);
    expect(registry.getSlotComponents('header:actions')).toEqual([]);
    expect(runtime.getPluginState('probe').status).toBe('disabled');
    await runtime.sync(enabled, config);
    expect(setup).toHaveBeenCalledTimes(2);
    runtime.destroy();
    expect(onDisable).toHaveBeenCalledTimes(1);
  });

  it('requires explicit enabled and available records', async () => {
    const setup = vi.fn();
    const runtime = createWorkbenchPluginRuntime(createUIRegistry(), context, [{ id: 'probe', setup }]);
    for (const record of [{ id: 'probe' }, { id: 'probe', enabled: 0 }, { id: 'probe', enabled: 1, availability: 'missing' }]) {
      await runtime.sync([record], config);
    }
    expect(setup).not.toHaveBeenCalled();
    expect(runtime.isPluginAvailable('probe')).toBe(false);
    runtime.destroy();
  });

  it('preserves context identity and stops Vue watchers, owned event listeners, timers and registrations', async () => {
    vi.useFakeTimers();
    const registry = createUIRegistry();
    const host = context();
    const value = ref(0);
    const observed = vi.fn();
    const ticks = vi.fn();
    const events = vi.fn();
    let lifecycle!: UIPluginLifecycle;
    let scopedRegistry!: typeof registry;
    const runtime = createWorkbenchPluginRuntime(registry, () => host, [{
      id: 'probe',
      setup(ownedRegistry, ctx, life) {
        lifecycle = life!;
        expect(ctx).toBe(host);
        scopedRegistry = ownedRegistry;
        ownedRegistry.registerSlotItem('header:actions', Component, { id: 'probe:item' });
        life!.onDispose(ctx!.pluginEvents!.on(events));
        watchSyncEffect(() => observed(value.value));
        life!.effect(() => { const timer = setInterval(ticks, 10); return () => clearInterval(timer); });
      },
    }]);
    await runtime.sync(enabled, config);
    value.value++;
    host.pluginEvents!.emit('probe', {});
    await vi.advanceTimersByTimeAsync(10);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(events).toHaveBeenCalledTimes(1);
    expect(ticks).toHaveBeenCalledTimes(1);
    await runtime.sync([], config);
    expect(lifecycle.signal.aborted).toBe(true);
    value.value++;
    host.pluginEvents!.emit('probe', {});
    await vi.advanceTimersByTimeAsync(100);
    expect(observed).toHaveBeenCalledTimes(2);
    expect(events).toHaveBeenCalledTimes(1);
    expect(ticks).toHaveBeenCalledTimes(1);
    expect(registry.getSlotComponents('header:actions')).toEqual([]);
    expect(() => scopedRegistry.registerSlotItem('header:actions', Component)).toThrow('disposed');
    runtime.destroy();
  });

  it('continues cleanup after a disposer throws and disposes other plugins exactly once', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = createUIRegistry();
    const cleaned = vi.fn();
    const goodCleanup = vi.fn();
    const definitions: BuiltinUIPlugin[] = [{
      id: 'probe', setup(scoped, _ctx, life) {
        scoped.registerSlotItem('header:actions', Component, { id: 'probe:item' });
        life!.onDispose(cleaned);
        return () => { throw new Error('cleanup fault'); };
      },
    }, { id: 'other', setup(scoped) {
      scoped.registerSlotItem('header:actions', Component, { id: 'other:item' });
      return goodCleanup;
    } }];
    const runtime = createWorkbenchPluginRuntime(registry, context, definitions);
    await runtime.sync([...enabled, { id: 'other', enabled: 1 }], config);
    runtime.destroy(); runtime.destroy();
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(goodCleanup).toHaveBeenCalledTimes(1);
    expect(registry.getSlotComponents('header:actions')).toEqual([]);
    expect(runtime.getPluginState('probe').status).toBe('disposed');
  });

  it('drops a late config snapshot after disable/re-enable without changing the new instance', async () => {
    let finish!: (value: { values: Record<string, unknown> }) => void;
    const onConfig = vi.fn();
    const runtime = createWorkbenchPluginRuntime(createUIRegistry(), context, [{ id: 'probe', setup() {}, onConfig }]);
    const pending = runtime.sync(enabled, () => new Promise((resolve) => { finish = resolve; }));
    await runtime.sync([], config);
    await runtime.sync(enabled, async () => ({ values: { generation: 2 } }));
    finish({ values: { generation: 1 } });
    await pending;
    expect(onConfig).toHaveBeenCalledTimes(1);
    expect(onConfig.mock.calls[0][0]).toEqual({ generation: 2 });
    runtime.destroy();
  });

  it('aborts in-flight config work cooperatively and rejects late registrations', async () => {
    let finish!: () => void;
    const release = new Promise<void>((resolve) => { finish = resolve; });
    const applied = vi.fn();
    let scoped!: ReturnType<typeof createUIRegistry>;
    const runtime = createWorkbenchPluginRuntime(createUIRegistry(), context, [{
      id: 'probe', setup(registry) { scoped = registry; }, async onConfig(_values, _ctx, life) {
        await release;
        if (life!.signal.aborted) return;
        scoped.registerSlotItem('header:actions', Component);
        applied();
      },
    }]);
    const pending = runtime.sync(enabled, config);
    await Promise.resolve();
    runtime.destroy(); finish(); await pending;
    expect(applied).not.toHaveBeenCalled();
  });

  it('does not activate later plugins after destroy reenters setup', async () => {
    const laterSetup = vi.fn();
    let runtime!: ReturnType<typeof createWorkbenchPluginRuntime>;
    runtime = createWorkbenchPluginRuntime(createUIRegistry(), context, [
      { id: 'probe', setup() { runtime.destroy(); } }, { id: 'later', setup: laterSetup },
    ]);
    await runtime.sync([...enabled, { id: 'later', enabled: 1 }], config);
    expect(laterSetup).not.toHaveBeenCalled();
    expect(runtime.getPluginState('probe').status).toBe('disposed');
  });

  it('keeps a retry active when failed setup cleanup reenters activation', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = createUIRegistry();
    let generation = 0;
    let runtime!: ReturnType<typeof createWorkbenchPluginRuntime>;
    const restarted: Promise<void>[] = [];
    runtime = createWorkbenchPluginRuntime(registry, context, [{
      id: 'probe', setup(scoped, _ctx, life) {
        const current = ++generation;
        scoped.registerSlotItem('header:actions', Component, { id: 'probe:item', props: { generation: current } });
        if (current === 1) {
          life!.onDispose(() => { restarted.push(runtime.sync(enabled, config)); });
          throw new Error('first setup failed');
        }
      },
    }]);
    try {
      await runtime.sync(enabled, config);
      await Promise.all(restarted);
      expect(generation).toBe(2);
      expect(runtime.getPluginState('probe')).toEqual({ status: 'active' });
      expect(runtime.isPluginAvailable('probe')).toBe(true);
      expect(registry.getSlotComponents('header:actions')).toHaveLength(1);
      expect(registry.getSlotComponents('header:actions')[0].props).toEqual({ generation: 2 });
    } finally {
      runtime.destroy();
    }
    expect(registry.getSlotComponents('header:actions')).toEqual([]);
  });

  it('an old setup failure cannot dispose a replacement created by reentrant enablement', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const registry = createUIRegistry();
    let generation = 0;
    let runtime!: ReturnType<typeof createWorkbenchPluginRuntime>;
    const restarted: Promise<void>[] = [];
    runtime = createWorkbenchPluginRuntime(registry, context, [{
      id: 'probe', setup(scoped) {
        const current = ++generation;
        scoped.registerSlotItem('header:actions', Component, { id: 'probe:item', props: { generation: current } });
        if (current === 1) {
          restarted.push(runtime.sync([], config), runtime.sync(enabled, config));
          throw new Error('old setup failed');
        }
      },
    }]);
    await runtime.sync(enabled, config);
    await Promise.all(restarted);
    expect(runtime.isPluginAvailable('probe')).toBe(true);
    expect(registry.getSlotComponents('header:actions')[0].props).toEqual({ generation: 2 });
    runtime.destroy();
    expect(registry.getSlotComponents('header:actions')).toEqual([]);
  });
});

describe('UI registry scope isolation', () => {
  it('does not resurrect an earlier override when scopes unload out of order', () => {
    const registry = createUIRegistry();
    const fallback = defineComponent({ render: () => null });
    const a = registry.createScope(); const b = registry.createScope();
    a.overrideComponent('ComposerDock', Component);
    b.overrideComponent('ComposerDock', fallback);
    a.dispose();
    expect(registry.getComponent('ComposerDock')).toBe(fallback);
    b.dispose();
    expect(registry.getComponent('ComposerDock')).toBeUndefined();
  });

  it('old disposers cannot remove replacement slots, transformers or cards', () => {
    const registry = createUIRegistry();
    const a = registry.createScope(); const b = registry.createScope();
    const register = (scoped: typeof registry, label: string) => {
      scoped.registerSlotItem('header:actions', Component, { id: 'shared', props: { label } });
      scoped.registerMessageTransformer('shared', () => label);
      scoped.registerCard({ id: 'shared', label, description: '', icon: Component, summary: () => '', action() {} });
    };
    register(a, 'a'); register(b, 'b'); a.dispose();
    expect(registry.getSlotComponents('header:actions')[0].props).toEqual({ label: 'b' });
    expect(registry.transformMessage('x').text).toBe('b');
    expect(registry.getCards()[0].label).toBe('b');
    b.dispose();
    expect(registry.getCards()).toEqual([]);
  });

  it('scope clear and explicit unregister cannot clear host or another scope contributions', () => {
    const registry = createUIRegistry();
    registry.registerSlotItem('header:actions', Component, { id: 'host' });
    const a = registry.createScope(); const b = registry.createScope();
    a.registerSlotItem('header:actions', Component, { id: 'a' });
    b.registerSlotItem('header:actions', Component, { id: 'b' });
    a.unregisterSlotComponent('header:actions', 'host');
    a.unregisterSlotComponent('header:actions', 'b');
    a.clear();
    expect(registry.getSlotComponents('header:actions').map((item) => item.id)).toEqual(['host', 'b']);
    a.dispose(); b.dispose();
    expect(registry.getSlotComponents('header:actions').map((item) => item.id)).toEqual(['host']);
  });
});
