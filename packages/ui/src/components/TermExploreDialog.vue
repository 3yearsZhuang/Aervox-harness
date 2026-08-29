<script setup lang="ts">
import { ref, watch } from 'vue'
import {
  BookOpen,
  Sparkles,
  X,
  Loader2,
} from 'lucide-vue-next'
import { exploreTerm } from '@aervox/api-client'
import type { ExtractedTerm, TermExploreResponse } from '@aervox/contracts'
import { renderMarkdown } from '../utils/markdown'

const props = defineProps<{
  modelValue: boolean
  term: ExtractedTerm | null
  contextText?: string
  sessionId?: string
}>()

const emit = defineEmits<{
  (e: 'update:modelValue', value: boolean): void
}>()

const loading = ref(false)
const error = ref<string | null>(null)
const exploreResult = ref<TermExploreResponse | null>(null)

async function fetchExploreData() {
  if (!props.term?.text) return
  loading.value = true
  error.value = null
  try {
    const res = await exploreTerm({
      term: props.term.text,
      kind: 'child',
      context: props.contextText,
      sessionId: props.sessionId,
    })
    exploreResult.value = res
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载名词解释失败'
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.modelValue, props.term],
  ([visible, term]) => {
    if (visible && term) {
      void fetchExploreData()
    } else {
      exploreResult.value = null
      error.value = null
    }
  },
  { immediate: true },
)

function handleClose() {
  emit('update:modelValue', false)
}
</script>

<template>
  <el-dialog
    :model-value="modelValue"
    class="term-explore-dialog"
    width="min(560px, calc(100vw - 32px))"
    align-center
    :show-close="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div class="explore-card">
      <header class="explore-head">
        <div class="explore-title-wrap">
          <div class="explore-badge">
            <BookOpen :size="13" />
            <span>名词解释</span>
          </div>
          <h3 class="explore-term-title">{{ term?.text }}</h3>
          <p v-if="term?.description" class="explore-term-desc">{{ term.description }}</p>
        </div>
        <button class="explore-close-btn" type="button" aria-label="关闭" @click="handleClose">
          <X :size="18" />
        </button>
      </header>

      <div class="explore-body">
        <div v-if="loading" class="explore-loading">
          <Loader2 class="spin-icon" :size="24" />
          <span>正在生成名词解释…</span>
        </div>

        <div v-else-if="error" class="explore-error">
          <p>{{ error }}</p>
          <button type="button" class="retry-btn" @click="fetchExploreData">重试</button>
        </div>

        <div v-else-if="exploreResult" class="explore-content">
          <div class="markdown-body" v-html="renderMarkdown(exploreResult.content)" />
        </div>
      </div>

      <footer class="explore-foot">
        <span class="explore-foot-hint">核心概念解析</span>
        <button type="button" class="explore-done-btn" @click="handleClose">知道了</button>
      </footer>
    </div>
  </el-dialog>
</template>

<style scoped>
.explore-card {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.explore-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.explore-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 700;
  border-radius: 999px;
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  margin-bottom: 6px;
}

.explore-term-title {
  margin: 0;
  font-size: 1.3rem;
  font-weight: 750;
  color: var(--text-primary);
}

.explore-term-desc {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--text-muted);
}

.explore-close-btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all .18s ease;
}

.explore-close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.explore-body {
  min-height: 140px;
  max-height: 380px;
  overflow-y: auto;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--bg-card);
  border: 1px solid var(--glass-border);
}

.explore-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 140px;
  color: var(--text-muted);
  font-size: 13px;
}

.spin-icon {
  animation: spin 1s linear infinite;
  color: var(--accent);
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.explore-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  color: var(--el-color-danger);
}

.retry-btn {
  padding: 4px 14px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  cursor: pointer;
}

.explore-markdown-rendered {
  font-size: 13.5px;
  line-height: 1.7;
  color: var(--text-primary);
}

.explore-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-top: 4px;
}

.explore-foot-hint {
  font-size: 11.5px;
  color: var(--text-muted);
}

.explore-done-btn {
  padding: 6px 16px;
  border: 0;
  border-radius: 8px;
  background: var(--accent);
  color: #ffffff;
  font-size: 12.5px;
  font-weight: 650;
  cursor: pointer;
  transition: opacity .18s ease;
}

.explore-done-btn:hover {
  opacity: .9;
}
</style>
