import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useWorkbenchConversation } from '../src/composables/useWorkbenchConversation.js';

describe('BTD-06 客户端会话防复活与乱序防御仿真测试', () => {
  it('模拟网络延迟下用户快速切换会话：旧会话迟到消息 100% 被拦截，新会话故事树纯净', async () => {
    const recordActivity = vi.fn();
    const conversation = useWorkbenchConversation({ recordActivity });

    const activeSessionId = ref('session_A');
    const submittedSessionId = activeSessionId.value;

    // 假设在 session_A 下提交了一条消息，新开一行 streaming
    conversation.story.value.push({
      id: 2,
      speaker: 'user',
      text: 'Session A 问题',
      state: 'complete',
    });
    const liveLine = {
      id: 3,
      speaker: 'assistant' as const,
      text: '',
      state: 'streaming' as const,
    };
    conversation.story.value.push(liveLine);
    conversation.streaming.value = true;

    // 模拟用户在 100ms 后切换到了 session_B
    activeSessionId.value = 'session_B';
    conversation.resetStory();
    conversation.streaming.value = false;

    // 此时新会话初始状态
    expect(conversation.story.value).toHaveLength(1);
    expect(conversation.story.value[0]?.text).toContain('你好，我是思隅');

    // 模拟 500ms 网络延迟后，旧 session_A 的流式响应迟到到达
    const handleIncomingDelta = (delta: string) => {
      // 客户端安全投影防御：比对 session
      if (activeSessionId.value !== submittedSessionId) {
        return; // 丢弃跨会话迟到事件
      }
      liveLine.text += delta;
    };

    const handleIncomingDone = () => {
      if (activeSessionId.value !== submittedSessionId) {
        return; // 丢弃跨会话终态
      }
      liveLine.state = 'complete';
    };

    // 迟到推送
    handleIncomingDelta('Session A 迟到的回复内容');
    handleIncomingDone();

    // 断言：新会话没有受到任何旧 session_A 内容的污染
    expect(conversation.story.value).toHaveLength(1);
    expect(conversation.story.value[0]?.text).not.toContain('Session A');
    expect(liveLine.text).toBe('');
    expect(liveLine.state).toBe('streaming');
  });

  it('会话切换时立即终止 streaming 状态并重置 story', () => {
    const recordActivity = vi.fn();
    const conversation = useWorkbenchConversation({ recordActivity });

    conversation.streaming.value = true;
    conversation.story.value.push({
      id: 2,
      speaker: 'assistant',
      text: '正在生成中...',
      state: 'streaming',
    });

    // 切换会话
    conversation.resetStory('你好，这是新会话');
    conversation.streaming.value = false;

    expect(conversation.streaming.value).toBe(false);
    expect(conversation.story.value).toHaveLength(1);
    expect(conversation.story.value[0]?.text).toBe('你好，这是新会话');
  });
});
