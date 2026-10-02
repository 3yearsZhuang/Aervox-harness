<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  BookOpen,
  Sparkles,
  Loader2,
} from 'lucide-vue-next';
import { requestAervoxApi, useAervoxPlugins } from '@aervox/api-client';
import type { ExtractedTerm } from './plugin-events';
import { renderMarkdown } from '../../utils/markdown';
import { AervoxDialog, AervoxButton } from '../../primitives';

/** 追问探索方向（本插件自有端点契约；S6 起与插件服务端共用同一份模式定义） */
type TermExploreKind = 'child' | 'related' | 'branch';

/** `/v1/terms/explore` 响应体（本插件自有端点） */
interface TermExploreResponse {
  term: string;
  kind: TermExploreKind;
  content: string;
  relatedQuestions: string[];
  childSessionId?: string;
}

const props = defineProps<{
  modelValue: boolean;
  term: ExtractedTerm | null;
  contextText?: string;
  sessionId?: string;
  defaultKind?: TermExploreKind;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void;
}>();

const loading = ref(false);
const error = ref<string | null>(null);
const exploreResult = ref<TermExploreResponse | null>(null);

async function fetchExploreData() {
  if (!props.term?.text) return;
  loading.value = true;
  error.value = null;
  try {
    let exploreKind: TermExploreKind = props.defaultKind ?? 'child';
    if (!props.defaultKind) {
      try {
        const pluginApi = useAervoxPlugins();
        // CR-060：只认主 id，不再回退历史别名
        const configSnapshot = await pluginApi.getConfig('focus-mode').catch(() => null);
        const configuredKind = configSnapshot?.values?.defaultExploreKind;
        if (
          configuredKind === 'child' ||
          configuredKind === 'related' ||
          configuredKind === 'branch'
        ) {
          exploreKind = configuredKind;
        }
      } catch {
        // 插件未就绪时使用兜底
      }
    }
    // CR-060：插件自有端点经通用请求透传调用，宿主无需为该路径提供具名函数
    const res = await requestAervoxApi<TermExploreResponse>('POST', '/v1/terms/explore', {
      term: props.term.text,
      kind: exploreKind,
      context: props.contextText,
      sessionId: props.sessionId,
    });
    exploreResult.value = res;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载名词解释失败';
  } finally {
    loading.value = false;
  }
}

watch(
  () => props.modelValue,
  (open) => {
    if (open) {
      void fetchExploreData();
    } else {
      exploreResult.value = null;
      error.value = null;
    }
  },
);

function close() {
  emit('update:modelValue', false);
}
</script>

<template>
  <AervoxDialog
    :model-value="modelValue"
    :title="term?.text || '概念解释'"
    :subtitle="term?.relation === 'background' ? '深度推导' : term?.relation ? '横向对比' : '名词核心拆解与启发引导'"
    :icon="BookOpen"
    size="md"
    @update:model-value="emit('update:modelValue', $event)"
    @close="close"
  >
    <div class="term-dialog-body">
      <div v-if="loading" class="term-dialog-loading">
        <Loader2 :size="24" class="spin" />
        <p>正在生成概念深度拆解与启发引导…</p>
      </div>

      <div v-else-if="error" class="term-dialog-error">
        <p>{{ error }}</p>
        <AervoxButton variant="secondary" size="sm" @click="fetchExploreData">重试</AervoxButton>
      </div>

      <div v-else-if="exploreResult" class="term-dialog-content">
        <!-- 概念释义 -->
        <section class="explore-section">
          <h4 class="section-label">概念核心</h4>
          <!-- eslint-disable-next-line vue/no-v-html -->
          <div class="markdown-body" v-html="renderMarkdown(exploreResult.content)" />
        </section>

        <!-- 思考与启发问题 -->
        <section v-if="exploreResult.relatedQuestions && exploreResult.relatedQuestions.length > 0" class="explore-section">
          <h4 class="section-label">
            <Sparkles :size="14" />
            <span>启发思考</span>
          </h4>
          <ul class="followups-list">
            <li v-for="(item, idx) in exploreResult.relatedQuestions" :key="idx" class="followup-item">
              {{ item }}
            </li>
          </ul>
        </section>
      </div>
    </div>

    <template #footer>
      <AervoxButton variant="primary" @click="close">知道了</AervoxButton>
    </template>
  </AervoxDialog>
</template>

<style scoped>
.term-dialog-body {

  padding: 16px;
  overflow-y: auto;
  font-size: 14px;
  line-height: 1.6;
}

.term-dialog-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 36px 0;
  color: #666;
  gap: 12px;
}

.spin {
  animation: spin 1s linear infinite;
  color: var(--color-primary, #6366f1);
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.term-dialog-error {
  text-align: center;
  padding: 24px 0;
  color: #dc2626;
}

.retry-btn {
  margin-top: 8px;
  padding: 4px 12px;
  border: 1px solid #dc2626;
  background: none;
  color: #dc2626;
  border-radius: 4px;
  cursor: pointer;
}

.explore-section {
  margin-bottom: 16px;
}
.explore-section:last-child {
  margin-bottom: 0;
}

.section-label {
  font-size: 12px;
  font-weight: 600;
  color: #888;
  text-transform: uppercase;
  margin-bottom: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.followups-list {
  margin: 0;
  padding-left: 18px;
  color: #4b5563;
}
.followup-item {
  margin-bottom: 4px;
}

.related-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.related-chip {
  background: var(--color-bg-muted, #f3f4f6);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 12px;
  color: #4b5563;
}
</style>
