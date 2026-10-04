import { shallowReactive, shallowRef, markRaw, type Component, inject, provide, type InjectionKey } from 'vue';
import type {
  ExtensionSlotName,
  ExtensionComponentRegistration,
  RegisterSlotOptions,
  SlotItemConfig,
  MessageTransformer,
  MessageTransformContext,
  MessageTransformOutput,
  MessageTransformResult,
  WorkbenchCardContribution,
} from './types';

/**
 * 合并出站元数据（CR-060）：宿主**显式**值优先于插件自述值；两者皆空则视为不携带元数据。
 * 该判据由宿主唯一执行，保证「宿主不解释插件私有取值」的同时不接受插件覆盖宿主语义。
 */
export function mergeTransformMetadata(
  explicit: Record<string, unknown> | undefined,
  produced: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const merged = { ...(produced ?? {}), ...(explicit ?? {}) };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

/** 归一变换器返回值：字符串视为仅改写文本 */
function normalizeTransformResult(result: MessageTransformResult): {
  text: string;
  metadata?: Record<string, unknown>;
} {
  if (typeof result === 'string') return { text: result };
  return { text: result.text, metadata: result.metadata };
}

/**
 * 计算一次出站发送的最终文本与元数据（CR-060）。
 *
 * 宿主发送路径的**唯一**决策点：插件经变换管道自述模式语义，宿主显式元数据优先。
 * 普通发送（无显式元数据）同样会带上插件自述语义——这是插件开关类语义得以生效的关键，
 * 也是本函数被单测覆盖的原因（宿主不得再为具体插件硬编码模式派生）。
 */
export function resolveOutgoingMessage(
  registry: UIRegistry,
  text: string,
  explicitMetadata?: Record<string, unknown>,
): { text: string; metadata?: Record<string, unknown> } {
  const transformed = registry.transformMessage(text, { metadata: explicitMetadata });
  return {
    text: transformed.text,
    metadata: mergeTransformMetadata(explicitMetadata, transformed.metadata),
  };
}

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

  /**
   * 执行已注册的消息变换管道（按优先级降序排序）。
   *
   * 返回最终文本与各插件自述的出站元数据（后者由调用方经 `mergeTransformMetadata`
   * 与宿主显式元数据合并，插件不得覆盖宿主显式语义）。
   *
   * 元数据键冲突时**高优先级插件胜出**：管道按优先级降序执行，故后执行者不得覆盖
   * 先执行者的同名键（与「priority 越大越权威」的既有语义一致）。
   */
  transformMessage(message: string, context?: MessageTransformContext): MessageTransformOutput {
    let result = message;
    let metadata: Record<string, unknown> | undefined;
    const sorted = Object.values(this.messageTransformers)
      .slice()
      .sort((a, b) => b.priority - a.priority);
    for (const item of sorted) {
      try {
        const out = normalizeTransformResult(item.transformer(result, context));
        result = out.text;
        if (out.metadata) metadata = { ...out.metadata, ...(metadata ?? {}) };
      } catch (err) {
        console.error(`[UIRegistry] Message transformer error:`, err);
      }
    }
    return { text: result, metadata };
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
