<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { ElMessage } from '../../utils/element'
import { BookOpen, Copy, Check } from 'lucide-vue-next'
import { renderMarkdown } from '../../utils/markdown'
import { useAervoxSkills, type SkillDto } from '@aervox/api-client'
import { AervoxDialog, AervoxButton } from '../../primitives'

const props = defineProps<{
  open: boolean
  skill: SkillDto | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const api = useAervoxSkills()
const content = ref('')
const loading = ref(false)
const copied = ref(false)

const renderedHtml = computed(() => {
  if (!content.value) return ''
  return renderMarkdown(content.value)
})

watch(
  () => props.open,
  async (isOpen) => {
    if (!isOpen || !props.skill) return
    loading.value = true
    content.value = ''
    try {
      const res = await api.getSkillContent(props.skill.id || props.skill.name)
      content.value = res.content
    } catch (e) {
      ElMessage.error(e instanceof Error ? e.message : '读取技能说明失败')
      emit('close')
    } finally {
      loading.value = false
    }
  },
)

async function copyContent(): Promise<void> {
  if (!content.value) return
  try {
    await navigator.clipboard.writeText(content.value)
    copied.value = true
    ElMessage.success('已复制技能 Markdown 全文')
    setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    ElMessage.error('复制失败')
  }
}
</script>

<template>
  <AervoxDialog
    :model-value="open"
    :title="skill?.name || '技能说明'"
    :subtitle="skill?.description || ''"
    :icon="BookOpen"
    size="lg"
    @close="emit('close')"
  >
    <div v-if="loading" class="skill-content-loading">正在读取技能正文 (SKILL.md)…</div>
    <div v-else class="skill-content-body">
      <div class="markdown-preview markdown-body" v-html="renderedHtml" />
    </div>

    <template #footer>
      <AervoxButton
        variant="secondary"
        :icon="copied ? Check : Copy"
        :disabled="!content"
        @click="copyContent"
      >
        {{ copied ? '已复制' : '复制正文' }}
      </AervoxButton>
      <AervoxButton variant="primary" @click="emit('close')">关闭</AervoxButton>
    </template>
  </AervoxDialog>
</template>

<style scoped>
.skill-content-loading {
  padding: 36px 0;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}
.skill-content-body {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);

}
.markdown-preview :deep(h1),
.markdown-preview :deep(h2),
.markdown-preview :deep(h3) {
  margin: 14px 0 8px;
  color: var(--text-primary);
  font-weight: 600;
}
.markdown-preview :deep(pre) {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  overflow-x: auto;
  font-size: 12px;
}
.markdown-preview :deep(code) {
  background: var(--bg-input);
  padding: 2px 5px;
  border-radius: 4px;
  font-size: 12px;
}
.markdown-preview :deep(p) {
  margin: 6px 0;
}
.skill-dialog-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
}
.btn-copy-content {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-soft);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s ease;
}
.btn-copy-content:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.btn-copy-content:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
