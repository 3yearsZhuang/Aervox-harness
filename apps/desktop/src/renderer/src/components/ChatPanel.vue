<script setup lang="ts">
import {nextTick, ref, watch} from 'vue'
import {
  ArrowUp,
  ChevronDown,
  Coffee,
  LoaderCircle,
  Map,
  Mic,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Search,
  Sparkles
} from 'lucide-vue-next'
import type {ChatMessage} from '@/types/chat'

const props = defineProps<{ title: string; dateLabel: string; messages: ChatMessage[]; replying: boolean }>()
const emit = defineEmits<{ send: [content: string] }>()
const input = ref('')
const scrollArea = ref<HTMLElement>()
const model = ref('Fairy 2.1')
const models = ['Fairy 2.1', 'Fairy 2.0', 'Fairy Mini']
const quickPrompts = [{text: '规划一次旅行', icon: Map}, {text: '帮我写点东西', icon: PenLine}, {
  text: '随便聊聊',
  icon: Coffee
}]

function send() {
  if (input.value.trim()) {
    emit('send', input.value);
    input.value = ''
  }
}

async function scrollToBottom() {
  await nextTick();
  if (scrollArea.value) scrollArea.value.scrollTop = scrollArea.value.scrollHeight
}

watch(() => props.messages.length, scrollToBottom)

function usePrompt(text: string) {
  input.value = text;
}

function selectModel(value: string | number | object) {
  model.value = String(value)
}
</script>

<template>
  <main class="chat-area">
    <header class="chat-header">
      <div class="chat-heading">
        <div class="eyebrow">PERSONAL SPACE</div>
        <h1>{{ title || '新的对话' }}</h1></div>
      <div class="header-tools">
        <el-tooltip content="搜索">
          <button class="header-icon-button" type="button" aria-label="搜索">
            <Search :size="22" :stroke-width="2"/>
          </button>
        </el-tooltip>
        <el-tooltip content="更多选项">
          <button class="header-icon-button" type="button" aria-label="更多选项">
            <MoreHorizontal :size="23" :stroke-width="2"/>
          </button>
        </el-tooltip>
      </div>
    </header>
    <div ref="scrollArea" class="chat-content">
      <div class="chat-inner">
        <div class="date-divider"><span>{{ dateLabel }}</span></div>
        <article v-for="message in messages" :key="message.id" class="message" :class="`${message.role}-message`">
          <el-avatar class="message-avatar" :class="message.role === 'assistant' ? 'assistant-avatar' : 'user-avatar'"
                     :size="34">
            <Sparkles v-if="message.role === 'assistant'" :size="20" :stroke-width="2.1"/>
            <span v-else>M</span></el-avatar>
          <div class="message-body">
            <div class="message-meta"><strong>{{
                message.role === 'assistant' ? 'Fairy' : '你'
              }}</strong><span>{{ message.createdAt }}</span></div>
            <p>{{ message.content }}</p>
            <div v-if="message.id === 'm1'" class="prompt-row">
              <el-button v-for="prompt in quickPrompts" :key="prompt.text" size="small" plain
                         @click="usePrompt(prompt.text)">
                <component :is="prompt.icon" :size="19" :stroke-width="2"/>
                <span>{{ prompt.text }}</span></el-button>
            </div>
            <div v-if="message.id === 'm3'" class="inline-note"><span class="note-dot"/><span>已识别偏好：海边 · 慢节奏 · 小店</span>
            </div>
          </div>
        </article>
        <div v-if="replying" class="typing">
          <LoaderCircle class="is-loading" :size="17"/>
          Fairy 正在思考…
        </div>
      </div>
    </div>
    <div class="composer-wrap">
      <div class="composer">
        <el-input v-model="input" type="textarea" :autosize="{ minRows: 2, maxRows: 5 }" resize="none"
                  placeholder="给 Fairy 发消息…" @keydown.enter.exact.prevent="send"/>
        <div class="composer-footer">
          <div class="composer-tools">
            <el-tooltip content="添加附件">
              <el-button text>
                <Paperclip :size="22" :stroke-width="2"/>
              </el-button>
            </el-tooltip>
            <el-tooltip content="语音输入">
              <el-button text>
                <Mic :size="22" :stroke-width="2"/>
              </el-button>
            </el-tooltip>
            <el-dropdown trigger="click" @command="selectModel">
              <el-button class="model-selector" plain><span class="model-label">{{ model }}</span>
                <ChevronDown :size="18" :stroke-width="2"/>
              </el-button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-for="item in models" :key="item" :command="item"
                                    :class="{ 'is-active': model === item }">{{ item }}
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
          <el-button class="send-btn" type="primary" :disabled="!input.trim() || replying" circle @click="send">
            <ArrowUp :size="23" :stroke-width="2.3"/>
          </el-button>
        </div>
      </div>
      <div class="composer-hint">Fairy 可能会犯错，请核对重要信息</div>
    </div>
  </main>
</template>
