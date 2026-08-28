<script setup lang="ts">
import { computed, ref } from 'vue'
import { Check, ChevronRight, HelpCircle, Send } from 'lucide-vue-next'
import type { AskUserQuestionAnswerItem, UserQuestionRequiredEventData } from '@aervox/contracts'

const props = defineProps<{
  questionData: UserQuestionRequiredEventData
  submitting?: boolean
}>()

const emit = defineEmits<{
  (e: 'submit', answers: AskUserQuestionAnswerItem[]): void
}>()

// 用户在当前各个问题上的选择与自由填写
const selections = ref<Record<string, string[]>>({})
const customAnswers = ref<Record<string, string>>({})

// 初始化默认选中的 Recommended 选项（如果有）
props.questionData.questions.forEach((q) => {
  if (!selections.value[q.id]) {
    const recommended = q.options?.find((opt) => opt.label.includes('(Recommended)'))
    selections.value[q.id] = recommended ? [recommended.label] : []
  }
})

function toggleOption(questionId: string, label: string, multiSelect = false) {
  const current = selections.value[questionId] || []
  if (multiSelect) {
    if (current.includes(label)) {
      selections.value[questionId] = current.filter((l) => l !== label)
    } else {
      selections.value[questionId] = [...current, label]
    }
  } else {
    selections.value[questionId] = [label]
  }
}

function isSelected(questionId: string, label: string): boolean {
  return (selections.value[questionId] || []).includes(label)
}

const isComplete = computed(() => {
  return props.questionData.questions.every((q) => {
    const selected = selections.value[q.id] || []
    const custom = (customAnswers.value[q.id] || '').trim()
    return selected.length > 0 || custom.length > 0
  })
})

function handleSubmit() {
  if (!isComplete.value || props.submitting) return
  const answers: AskUserQuestionAnswerItem[] = props.questionData.questions.map((q) => {
    const selected = selections.value[q.id] || []
    const custom = (customAnswers.value[q.id] || '').trim()
    return {
      id: q.id,
      selected,
      custom: custom || undefined,
    }
  })
  emit('submit', answers)
}
</script>

<template>
  <div class="user-question-card" role="region" aria-label="AI 提问向用户确认">
    <div class="uq-header">
      <HelpCircle :size="18" class="uq-icon" />
      <span class="uq-title">思隅需要你的确认与决策</span>
    </div>

    <div class="uq-body">
      <div
        v-for="(item, idx) in questionData.questions"
        :key="item.id"
        class="uq-item"
      >
        <div class="uq-question-meta">
          <span v-if="item.header" class="uq-chip">{{ item.header }}</span>
          <span class="uq-question-text">{{ item.question }}</span>
        </div>

        <div v-if="item.detail" class="uq-detail">
          <pre>{{ item.detail }}</pre>
        </div>

        <!-- 选项列表 -->
        <div v-if="item.options && item.options.length > 0" class="uq-options-grid">
          <button
            v-for="opt in item.options"
            :key="opt.label"
            type="button"
            class="uq-option-btn"
            :class="{ active: isSelected(item.id, opt.label) }"
            :disabled="submitting"
            @click="toggleOption(item.id, opt.label, item.multiSelect)"
          >
            <span class="uq-option-check">
              <Check v-if="isSelected(item.id, opt.label)" :size="14" />
            </span>
            <div class="uq-option-info">
              <span class="uq-option-label">{{ opt.label }}</span>
              <small v-if="opt.description" class="uq-option-desc">{{ opt.description }}</small>
            </div>
          </button>
        </div>

        <!-- 自由补充 / 自定义输入 -->
        <div class="uq-custom-input">
          <input
            v-model="customAnswers[item.id]"
            type="text"
            placeholder="或者输入其他补充说明…"
            :disabled="submitting"
            @keydown.enter.prevent="handleSubmit"
          />
        </div>
      </div>
    </div>

    <div class="uq-actions">
      <button
        type="button"
        class="uq-submit-btn"
        :disabled="!isComplete || submitting"
        @click="handleSubmit"
      >
        <Send :size="16" />
        <span>{{ submitting ? '正在提交…' : '确认并继续' }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.user-question-card {
  margin: 1rem 0;
  padding: 1rem 1.25rem;
  background: var(--bg-card, rgba(255, 255, 255, 0.85));
  border: 1px solid var(--border-color, rgba(0, 0, 0, 0.08));
  border-radius: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.04);
  backdrop-filter: blur(8px);
}

.uq-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-weight: 600;
  font-size: 0.95rem;
  color: var(--text-primary, #1e293b);
  margin-bottom: 0.85rem;
}

.uq-icon {
  color: var(--accent-color, #3b82f6);
}

.uq-body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.uq-item {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.uq-question-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.uq-chip {
  display: inline-block;
  padding: 0.15rem 0.45rem;
  font-size: 0.75rem;
  font-weight: 500;
  background: rgba(59, 130, 246, 0.1);
  color: #2563eb;
  border-radius: 4px;
}

.uq-question-text {
  font-size: 0.9rem;
  color: var(--text-primary, #334155);
}

.uq-detail {
  padding: 0.5rem 0.75rem;
  background: rgba(0, 0, 0, 0.03);
  border-radius: 6px;
  font-size: 0.8rem;
  overflow-x: auto;
}

.uq-options-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.uq-option-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-input, #ffffff);
  border: 1px solid var(--border-color, #e2e8f0);
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  transition: all 0.15s ease;
}

.uq-option-btn:hover:not(:disabled) {
  border-color: var(--accent-color, #3b82f6);
}

.uq-option-btn.active {
  background: rgba(59, 130, 246, 0.08);
  border-color: var(--accent-color, #3b82f6);
}

.uq-option-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border: 1px solid #cbd5e1;
  border-radius: 4px;
  color: #2563eb;
}

.uq-option-btn.active .uq-option-check {
  border-color: #3b82f6;
  background: rgba(59, 130, 246, 0.15);
}

.uq-option-info {
  display: flex;
  flex-direction: column;
}

.uq-option-label {
  font-size: 0.85rem;
  font-weight: 500;
  color: #1e293b;
}

.uq-option-desc {
  font-size: 0.75rem;
  color: #64748b;
}

.uq-custom-input input {
  width: 100%;
  padding: 0.4rem 0.65rem;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  font-size: 0.85rem;
  outline: none;
  transition: border-color 0.15s;
}

.uq-custom-input input:focus {
  border-color: #3b82f6;
}

.uq-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 0.85rem;
}

.uq-submit-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.45rem 1rem;
  background: var(--accent-color, #3b82f6);
  color: #ffffff;
  border: none;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 500;
  cursor: pointer;
  transition: opacity 0.15s;
}

.uq-submit-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
