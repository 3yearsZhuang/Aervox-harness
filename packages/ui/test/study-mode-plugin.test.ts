import { describe, expect, it } from 'vitest';
import { createUIRegistry } from '../src/registry/ui-registry';
import {
  registerStudyModePlugin,
  registerStudyModeModule,
  registerStudyCompanionPlugin,
  StudyModeSwitch,
  StudyTermsBar,
  TermExploreDialog,
  createWorkbenchPluginRuntime,
} from '../src/plugins';


describe('StudyModePlugin', () => {
  it('exports all plugin components', () => {
    expect(StudyModeSwitch).toBeDefined();
    expect(StudyTermsBar).toBeDefined();
    expect(TermExploreDialog).toBeDefined();
    expect(registerStudyModePlugin).toBeDefined();
    expect(registerStudyModeModule).toBe(registerStudyModePlugin);
    expect(registerStudyCompanionPlugin).toBe(registerStudyModePlugin);
  });

  it('registers header switch and terms bar into proper slots with priorities', () => {
    const registry = createUIRegistry();
    const unregister = registerStudyModePlugin(registry);

    const headerActions = registry.getSlotComponents('header:actions');
    const headerSwitch = headerActions.find((item) => item.id === 'study-mode:header-switch');
    expect(headerSwitch).toBeDefined();
    expect(headerSwitch?.priority).toBe(100);
    expect(headerSwitch?.component).toBe(StudyModeSwitch);

    const conversationBottom = registry.getSlotComponents('conversation:bottom');
    const termsBar = conversationBottom.find((item) => item.id === 'study-mode:terms-bar');
    expect(termsBar).toBeDefined();
    expect(termsBar?.priority).toBe(50);
    expect(termsBar?.component).toBe(StudyTermsBar);

    // Test unregister cleanup
    unregister();
    expect(registry.getSlotComponents('header:actions').find((item) => item.id === 'study-mode:header-switch')).toBeUndefined();
    expect(registry.getSlotComponents('conversation:bottom').find((item) => item.id === 'study-mode:terms-bar')).toBeUndefined();
  });

  it('is idempotent when registered multiple times', () => {
    const registry = createUIRegistry();
    registerStudyModePlugin(registry);
    registerStudyModePlugin(registry);

    const headerMatches = registry.getSlotComponents('header:actions').filter((item) => item.id === 'study-mode:header-switch');
    expect(headerMatches).toHaveLength(1);

    const termsMatches = registry.getSlotComponents('conversation:bottom').filter((item) => item.id === 'study-mode:terms-bar');
    expect(termsMatches).toHaveLength(1);
  });

  it('transforms messages via message transformer based on mode state', () => {
    const registry = createUIRegistry();
    const studyModeEnabled = { value: false };
    const mockContext = {
      layout: { studyModeEnabled },
    } as any;

    const unregister = registerStudyModePlugin(registry, mockContext);

    // Initial disabled state
    expect(registry.transformMessage('请讲解算法')).toBe('请讲解算法');

    // Enabled state
    studyModeEnabled.value = true;
    expect(registry.transformMessage('请讲解算法')).toBe('[模式：专注模式] 请讲解算法');

    // Quiz mode bypasses focus prefix
    expect(registry.transformMessage('请出两道题', { quizMode: true })).toBe('请出两道题');

    // Unregister removes transformer
    unregister();
    expect(registry.transformMessage('请讲解算法')).toBe('请讲解算法');
  });

  it('integrates with createWorkbenchPluginRuntime for zero-hardcode lifecycle & config sync', async () => {
    const registry = createUIRegistry();
    const studyModeEnabled = { value: false };
    const mockContext = {
      layout: {
        studyModeEnabled,
        setStudyModeEnabled: (val: boolean) => {
          studyModeEnabled.value = val;
        },
      },
    } as any;

    const runtime = createWorkbenchPluginRuntime(registry, () => mockContext);

    // Initial setup: study-mode is active in slots
    expect(runtime.isPluginAvailable('study-mode')).toBe(true);
    expect(registry.getSlotComponents('header:actions').some((item) => item.id === 'study-mode:header-switch')).toBe(true);

    // Sync config: autoEnableStudyMode activates study mode
    await runtime.sync(
      [{ id: 'study-mode', enabled: 1 }],
      async () => ({ values: { autoEnableStudyMode: true } }),
    );
    expect(studyModeEnabled.value).toBe(true);

    // Sync disabling: plugin disabled -> unmounts slot & calls onDisable
    await runtime.sync(
      [{ id: 'study-mode', enabled: 0 }],
      async () => ({ values: {} }),
    );
    expect(runtime.isPluginAvailable('study-mode')).toBe(false);
    expect(registry.getSlotComponents('header:actions').some((item) => item.id === 'study-mode:header-switch')).toBe(false);
    expect(registry.getSlotComponents('conversation:bottom').some((item) => item.id === 'study-mode:terms-bar')).toBe(false);
    expect(studyModeEnabled.value).toBe(false);

    // Sync enabling again: slot remounts
    await runtime.sync(
      [{ id: 'study-mode', enabled: 1 }],
      async () => ({ values: {} }),
    );
    expect(runtime.isPluginAvailable('study-mode')).toBe(true);
    expect(registry.getSlotComponents('header:actions').some((item) => item.id === 'study-mode:header-switch')).toBe(true);

    runtime.destroy();
    expect(registry.getSlotComponents('header:actions')).toHaveLength(0);
  });
});
