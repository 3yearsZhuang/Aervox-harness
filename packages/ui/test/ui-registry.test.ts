import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { UIRegistry, createUIRegistry, mergeTransformMetadata } from '../src/registry/ui-registry';

describe('UIRegistry', () => {
  it('creates registry via createUIRegistry factory', () => {
    const registry = createUIRegistry();
    expect(registry).toBeInstanceOf(UIRegistry);
    const Comp = defineComponent({ render: () => h('div', 'Bubble Action') });
    registry.registerSlotComponent('message:bubble-actions', Comp, { id: 'bubble-action-1' });
    expect(registry.getSlotComponents('message:bubble-actions')).toHaveLength(1);
  });

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

  it('registers message transformers and executes them by priority order', () => {
    const registry = createUIRegistry();

    registry.registerMessageTransformer('step1', (text) => `[step1:${text}]`, 10);
    registry.registerMessageTransformer('step2', (text) => `[step2:${text}]`, 50);
    registry.registerMessageTransformer('step3', (text) => `[step3:${text}]`, 30);

    // Execution order: step2 (50) -> step3 (30) -> step1 (10)
    // text="hi" -> "[step2:hi]" -> "[step3:[step2:hi]]" -> "[step1:[step3:[step2:hi]]]"
    expect(registry.transformMessage('hi').text).toBe('[step1:[step3:[step2:hi]]]');
  });

  it('unregisters message transformers correctly', () => {
    const registry = createUIRegistry();
    const unregister = registry.registerMessageTransformer('prefix', (text) => `prefix_${text}`);

    expect(registry.transformMessage('msg').text).toBe('prefix_msg');
    unregister();
    expect(registry.transformMessage('msg').text).toBe('msg');
  });

  it('收集变换器自述的出站 metadata，且宿主显式 metadata 优先（CR-060）', () => {
    const registry = createUIRegistry();

    registry.registerMessageTransformer('plugin-a', (text) => ({ text, metadata: { mode: 'focus', a: 1 } }), 10);
    registry.registerMessageTransformer('plugin-b', (text) => ({ text, metadata: { b: 2 } }), 5);

    const produced = registry.transformMessage('hi');
    expect(produced.text).toBe('hi');
    expect(produced.metadata).toEqual({ mode: 'focus', a: 1, b: 2 });

    // 返回字符串的变换器只改写文本，不产生 metadata
    registry.unregisterMessageTransformer('plugin-b');
    registry.registerMessageTransformer('plain', (text) => `[plain:${text}]`, 1);
    expect(registry.transformMessage('hi').metadata).toEqual({ mode: 'focus', a: 1 });

    // 宿主显式值覆盖插件自述值（插件不得覆盖宿主语义）
    expect(mergeTransformMetadata({ mode: 'quiz' }, produced.metadata)).toEqual({ mode: 'quiz', a: 1, b: 2 });

    // 两者皆空时不产生 metadata
    expect(mergeTransformMetadata(undefined, undefined)).toBeUndefined();
    expect(mergeTransformMetadata(undefined, {})).toBeUndefined();
  });

  it('多个变换器自述同一键时，高优先级插件胜出（CR-060）', () => {
    const registry = createUIRegistry();

    registry.registerMessageTransformer('high', (text) => ({ text, metadata: { mode: 'high' } }), 100);
    registry.registerMessageTransformer('low', (text) => ({ text, metadata: { mode: 'low', extra: 1 } }), 1);

    // 管道按优先级降序执行，后执行者不得覆盖先执行者的同名键
    expect(registry.transformMessage('hi').metadata).toEqual({ mode: 'high', extra: 1 });
  });

  it('registers and orders cards by priority and unregisters cleanly', () => {
    const registry = createUIRegistry();
    const DummyIcon = defineComponent({ render: () => h('span', 'icon') });
    const Extra = defineComponent({ render: () => h('div', 'extra') });

    const unregister1 = registry.registerCard({
      id: 'card-low',
      label: '低优先级卡片',
      description: 'low priority',
      icon: DummyIcon,
      summary: () => 'low',
      action: () => {},
      priority: 10,
    });

    const unregister2 = registry.registerCard({
      id: 'card-high',
      label: '高优先级卡片',
      description: 'high priority',
      icon: DummyIcon,
      summary: () => 'high',
      action: () => {},
      extraComponent: Extra,
      priority: 100,
    });

    const cards = registry.getCards();
    expect(cards).toHaveLength(2);
    expect(cards[0].id).toBe('card-high');
    expect(cards[1].id).toBe('card-low');
    expect(cards[0].extraComponent).toBeDefined();

    // Unregister high
    unregister2();
    expect(registry.getCards().map((c) => c.id)).toEqual(['card-low']);

    // Unregister low
    unregister1();
    expect(registry.getCards()).toHaveLength(0);
  });

  it('clears all cards on clear()', () => {
    const registry = createUIRegistry();
    const DummyIcon = defineComponent({ render: () => h('span', 'icon') });

    registry.registerCard({
      id: 'temp-card',
      label: '临时卡片',
      description: 'temp',
      icon: DummyIcon,
      summary: () => 'temp',
      action: () => {},
    });

    expect(registry.getCards()).toHaveLength(1);
    registry.clear();
    expect(registry.getCards()).toHaveLength(0);
  });
});
