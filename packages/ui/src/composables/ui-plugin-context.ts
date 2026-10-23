import { inject, provide, type InjectionKey, type Ref } from 'vue';
import type { LearningStorePort } from '@aervox/api-client';
import type { PluginEventBus } from './plugin-events';
import type { PluginStateStore } from './plugin-state';

/** Stable capabilities for UI plugins, independent of workbench composable internals. */
export interface UIPluginContext {
  navigation: {
    openTool(tool: 'timer' | 'todo' | 'history' | 'diary'): void;
    runMenuAction(action: () => void): void;
    closeTaskCenter(): void;
    setQuietStartup(value: boolean): void;
  };
  cards: {
    acquireSlotPreset(owner: string, slots: Array<string | null>): () => void;
    reviewCount: Readonly<Ref<number>>;
  };
  conversation: { streaming: Readonly<Ref<boolean>>; latestAssistantText: Readonly<Ref<string>> };
  /** Instance-scoped domain resources; plugins request only the resources they display. */
  learning: Pick<LearningStorePort,
    'mistakes' | 'learningPlans' | 'activePracticeSession' | 'error' | 'loadMistakes' | 'loadPlans' | 'loadPractice' | 'loadReviews' |
    'archiveLearningPlan' | 'generateLearningPlan' | 'setPlanTaskStatus' | 'setMistakeStatus' | 'setMistakeInsight' |
    'completePracticeSession' | 'submitPracticeAnswer' | 'startMistakePractice'>;
  pluginEvents: PluginEventBus;
  pluginState: PluginStateStore;
  isPluginAvailable(pluginId: string): boolean;
  /** Reload availability/configuration and reconcile UI plugin instances. */
  refreshPluginUI(): Promise<void>;
  sendMessage(value?: string, options?: {metadata?: Record<string, unknown>; resend?: boolean}): Promise<void>;
}
export const UI_PLUGIN_CONTEXT_KEY: InjectionKey<UIPluginContext> = Symbol('AERVOX_UI_PLUGIN_CONTEXT');
export function provideUIPluginContext(context: UIPluginContext): void { provide(UI_PLUGIN_CONTEXT_KEY, context); }
export function useUIPluginContext(): UIPluginContext {
  const context = inject(UI_PLUGIN_CONTEXT_KEY);
  if (!context) throw new Error('[Aervox] UI plugin capabilities are unavailable outside their host');
  return context;
}
