import { describe, expect, it } from 'vitest';
import { createUIRegistry } from '../src/registry/ui-registry';
import {
  registerFocusModePlugin,
  registerStudyModePlugin,
  registerStudyModeModule,
  registerStudyCompanionPlugin,
  FocusModeSwitch,
  StudyModeSwitch,
  FocusTermsBar,
  StudyTermsBar,
  TermExploreDialog,
  createWorkbenchPluginRuntime,
} from '../src/plugins';


describe('FocusModePlugin (and StudyMode compatibility)', () => {
  it('exports all plugin components and compatibility aliases', () => {
    expect(FocusModeSwitch).toBeDefined();
    expect(StudyModeSwitch).toBe(FocusModeSwitch);
    expect(FocusTermsBar).toBeDefined();
    expect(StudyTermsBar).toBe(FocusTermsBar);
    expect(TermExploreDialog).toBeDefined();
    expect(registerFocusModePlugin).toBeDefined();
    expect(registerStudyModePlugin).toBe(registerFocusModePlugin);
    expect(registerStudyModeModule).toBe(registerFocusModePlugin);
    expect(registerStudyCompanionPlugin).toBe(registerFocusModePlugin);
  });

  it('registers header switch and terms bar into proper slots with priorities', () => {
    const registry = createUIRegistry();
    const unregister = registerFocusModePlugin(registry);

    const headerActions = registry.getSlotComponents('header:actions');
    const headerSwitch = headerActions.find((item) => item.id === 'focus-mode:header-switch');
    expect(headerSwitch).toBeDefined();
    expect(headerSwitch?.priority).toBe(100);
    expect(headerSwitch?.component).toBe(FocusModeSwitch);

    const conversationBottom = registry.getSlotComponents('conversation:bottom');
    const termsBar = conversationBottom.find((item) => item.id === 'focus-mode:terms-bar');
    expect(termsBar).toBeDefined();
    expect(termsBar?.priority).toBe(50);
    expect(termsBar?.component).toBe(FocusTermsBar);

    // Test unregister cleanup
    unregister();
    expect(registry.getSlotComponents('header:actions').find((item) => item.id === 'focus-mode:header-switch')).toBeUndefined();
    expect(registry.getSlotComponents('conversation:bottom').find((item) => item.id === 'focus-mode:terms-bar')).toBeUndefined();
  });

  it('is idempotent when registered multiple times', () => {
    const registry = createUIRegistry();
    registerFocusModePlugin(registry);
    registerFocusModePlugin(registry);

    const headerMatches = registry.getSlotComponents('header:actions').filter((item) => item.id === 'focus-mode:header-switch');
    expect(headerMatches).toHaveLength(1);

    const termsMatches = registry.getSlotComponents('conversation:bottom').filter((item) => item.id === 'focus-mode:terms-bar');
    expect(termsMatches).toHaveLength(1);
  });

  it('transforms messages via message transformer based on mode state', () => {
    const registry = createUIRegistry();
    const focusModeEnabled = { value: false };
    const mockContext = {
      layout: { focusModeEnabled },
    } as any;

    const unregister = registerFocusModePlugin(registry, mockContext);

    // Initial disabled state
    expect(registry.transformMessage('请讲解算法')).toBe('请讲解算法');

    // Enabled state
    focusModeEnabled.value = true;
    expect(registry.transformMessage('请讲解算法')).toBe('[模式：专注模式] 请讲解算法');

    // Idempotent: already has prefix
    expect(registry.transformMessage('[模式：专注模式] 请讲解算法')).toBe('[模式：专注模式] 请讲解算法');
    expect(registry.transformMessage('[模式：专注模式]请讲解算法')).toBe('[模式：专注模式]请讲解算法');

    // Quiz mode bypasses focus prefix
    expect(registry.transformMessage('请出两道题', { quizMode: true })).toBe('请出两道题');

    // Unregister removes transformer
    unregister();
    expect(registry.transformMessage('请讲解算法')).toBe('请讲解算法');
  });

  it('integrates with createWorkbenchPluginRuntime for zero-hardcode lifecycle & config sync', async () => {
    const registry = createUIRegistry();
    const focusModeEnabled = { value: false };
    const mockContext = {
      layout: {
        focusModeEnabled,
        setFocusModeEnabled: (val: boolean) => {
          focusModeEnabled.value = val;
        },
      },
    } as any;

    const runtime = createWorkbenchPluginRuntime(registry, () => mockContext);

    // Initial setup: focus-mode and study-mode alias are active in slots
    expect(runtime.isPluginAvailable('focus-mode')).toBe(true);
    expect(runtime.isPluginAvailable('study-mode')).toBe(true);
    expect(registry.getSlotComponents('header:actions').some((item) => item.id === 'focus-mode:header-switch')).toBe(true);

    // Sync config: autoEnableFocusMode activates focus mode
    await runtime.sync(
      [{ id: 'focus-mode', enabled: 1 }],
      async () => ({ values: { autoEnableFocusMode: true } }),
    );
    expect(focusModeEnabled.value).toBe(true);

    // Sync disabling: plugin disabled -> unmounts slot & calls onDisable
    await runtime.sync(
      [{ id: 'focus-mode', enabled: 0 }],
      async () => ({ values: {} }),
    );
    expect(runtime.isPluginAvailable('focus-mode')).toBe(false);
    expect(runtime.isPluginAvailable('study-mode')).toBe(false);
    expect(registry.getSlotComponents('header:actions').some((item) => item.id === 'focus-mode:header-switch')).toBe(false);
    expect(registry.getSlotComponents('conversation:bottom').some((item) => item.id === 'focus-mode:terms-bar')).toBe(false);
    expect(focusModeEnabled.value).toBe(false);

    // Sync enabling again with legacy study-mode id: slot remounts
    await runtime.sync(
      [{ id: 'study-mode', enabled: 1 }],
      async () => ({ values: {} }),
    );
    expect(runtime.isPluginAvailable('focus-mode')).toBe(true);
    expect(runtime.isPluginAvailable('study-mode')).toBe(true);
    expect(registry.getSlotComponents('header:actions').some((item) => item.id === 'focus-mode:header-switch')).toBe(true);

    runtime.destroy();
    expect(registry.getSlotComponents('header:actions')).toHaveLength(0);
  });

  it('prevents concurrent config sync race condition from overwriting disabled state', async () => {
    const registry = createUIRegistry();
    const focusModeEnabled = { value: false };
    const mockContext = {
      layout: {
        focusModeEnabled,
        setFocusModeEnabled: (val: boolean) => {
          focusModeEnabled.value = val;
        },
      },
    } as any;

    const runtime = createWorkbenchPluginRuntime(registry, () => mockContext);

    // First sync takes time to fetch config
    let resolveFirstConfig: (val: any) => void;
    const firstConfigPromise = new Promise((resolve) => {
      resolveFirstConfig = resolve;
    });

    const sync1 = runtime.sync(
      [{ id: 'focus-mode', enabled: 1 }],
      () => firstConfigPromise as any,
    );

    // Immediately trigger a second sync that disables the plugin
    const sync2 = runtime.sync(
      [{ id: 'focus-mode', enabled: 0 }],
      async () => ({ values: {} }),
    );
    await sync2;

    expect(focusModeEnabled.value).toBe(false);
    expect(runtime.isPluginAvailable('focus-mode')).toBe(false);

    // Now let the first config return
    resolveFirstConfig!({ values: { autoEnableFocusMode: true } });
    await sync1;

    // Stale sync must NOT re-activate focus mode
    expect(focusModeEnabled.value).toBe(false);
    expect(runtime.isPluginAvailable('focus-mode')).toBe(false);
  });

  it('supports seamless hot-plugging: slot components mount and unmount dynamically in memory without page reload', async () => {
    const registry = createUIRegistry();
    const focusModeEnabled = { value: true };
    const mockContext = {
      layout: {
        focusModeEnabled,
        setFocusModeEnabled: (val: boolean) => {
          focusModeEnabled.value = val;
        },
      },
    } as any;

    const runtime = createWorkbenchPluginRuntime(registry, () => mockContext);

    // Initial: active
    expect(registry.getSlotComponents('header:actions').length).toBe(1);
    expect(registry.getSlotComponents('conversation:bottom').length).toBe(1);

    // Dynamic unplug (disable)
    await runtime.sync(
      [{ id: 'focus-mode', enabled: 0 }],
      async () => ({ values: {} }),
    );
    expect(registry.getSlotComponents('header:actions').length).toBe(0);
    expect(registry.getSlotComponents('conversation:bottom').length).toBe(0);
    expect(focusModeEnabled.value).toBe(false);

    // Dynamic re-plug (enable)
    await runtime.sync(
      [{ id: 'focus-mode', enabled: 1 }],
      async () => ({ values: {} }),
    );
    expect(registry.getSlotComponents('header:actions').length).toBe(1);
    expect(registry.getSlotComponents('conversation:bottom').length).toBe(1);

    runtime.destroy();
  });
});
