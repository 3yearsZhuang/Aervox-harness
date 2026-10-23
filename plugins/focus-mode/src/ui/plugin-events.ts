/**
 * Aervox｜思隅 plugins/focus-mode（UI 侧） — 术语抽取状态与事件契约
 *
 * CR-060：术语状态归插件所有。宿主不再持有 `currentExtractedTerms` / `selectedTerm`
 * 等字段，也不再为 `terms_extracted` 预留专用回调；插件在自身模块内订阅宿主的
 * **通用插件事件总线**并持有状态。
 *
 * 本文件位于插件自有目录（`packages/ui/src/plugins/focus-mode/`），是插件实现的一部分，
 * S6 将随插件 UI 一并迁至 `plugins/focus-mode/src/ui/`。
 */
import { ref, type Ref } from 'vue';
import type { PluginEventBus } from '@aervox/ui/plugin-api';

import { termsExtractedEventDataSchema, TERMS_EXTRACTED_EVENT, type ExtractedTerm, type TermsExtractedEventData } from '../contracts/terms';
export { TERMS_EXTRACTED_EVENT, type ExtractedTerm, type TermsExtractedEventData } from '../contracts/terms';

/** Reject malformed events with the same schema used by the server projection. */
export function parseTermsExtracted(data: unknown): TermsExtractedEventData | null {
  const parsed = termsExtractedEventDataSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

export function createTermsState() {
/** 插件私有 UI 状态：术语条与名词解释弹窗 */
const extractedTerms: Ref<ExtractedTerm[]> = ref([]);
const selectedTerm: Ref<ExtractedTerm | null> = ref(null);
const exploreDialogOpen = ref(false);

/** 清空术语状态（新回合或重置会话时调用） */
function resetTermsState(): void {
  extractedTerms.value = [];
  selectedTerm.value = null;
  exploreDialogOpen.value = false;
}

/** 打开术语名词解释弹窗 */
function openTermExplore(term: ExtractedTerm): void {
  selectedTerm.value = term;
  exploreDialogOpen.value = true;
}

/**
 * 订阅宿主通用插件事件总线；返回取消订阅函数。
 * 事件类型与载荷结构都由本插件自己声明与校验，宿主不参与解释。
 */
function subscribeTermsEvents(bus: PluginEventBus): () => void {
  return bus.on((eventType, data) => {
    if (eventType !== TERMS_EXTRACTED_EVENT) return;
    const parsed = parseTermsExtracted(data);
    if (!parsed) return;
    extractedTerms.value = parsed.terms;
  });
}
  return { extractedTerms, selectedTerm, exploreDialogOpen, resetTermsState, openTermExplore, subscribeTermsEvents };
}
