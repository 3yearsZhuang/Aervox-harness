import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { UIRegistry } from '../src/registry/ui-registry';

describe('UIRegistry', () => {
  it('registers and orders slot components by priority', () => {
    const registry = new UIRegistry();
    const CompA = defineComponent({ render: () => h('div', 'A') });
    const CompB = defineComponent({ render: () => h('div', 'B') });
    const CompC = defineComponent({ render: () => h('div', 'C') });

    registry.registerSlotComponent('header:actions', CompA, { id: 'a', priority: 5 });
    registry.registerSlotComponent('header:actions', CompB, { id: 'b', priority: 20 });
    registry.registerSlotComponent('header:actions', CompC, { id: 'c', priority: 10 });

    const items = registry.getSlotComponents('header:actions');
    expect(items.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });

  it('unregisters components correctly', () => {
    const registry = new UIRegistry();
    const CompA = defineComponent({ render: () => h('div', 'A') });
    const unregister = registry.registerSlotComponent('composer:toolbar-actions', CompA, { id: 'a' });

    expect(registry.getSlotComponents('composer:toolbar-actions')).toHaveLength(1);
    unregister();
    expect(registry.getSlotComponents('composer:toolbar-actions')).toHaveLength(0);
  });

  it('handles component overrides', () => {
    const registry = new UIRegistry();
    const DefaultComp = defineComponent({ render: () => h('div', 'Default') });
    const CustomComp = defineComponent({ render: () => h('div', 'Custom') });

    expect(registry.getComponent('Composer', DefaultComp)).toBe(DefaultComp);

    registry.overrideComponent('Composer', CustomComp);
    expect(registry.getComponent('Composer', DefaultComp)).toBe(CustomComp);
  });
});
