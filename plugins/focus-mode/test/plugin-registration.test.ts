import { describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createUIRegistry, resolveOutgoingMessage } from '@aervox/ui/plugin-api';
import { createPluginStateStore } from '@aervox/ui/plugin-api';
import { createPluginEventBus } from '@aervox/ui/plugin-api';
import { createWorkbenchPluginRuntime, type BuiltinUIPlugin } from '@aervox/ui/plugin-api';
import focusModePluginDefinition, {
  registerFocusModePlugin,
  FocusModeSwitch,
  FocusTermsBar,
  TermExploreDialog,
  FocusNavMenuItem,
  FocusStudyCardActions,
  FocusTaskCenterCard,
  FocusSettingsRow,
  FocusModeIndicator,
  LearningDrawer,
} from '../src/ui';
import { focusModeEnabled } from '../src/ui';

/**
 * CR-060：插件 UI 侧契约。
 * 与旧版（`study-mode-plugin.test.ts`）的差别：
 * - 不再有 `study-mode` 别名与兼容导出；
 * - 插件状态归插件（经宿主 `pluginState` 命名空间持久化），宿主 layout 无该字段；
 * - 插件运行时不再内建任何插件，且可用性判定 fail-closed（无记录即不可用）。
 */
function createContext() {
  return {
    layout: {
      setQuietStartup: () => undefined,
      runMenuAction: (action: () => void) => action(),
    },
    pluginState: createPluginStateStore(),
    pluginEvents: createPluginEventBus(),
    cards: { api: { learningPlans: { value: [] } } },
    conversation: { streaming: { value: false } },
    sendMessage: async () => undefined,
  } as never;
}

describe('FocusModePlugin（CR-060 无别名单一 id）', () => {
  it('只导出主 id 的组件与注册函数，不保留历史别名', () => {
    expect(FocusModeSwitch).toBeDefined();
    expect(FocusTermsBar).toBeDefined();
    expect(TermExploreDialog).toBeDefined();
    expect(FocusNavMenuItem).toBeDefined();
    expect(FocusStudyCardActions).toBeDefined();
    expect(FocusTaskCenterCard).toBeDefined();
    expect(FocusSettingsRow).toBeDefined();
    expect(FocusModeIndicator).toBeDefined();
    expect(LearningDrawer).toBeDefined();
    expect(registerFocusModePlugin).toBeDefined();
    expect(focusModePluginDefinition.id).toBe('focus-mode');
  });

  it('注册开关、术语条、导航项、抽屉、设置行与输入区指示器到对应插槽', () => {
    const registry = createUIRegistry();
    const unregister = registerFocusModePlugin(registry, createContext());

    expect(registry.getSlotComponents('header:actions').find((i) => i.id === 'focus-mode:header-switch')?.component).toBe(FocusModeSwitch);
    expect(registry.getSlotComponents('conversation:bottom').find((i) => i.id === 'focus-mode:terms-bar')?.component).toBe(FocusTermsBar);
    expect(registry.getSlotComponents('nav:menu-items').find((i) => i.id === 'focus-mode:nav-menu-item')?.component).toBe(FocusNavMenuItem);
    expect(registry.getSlotComponents('workbench:drawers').find((i) => i.id === 'focus-mode:learning-drawer')?.component).toBe(LearningDrawer);
    expect(registry.getSlotComponents('taskcenter:cards').find((i) => i.id === 'focus-mode:task-card')?.component).toBe(FocusTaskCenterCard);
    // CR-060：宿主设置面板与输入区只提供通用插槽，插件行/标记由插件注册
    expect(registry.getSlotComponents('settings:conversation-rows').find((i) => i.id === 'focus-mode:settings-row')?.component).toBe(FocusSettingsRow);
    expect(registry.getSlotComponents('composer:indicator').find((i) => i.id === 'focus-mode:composer-indicator')?.component).toBe(FocusModeIndicator);

    const cards = registry.getCards();
    expect(cards.map((c) => c.id).sort()).toEqual(['mistake', 'quiz', 'study']);

    unregister();
    expect(registry.getSlotComponents('header:actions')).toHaveLength(0);
    expect(registry.getSlotComponents('settings:conversation-rows')).toHaveLength(0);
    expect(registry.getSlotComponents('composer:indicator')).toHaveLength(0);
    expect(registry.getSlotComponents('workbench:drawers')).toHaveLength(0);
    expect(registry.getCards()).toHaveLength(0);
  });

  it('专注模式开关经消息变换器自述出站 metadata（不再改写消息文本）', () => {
    const registry = createUIRegistry();
    const unregister = registerFocusModePlugin(registry, createContext());

    // 关闭：文本原样、不产生 metadata
    expect(registry.transformMessage('请讲解算法')).toEqual({ text: '请讲解算法', metadata: undefined });

    // 开启：文本原样，插件自述 mode='focus' —— 宿主不再为任何插件硬编码模式派生
    focusModeEnabled.value = true;
    expect(registry.transformMessage('请讲解算法')).toEqual({
      text: '请讲解算法',
      metadata: { mode: 'focus' },
    });

    // 宿主显式元数据（如出题意图）经 context 传入，插件不覆盖其取值
    const quiz = registry.transformMessage('来几道题', { metadata: { mode: 'focus', intent: 'quiz' } });
    expect(quiz.text).toBe('来几道题');
    expect(quiz.metadata).toEqual({ mode: 'focus' });

    unregister();
    expect(registry.transformMessage('请讲解算法').metadata).toBeUndefined();
    focusModeEnabled.value = false;
  });

  it('回归守卫：开关打开后「普通发送」（无显式 metadata）仍带出专注模式语义', () => {
    const registry = createUIRegistry();
    const unregister = registerFocusModePlugin(registry, createContext());

    // 关闭时：普通发送不携带任何模式语义
    expect(resolveOutgoingMessage(registry, '请讲解算法')).toEqual({
      text: '请讲解算法',
      metadata: undefined,
    });

    // 打开后：普通发送（不传显式 metadata）必须经宿主通用决策点带出 mode='focus'。
    // CR-060 曾在此处丢失派生逻辑，导致开关打开但服务端收不到模式语义。
    focusModeEnabled.value = true;
    expect(resolveOutgoingMessage(registry, '请讲解算法')).toEqual({
      text: '请讲解算法',
      metadata: { mode: 'focus' },
    });

    // 宿主显式出题意图优先，同时保留插件自述模式
    expect(resolveOutgoingMessage(registry, '来几道题', { intent: 'quiz' })).toEqual({
      text: '来几道题',
      metadata: { mode: 'focus', intent: 'quiz' },
    });

    unregister();
    focusModeEnabled.value = false;
  });

  it('开关切换经宿主通用槽位预设应用/恢复本插件卡片清单（宿主不硬编码卡片 id）', async () => {
    const registry = createUIRegistry();
    const applySlotPreset = vi.fn(() => true);
    const restoreSlotPreset = vi.fn(() => true);
    const context = createContext() as unknown as { cards: Record<string, unknown> };
    context.cards = { ...(context.cards as object), applySlotPreset, restoreSlotPreset };

    const unregister = registerFocusModePlugin(registry, context as never);
    // 初始化时开关为关：只应表达"恢复"，不应应用预设
    expect(applySlotPreset).not.toHaveBeenCalled();
    restoreSlotPreset.mockClear();

    focusModeEnabled.value = true;
    await nextTick();
    expect(applySlotPreset).toHaveBeenCalledWith(['study', 'timer']);

    focusModeEnabled.value = false;
    await nextTick();
    expect(restoreSlotPreset).toHaveBeenCalledTimes(1);

    unregister();
    focusModeEnabled.value = false;
  });

  it('插件状态经宿主 pluginState 命名空间读写（宿主 layout 无该字段）', () => {
    const context = createContext() as unknown as {
      layout: Record<string, unknown>;
      pluginState: ReturnType<typeof createPluginStateStore>;
    };
    registerFocusModePlugin(createUIRegistry(), context as never);

    expect(context.layout).not.toHaveProperty('focusModeEnabled');
    expect(typeof context.layout.setQuietStartup).toBe('function');
    expect(focusModeEnabled.value).toBe(false);
  });
});

describe('WorkbenchPluginRuntime（CR-060：不内建插件、fail-closed）', () => {
  const definitions: BuiltinUIPlugin[] = [focusModePluginDefinition];

  it('未注入插件定义时注册表为空，且可用性判定 fail-closed', () => {
    const registry = createUIRegistry();
    const runtime = createWorkbenchPluginRuntime(registry, () => createContext());
    expect(registry.getSlotComponents('header:actions')).toHaveLength(0);
    expect(runtime.isPluginAvailable('focus-mode')).toBe(false);
    expect(runtime.isPluginAvailable('study-mode')).toBe(false);
    runtime.destroy();
  });

  it('sync 依据仓储启停记录装配与卸载插件插槽', async () => {
    const registry = createUIRegistry();
    const runtime = createWorkbenchPluginRuntime(registry, () => createContext(), definitions);

    // 初始：未经 sync 一律未启用（fail-closed），不注册任何插槽
    expect(runtime.isPluginAvailable('focus-mode')).toBe(false);
    expect(registry.getSlotComponents('header:actions')).toHaveLength(0);

    await runtime.sync([{ id: 'focus-mode', enabled: 1 }], async () => ({ values: {} }));
    expect(runtime.isPluginAvailable('focus-mode')).toBe(true);
    expect(registry.getSlotComponents('header:actions').some((i) => i.id === 'focus-mode:header-switch')).toBe(true);

    await runtime.sync([{ id: 'focus-mode', enabled: 0 }], async () => ({ values: {} }));
    expect(runtime.isPluginAvailable('focus-mode')).toBe(false);
    expect(registry.getSlotComponents('header:actions')).toHaveLength(0);

    // 历史别名不再被识别（无记录 → 保持停用）
    await runtime.sync([{ id: 'study-mode', enabled: 1 }], async () => ({ values: {} }));
    expect(runtime.isPluginAvailable('focus-mode')).toBe(false);
    expect(registry.getSlotComponents('header:actions')).toHaveLength(0);

    runtime.destroy();
  });

  it('配置同步只按主 id 拉取，且陈旧 sync 不得覆盖已停用状态', async () => {
    const registry = createUIRegistry();
    const requestedIds: string[] = [];
    const runtime = createWorkbenchPluginRuntime(registry, () => createContext(), definitions);

    let resolveFirstConfig: ((value: { values: Record<string, unknown> }) => void) | undefined;
    const firstConfigPromise = new Promise<{ values: Record<string, unknown> }>((resolve) => {
      resolveFirstConfig = resolve;
    });

    const sync1 = runtime.sync([{ id: 'focus-mode', enabled: 1 }], (id) => {
      requestedIds.push(id);
      return firstConfigPromise;
    });
    const sync2 = runtime.sync([{ id: 'focus-mode', enabled: 0 }], async () => ({ values: {} }));
    await sync2;

    expect(focusModeEnabled.value).toBe(false);
    expect(runtime.isPluginAvailable('focus-mode')).toBe(false);

    resolveFirstConfig?.({ values: { autoEnableFocusMode: true } });
    await sync1;

    // 陈旧 sync 不得复活已停用插件
    expect(focusModeEnabled.value).toBe(false);
    expect(runtime.isPluginAvailable('focus-mode')).toBe(false);
    expect(requestedIds.every((id) => id === 'focus-mode')).toBe(true);
    focusModeEnabled.value = false;
    runtime.destroy();
  });
});
