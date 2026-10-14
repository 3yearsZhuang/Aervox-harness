import { shallowReactive, shallowRef, markRaw, type Component, inject, provide, type InjectionKey, type ShallowRef } from 'vue';
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

interface RegistryState {
  slots: Record<string, ExtensionComponentRegistration[]>;
  componentOverrides: Record<string, Array<{ component: Component }>>;
  messageTransformers: Record<string, { transformer: MessageTransformer; priority: number }>;
  cardList: ShallowRef<WorkbenchCardContribution[]>;
}

export class UIRegistry {
  private readonly state: RegistryState;
  private readonly cleanups = new Set<() => void>();
  private readonly ownedValues = new Set<object>();
  private disposed = false;

  constructor(private readonly sharedState?: RegistryState) {
    this.state = sharedState ?? {
      slots: shallowReactive<RegistryState['slots']>(Object.create(null)),
      componentOverrides: shallowReactive<RegistryState['componentOverrides']>(Object.create(null)),
      messageTransformers: shallowReactive<RegistryState['messageTransformers']>(Object.create(null)),
      cardList: shallowRef<WorkbenchCardContribution[]>([]),
    };
  }

  /** 同一展示注册表上的独立资源所有者；停用只清理自身贡献。 */
  createScope(): UIRegistry {
    this.assertLive();
    const scope = new UIRegistry(this.state);
    if (this.sharedState) this.own(() => scope.dispose());
    return scope;
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('UI registry scope is disposed');
  }

  private own(cleanup: () => void, value?: object): () => void {
    if (value && this.sharedState) this.ownedValues.add(value);
    let active = true;
    const dispose = () => {
      if (!active) return;
      active = false;
      this.cleanups.delete(dispose);
      if (value) this.ownedValues.delete(value);
      cleanup();
    };
    // 根注册表无需积累所有历史注销函数，作用域才持有生命周期资源。
    if (this.sharedState) this.cleanups.add(dispose);
    return dispose;
  }

  private owns(value: object): boolean {
    return !this.sharedState || this.ownedValues.has(value);
  }

  /** 作用域注销幂等；注销后的迟到注册会被拒绝。 */
  dispose(): void {
    if (this.disposed) return;
    if (!this.sharedState) this.clear();
    this.disposed = true;
    this.clearOwned();
  }

  private clearOwned(): void {
    const errors: unknown[] = [];
    for (const cleanup of [...this.cleanups].reverse()) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, 'UI registry cleanup failed');
  }

  /** 向指定插槽注册扩展组件 */
  registerSlotComponent(
    slot: ExtensionSlotName,
    componentOrItem: Component | SlotItemConfig,
    options: RegisterSlotOptions = {},
  ): () => void {
    this.assertLive();
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

    const existing = this.state.slots[slot] ? [...this.state.slots[slot]] : [];

    const id = finalOptions.id ?? `ext_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const priority = finalOptions.priority ?? 0;

    const filtered = existing.filter((item) => item.id !== id);
    const registration = {
      id,
      component: rawComponent,
      priority,
      props: finalOptions.props,
    };
    filtered.push(registration);

    // 按 priority 降序排序（数字越大越靠前）
    filtered.sort((a, b) => b.priority - a.priority);
    this.state.slots[slot] = filtered;

    // 返回注销函数
    return this.own(() => {
      this.state.slots[slot] = (this.state.slots[slot] ?? []).filter((item) => item !== registration);
    }, registration);
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
    this.assertLive();
    if (!this.state.slots[slot]) return;
    this.state.slots[slot] = this.state.slots[slot].filter((item) => item.id !== id || !this.owns(item));
  }

  /** 获取指定插槽的所有已注册组件 */
  getSlotComponents(slot: ExtensionSlotName): ExtensionComponentRegistration[] {
    return this.state.slots[slot] ?? [];
  }

  /** 替换系统内部默认组件 */
  overrideComponent(name: string, component: Component): () => void {
    this.assertLive();
    const entry = { component: markRaw(component) };
    this.state.componentOverrides[name] = [...(this.state.componentOverrides[name] ?? []), entry];
    return this.own(() => {
      this.state.componentOverrides[name] = (this.state.componentOverrides[name] ?? []).filter((item) => item !== entry);
    }, entry);
  }

  /** 获取组件（若有替换则返回替换组件，否则返回默认组件） */
  getComponent(name: string, fallback?: Component): Component | undefined {
    return this.state.componentOverrides[name]?.at(-1)?.component ?? fallback;
  }

  /** 注册消息前缀/内容变换拦截器（支持指定 priority 优先级，降序执行） */
  registerMessageTransformer(id: string, transformer: MessageTransformer, priority = 0): () => void {
    this.assertLive();
    const registration = { transformer, priority };
    this.state.messageTransformers[id] = registration;
    return this.own(() => {
      if (this.state.messageTransformers[id] === registration) delete this.state.messageTransformers[id];
    }, registration);
  }

  /** 注销指定消息变换拦截器 */
  unregisterMessageTransformer(id: string): void {
    this.assertLive();
    const item = this.state.messageTransformers[id];
    if (item && this.owns(item)) delete this.state.messageTransformers[id];
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
    const sorted = Object.values(this.state.messageTransformers)
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
    this.assertLive();
    const existing = this.state.cardList.value.filter((item) => item.id !== card.id);
    const normalized: WorkbenchCardContribution = {
      ...card,
      icon: markRaw(card.icon),
      extraComponent: card.extraComponent ? markRaw(card.extraComponent) : undefined,
      priority: card.priority ?? 0,
    };
    this.state.cardList.value = [...existing, normalized].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
    return this.own(() => {
      this.state.cardList.value = this.state.cardList.value.filter((item) => item !== normalized);
    }, normalized);
  }

  /** 注销功能卡片 */
  unregisterCard(id: string): void {
    this.assertLive();
    this.state.cardList.value = this.state.cardList.value.filter((item) => item.id !== id || !this.owns(item));
  }

  /** 获取所有已注册卡片（按 priority 降序排序） */
  getCards(): WorkbenchCardContribution[] {
    return this.state.cardList.value;
  }

  /** 重置所有插槽、替换、消息变换器与扩展卡片 */
  clear(): void {
    this.assertLive();
    if (this.sharedState) {
      this.clearOwned();
      return;
    }
    for (const key of Object.keys(this.state.slots)) {
      delete this.state.slots[key];
    }
    for (const key of Object.keys(this.state.componentOverrides)) {
      delete this.state.componentOverrides[key];
    }
    for (const key of Object.keys(this.state.messageTransformers)) {
      delete this.state.messageTransformers[key];
    }
    this.state.cardList.value = [];
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
