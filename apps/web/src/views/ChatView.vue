<script setup lang="ts">
import { ref } from 'vue';
import { streamAervoxTurn } from '@/composables/useAervoxTurn';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

const messages = ref<ChatMessage[]>([
  { role: 'assistant', text: '你好，我是 Aervox 伴学桌宠。今天想学点什么？' },
]);
const input = ref('');
const streaming = ref(false);

const suggestions = ['解释什么是递归', '帮我出 3 道二分查找练习', '复习一下昨天的知识点'];

const send = async (text?: string): Promise<void> => {
  const content = (text ?? input.value).trim();
  if (!content || streaming.value) return;
  input.value = '';
  messages.value.push({ role: 'user', text: content });
  messages.value.push({ role: 'assistant', text: '' });
  streaming.value = true;
  const answer = messages.value[messages.value.length - 1];
  try {
    await streamAervoxTurn(content, {
      onDelta: (t) => {
        answer.text += t;
      },
      onDone: () => undefined,
    });
  } catch (e) {
    answer.text = `请求失败：${e instanceof Error ? e.message : String(e)}`;
  } finally {
    streaming.value = false;
  }
};

const askSuggestion = (s: string): void => {
  void send(s);
};
</script>

<template>
  <div class="chat">
    <div class="messages">
      <div v-for="(m, i) in messages" :key="i" class="message" :class="m.role">
        <div class="bubble">{{ m.text }}<span v-if="streaming && m.role === 'assistant' && i === messages.length - 1" class="cursor">▍</span></div>
      </div>
    </div>

    <div class="suggestions" v-if="messages.length <= 2">
      <el-tag
        v-for="s in suggestions"
        :key="s"
        class="suggestion"
        effect="plain"
        @click="askSuggestion(s)"
      >
        {{ s }}
      </el-tag>
    </div>

    <div class="composer">
      <el-input
        v-model="input"
        placeholder="输入问题，再按 Enter / 发送"
        :disabled="streaming"
        @keyup.enter="send()"
      />
      <el-button type="primary" :loading="streaming" @click="send()">发送</el-button>
    </div>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.message.user {
  align-self: flex-end;
}
.message.assistant {
  align-self: flex-start;
  max-width: 80%;
}
.bubble {
  padding: 10px 14px;
  border-radius: 12px;
  background: var(--el-fill-color-light);
  white-space: pre-wrap;
  line-height: 1.6;
}
.message.user .bubble {
  background: var(--el-color-primary-light-8);
}
.cursor {
  animation: blink 1s steps(1) infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
.suggestions {
  display: flex;
  gap: 8px;
  padding: 0 16px 12px;
  flex-wrap: wrap;
}
.suggestion {
  cursor: pointer;
}
.composer {
  display: flex;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--el-border-color-lighter);
}
</style>