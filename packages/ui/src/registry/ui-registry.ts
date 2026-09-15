import { shallowReactive, shallowRef, markRaw, type Component, inject, provide, type InjectionKey } from 'vue';
import type {
  ExtensionSlotName,
  ExtensionComponentRegistration,
  RegisterSlotOptions,
  SlotItemConfig,
  MessageTransformer,
  MessageTransformContext,
  WorkbenchCardContribution,
} from './types';

export class UIRegistry {
  private slots = shallowReactive<Record<string, ExtensionComponentRegistration[]>>({});
  private componentOverrides = shallowReactive<Record<string, Component>>({});
  private messageTransformers = shallowReactive<Record<string, { transformer: MessageTransformer; priority: number }>>({});
  private cardList = shallowRef<WorkbenchCardContribution[]>([]);

  /** 向指定插槽注册扩展组件 */
  registerSlotComponent(
    slot: ExtensionSlotName,
    componentOrItem: Component | SlotItemConfig,
    options: RegisterSlotOptions = {},
  ): () => void {
    let rawComponent: Component;
    let finalOptions: RegisterSlotOptions = options;

    if (
      componentOrItem &&
      typeof componentOrItem === 'object' &&
      'component' in componentOrItem &&
      Boolean((componentOrItem as SlotItemConfig).component)
    ) {
      const item = componentOrItem as SlotItemConfig;
      rawComponent = markRaw(item.component);
      finalOptions = {
        id: item.id ?? options.id,
        priority: item.priority ?? options.priority,
        props: item.props ?? options.props,
      };
    } else {
      rawComponent = markRaw(componentOrItem as Component);
    }

    const existing = this.slots[slot] ? [...this.slots[slot]] : [];

    const id = finalOptions.id ?? `ext_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const priority = finalOptions.priority ?? 0;

    const filtered = existing.filter((item) => item.id !== id);
    filtered.push({
      id,
      component: rawComponent,
      priority,
      props: finalOptions.props,
    });

    // 按 priority 降序排序（数字越大越靠前）
    filtered.sort((a, b) => b.priority - a.priority);
    this.slots[slot] = filtered;

    // 返回注销函数
    return () => this.unregisterSlotComponent(slot, id);
  }

  /** 向指定插槽注册扩展组件（registerSlotComponent 别名，对齐文档契约） */
  registerSlotItem(
    slot: ExtensionSlotName,
    componentOrItem: Component | SlotItemConfig,
    options: RegisterSlotOptions = {},
  ): () => void {
    return this.registerSlotComponent(slot, componentOrItem, options);
  }

  /** 注销指定插槽的扩展组件 */
  unregisterSlotComponent(slot: ExtensionSlotName, id: string): void {
    if (!this.slots[slot]) return;
    this.slots[slot] = this.slots[slot].filter((item) => item.id !== id);
  }

  /** 获取指定插槽的所有已注册组件 */
  getSlotComponents(slot: ExtensionSlotName): ExtensionComponentRegistration[] {
    return this.slots[slot] ?? [];
  }

  /** 替换系统内部默认组件 */
  overrideComponent(name: string, component: Component): void {
    this.componentOverrides[name] = markRaw(component);
  }

  /** 获取组件（若有替换则返回替换组件，否则返回默认组件） */
  getComponent(name: string, fallback?: Component): Component | undefined {
    return this.componentOverrides[name] ?? fallback;
  }

  /** 注册消息前缀/内容变换拦截器（支持指定 priority 优先级，降序执行） */
  registerMessageTransformer(id: string, transformer: MessageTransformer, priority = 0): () => void {
    this.messageTransformers[id] = { transformer, priority };
    return () => this.unregisterMessageTransformer(id);
  }

  /** 注销指定消息变换拦截器 */
  unregisterMessageTransformer(id: string): void {
    delete this.messageTransformers[id];
  }

  /** 执行已注册的消息变换管道（按优先级降序排序） */
  transformMessage(message: string, context?: MessageTransformContext): string {
    let result = message;
    const sorted = Object.values(this.messageTransformers)
      .slice()
      .sort((a, b) => b.priority - a.priority);
    for (const item of sorted) {
      try {
        result = item.transformer(result, context);
      } catch (err) {
        console.error(`[UIRegistry] Message transformer error:`, err);
      }
    }
    return result;
  }

  /** 注册功能卡片 */
  registerCard(card: WorkbenchCardContribution): () => void {
    const existing = this.cardList.value.filter((item) => item.id !== card.id);
    const normalized: WorkbenchCardContribution = {
      ...card,
      icon: markRaw(card.icon),
      extraComponent: card.extraComponent ? markRaw(card.extraComponent) : undefined,
      priority: card.priority ?? 0,
    };
    this.cardList.value = [...existing, normalized].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return () => this.unregisterCard(card.id);
  }

  /** 注销功能卡片 */
  unregisterCard(id: string): void {
    this.cardList.value = this.cardList.value.filter((item) => item.id !== id);
  }

  /** 获取所有已注册卡片（按 priority 降序排序） */
  getCards(): WorkbenchCardContribution[] {
    return this.cardList.value;
  }

  /** 重置所有插槽、替换、消息变换器与扩展卡片 */
  clear(): void {
    for (const key of Object.keys(this.slots)) {
      delete this.slots[key];
    }
    for (const key of Object.keys(this.componentOverrides)) {
      delete this.componentOverrides[key];
    }
    for (const key of Object.keys(this.messageTransformers)) {
      delete this.messageTransformers[key];
    }
    this.cardList.value = [];
  }
}

/** 创建独立的 UI 注册表实例 */
export function createUIRegistry(): UIRegistry {
  return new UIRegistry();
}

/** 全局单例注册表 */
export const defaultUIRegistry = new UIRegistry();

/** 单例别名（对齐插件开发文档） */
export const uiRegistry = defaultUIRegistry;

export const UI_REGISTRY_KEY: InjectionKey<UIRegistry> = Symbol('AERVOX_UI_REGISTRY');

export function provideUIRegistry(registry: UIRegistry = defaultUIRegistry): void {
  provide(UI_REGISTRY_KEY, registry);
}

export function useUIRegistry(): UIRegistry {
  return inject(UI_REGISTRY_KEY, defaultUIRegistry);
}
