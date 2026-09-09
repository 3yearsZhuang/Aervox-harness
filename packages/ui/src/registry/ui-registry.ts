import { shallowReactive, markRaw, type Component, inject, provide, type InjectionKey } from 'vue';
import type {
  ExtensionSlotName,
  ExtensionComponentRegistration,
  RegisterSlotOptions,
} from './types';

export class UIRegistry {
  private slots = shallowReactive<Record<string, ExtensionComponentRegistration[]>>({});
  private componentOverrides = shallowReactive<Record<string, Component>>({});

  /** 向指定插槽注册扩展组件 */
  registerSlotComponent(
    slot: ExtensionSlotName,
    component: Component,
    options: RegisterSlotOptions = {},
  ): () => void {
    const rawComponent = markRaw(component);
    const existing = this.slots[slot] ? [...this.slots[slot]] : [];

    const id = options.id ?? `ext_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const priority = options.priority ?? 0;

    const filtered = existing.filter((item) => item.id !== id);
    filtered.push({
      id,
      component: rawComponent,
      priority,
      props: options.props,
    });

    // 按 priority 降序排序（数字越大越靠前）
    filtered.sort((a, b) => b.priority - a.priority);
    this.slots[slot] = filtered;

    // 返回注销函数
    return () => this.unregisterSlotComponent(slot, id);
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

  /** 重置所有插槽和替换 */
  clear(): void {
    for (const key of Object.keys(this.slots)) {
      delete this.slots[key];
    }
    for (const key of Object.keys(this.componentOverrides)) {
      delete this.componentOverrides[key];
    }
  }
}

/** 创建独立的 UI 注册表实例 */
export function createUIRegistry(): UIRegistry {
  return new UIRegistry();
}

/** 全局单例注册表 */
export const defaultUIRegistry = new UIRegistry();

const UI_REGISTRY_KEY: InjectionKey<UIRegistry> = Symbol('AERVOX_UI_REGISTRY');

export function provideUIRegistry(registry: UIRegistry = defaultUIRegistry): void {
  provide(UI_REGISTRY_KEY, registry);
}

export function useUIRegistry(): UIRegistry {
  return inject(UI_REGISTRY_KEY, defaultUIRegistry);
}

