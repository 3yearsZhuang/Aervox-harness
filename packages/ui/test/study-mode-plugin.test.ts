import { describe, expect, it } from 'vitest';
import { createUIRegistry } from '../src/registry/ui-registry';
import {
  registerStudyModePlugin,
  registerStudyModeModule,
  registerStudyCompanionPlugin,
  StudyModeSwitch,
  StudyTermsBar,
  TermExploreDialog,
} from '../src/plugins/study-mode';

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
});
