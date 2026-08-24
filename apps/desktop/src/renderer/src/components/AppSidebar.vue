<script setup lang="ts">
import {computed} from 'vue'
import {
  ArrowUpRight,
  Command,
  FileText,
  MoreHorizontal,
  PenLine,
  Plane,
  Plus,
  Settings,
  Sparkles
} from 'lucide-vue-next'
import type {Conversation} from '@/types/chat'

const props = defineProps<{ conversations: Conversation[]; activeId: string }>()
const emit = defineEmits<{ select: [id: string]; create: [] }>()
const activeId = computed(() => props.activeId)
const conversationIcons = {plane: Plane, 'arrow-up-right': ArrowUpRight, command: Command, sparkles: Sparkles}

function getConversationIcon(icon: keyof typeof conversationIcons) {
  return conversationIcons[icon] ?? PenLine
}
</script>

<template>
  <aside class="sidebar">
    <el-button class="new-chat" type="success" plain @click="emit('create')">
      <Plus :size="19" :stroke-width="2.2"/>
      <span>新建对话</span><kbd>Ctrl K</kbd></el-button>
    <div class="sidebar-label">最近对话</div>
    <nav class="conversation-list">
      <button v-for="conversation in conversations" :key="conversation.id" class="conversation"
              :class="{ active: activeId === conversation.id }" @click="emit('select', conversation.id)">
        <span class="conversation-icon" :class="conversation.tone"><component
            :is="getConversationIcon(conversation.icon)" :size="17" :stroke-width="2.1"/></span>
        <span class="conversation-copy"><strong>{{ conversation.title }}</strong><small>{{
            conversation.preview
          }}</small></span>
        <MoreHorizontal class="more" :size="18" :stroke-width="2"/>
      </button>
    </nav>
    <div class="sidebar-bottom">
      <button class="side-link">
        <FileText :size="21" :stroke-width="2"/>
        <span class="side-link-label">模板库</span>
        <el-tag size="small" effect="plain">12</el-tag>
      </button>
      <button class="side-link">
        <Settings :size="21" :stroke-width="2"/>
        <span class="side-link-label">设置</span></button>
      <div class="profile">
        <el-avatar :size="32">M</el-avatar>
        <span class="profile-copy"><strong>Moe</strong><small>个人空间</small></span>
        <MoreHorizontal class="profile-more" :size="20"/>
      </div>
    </div>
  </aside>
</template>
