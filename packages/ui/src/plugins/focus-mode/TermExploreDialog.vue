<script setup lang="ts">
import { ref, watch } from 'vue';
import {
  BookOpen,
  Sparkles,
  X,
  Loader2,
} from 'lucide-vue-next';
import { exploreTerm, useAervoxPlugins } from '@aervox/api-client';
import type { ExtractedTerm, TermExploreResponse, TermExploreKind } from '@aervox/contracts';
import { renderMarkdown } from '../../utils/markdown';

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
        let configSnapshot = await pluginApi.getConfig('focus-mode').catch(() => null);
        if (!configSnapshot?.values) {
          configSnapshot = await pluginApi.getConfig('study-mode').catch(() => null);
        }
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
    const res = await exploreTerm({
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
  <div v-if="modelValue" class="term-dialog-overlay" @click.self="close">
    <div class="term-dialog-card" role="dialog" aria-modal="true">
      <!-- 头部 -->
      <div class="term-dialog-header">
        <div class="term-dialog-title">
          <BookOpen :size="16" class="title-icon" />
          <span>{{ term?.text || '概念解释' }}</span>
          <span v-if="term?.relation" class="relation-tag" :class="term.relation">
            {{ term.relation === 'background' ? '深度推导' : '横向对比' }}
          </span>
        </div>
        <button type="button" class="close-btn" aria-label="关闭" @click="close">
          <X :size="16" />
        </button>
      </div>

      <!-- 内容区 -->
      <div class="term-dialog-body">
        <div v-if="loading" class="term-dialog-loading">
          <Loader2 :size="24" class="spin" />
          <p>正在生成概念深度拆解与启发引导…</p>
        </div>

        <div v-else-if="error" class="term-dialog-error">
          <p>{{ error }}</p>
          <button type="button" class="retry-btn" @click="fetchExploreData">重试</button>
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
    </div>
  </div>
</template>

<style scoped>
.term-dialog-overlay {
  position: fixed;
  inset: 0;
  background-color: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  backdrop-filter: blur(2px);
}

.term-dialog-card {
  width: 90%;
  max-width: 520px;
  max-height: 80vh;
  background: var(--color-bg-elevated, #ffffff);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.15);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--color-border-subtle, rgba(0, 0, 0, 0.08));
}

.term-dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-border-subtle, #f0f0f0);
}

.term-dialog-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  font-size: 15px;
}

.title-icon {
  color: var(--color-primary, #6366f1);
}

.relation-tag {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: 4px;
  font-weight: normal;
}
.relation-tag.background {
  background: #eff6ff;
  color: #2563eb;
}
.relation-tag.related {
  background: #fdf2f8;
  color: #db2777;
}

.close-btn {
  border: none;
  background: none;
  cursor: pointer;
  color: #999;
  padding: 4px;
  border-radius: 4px;
}
.close-btn:hover {
  background: rgba(0, 0, 0, 0.05);
  color: #333;
}

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
