import {computed, ref} from 'vue'
import type {ChatMessage, Conversation} from '@/types/chat'

const conversations: Conversation[] = [
    {
        id: 'travel',
        title: '整理一份旅行计划',
        preview: '明天 · 10:42',
        updatedAt: '今天，8 月 23 日',
        icon: 'plane',
        tone: 'mint'
    },
    {
        id: 'review',
        title: '我的每周复盘',
        preview: '昨天 · 18:20',
        updatedAt: '昨天',
        icon: 'arrow-up-right',
        tone: 'coral'
    },
    {
        id: 'rust',
        title: '学习 Rust 的路线',
        preview: '周一 · 09:12',
        updatedAt: '周一',
        icon: 'command',
        tone: 'lavender'
    },
]

const initialMessages: ChatMessage[] = [
    {id: 'm1', role: 'assistant', content: '早上好，Moe！我已经准备好了。今天想一起规划什么？', createdAt: '10:42'},
    {id: 'm2', role: 'user', content: '我想去镰仓和江之岛玩两天，喜欢海边和安静的小店。', createdAt: '10:43'},
    {
        id: 'm3',
        role: 'assistant',
        content: '这个组合很棒！我会把行程安排得松弛一点，留出在海边散步和发现小店的时间。出发地是东京吗？',
        createdAt: '10:43'
    },
]

export function useChat() {
    const activeConversationId = ref('travel')
    const messages = ref<ChatMessage[]>([...initialMessages])
    const isReplying = ref(false)
    const activeConversation = computed(() => conversations.find(({id}) => id === activeConversationId.value) ?? {
        id: 'new',
        title: '新的对话',
        preview: '现在',
        updatedAt: '今天，8 月 23 日',
        icon: 'sparkles' as const,
        tone: 'mint' as const
    })

    function selectConversation(id: string) {
        activeConversationId.value = id
        if (id !== 'travel') messages.value = [{
            id: `welcome-${id}`,
            role: 'assistant',
            content: '好的，我们开始一个新的工作空间。告诉我你想完成什么。',
            createdAt: '现在'
        }]
    }

    function createConversation() {
        activeConversationId.value = 'new'
        messages.value = []
    }

    function sendMessage(content: string) {
        const value = content.trim()
        if (!value || isReplying.value) return
        messages.value.push({id: crypto.randomUUID(), role: 'user', content: value, createdAt: currentTime()})
        isReplying.value = true
        window.setTimeout(() => {
            messages.value.push({
                id: crypto.randomUUID(),
                role: 'assistant',
                content: '收到，我会把这件事拆成清晰、轻松的几个步骤。我们继续。',
                createdAt: currentTime()
            })
            isReplying.value = false
        }, 550)
    }

    return {
        conversations,
        activeConversation,
        activeConversationId,
        messages,
        isReplying,
        selectConversation,
        createConversation,
        sendMessage
    }
}

function currentTime() {
    return new Date().toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})
}
