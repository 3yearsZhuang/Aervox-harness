import { inject, provide, type InjectionKey } from 'vue';
import type { WorkbenchLayoutComposable } from './useWorkbenchLayout';
import type { WorkbenchTimerComposable } from './useWorkbenchTimer';
import type { WorkbenchComposerComposable } from './useWorkbenchComposer';
import type { WorkbenchConversationComposable } from './useWorkbenchConversation';
import type { WorkbenchCardsComposable } from './useWorkbenchCards';
import type { WorkbenchProactiveComposable } from './useWorkbenchProactive';
import type { UIRegistry } from '../registry/ui-registry';
import type { WorkbenchPluginRuntime } from '../plugins/plugin-runtime';
import type { PluginEventBus } from './plugin-events';
import type { PluginStateStore } from './plugin-state';
import type { UseAervoxProjectsReturn, UseAervoxSessionsReturn } from '@aervox/api-client';

export interface WorkbenchContext {
  layout: WorkbenchLayoutComposable;
  timer: WorkbenchTimerComposable;
  composer: WorkbenchComposerComposable;
  conversation: WorkbenchConversationComposable;
  cards: WorkbenchCardsComposable;
  proactive: WorkbenchProactiveComposable;
  registry: UIRegistry;
  pluginRuntime?: WorkbenchPluginRuntime;
  /**
   * CR-060：通用插件事件总线。宿主只做转发，不解释事件语义；
   * 插件在自身模块内订阅并持有状态。
   */
  pluginEvents: PluginEventBus;
  /**
   * CR-060：插件命名空间化状态。宿主只提供存储与响应式容器，
   * 不感知任何插件状态键与其语义。
   */
  pluginState: PluginStateStore;
  sessions: UseAervoxSessionsReturn;
  projects?: UseAervoxProjectsReturn;
  openProjectManager?: () => void;
  openImportSession?: () => void;
  openCommandPalette?: () => void;
  /** 发送消息；模式等插件私有语义经 `metadata` 透传，宿主不解释其取值（CR-060） */
  sendMessage: (value?: string, options?: { metadata?: Record<string, unknown>; resend?: boolean }) => Promise<void>;
}


export const WORKBENCH_CONTEXT_KEY: InjectionKey<WorkbenchContext> = Symbol('AERVOX_WORKBENCH_CONTEXT');

export function provideWorkbenchContext(context: WorkbenchContext): void {
  provide(WORKBENCH_CONTEXT_KEY, context);
}

export function useWorkbenchContext(): WorkbenchContext {
  const context = inject(WORKBENCH_CONTEXT_KEY);
  if (!context) {
    throw new Error('[Aervox] useWorkbenchContext must be called within an AervoxWorkbench tree');
  }
  return context;
}
