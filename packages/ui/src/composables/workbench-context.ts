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
  sessions: UseAervoxSessionsReturn;
  projects?: UseAervoxProjectsReturn;
  openProjectManager?: () => void;
  openImportSession?: () => void;
  openCommandPalette?: () => void;
  sendMessage: (value?: string, options?: { quizMode?: boolean; resend?: boolean }) => Promise<void>;
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
