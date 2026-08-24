export type MessageRole = 'assistant' | 'user'

export interface ChatMessage {
    id: string
    role: MessageRole
    content: string
    createdAt: string
}

export interface Conversation {
    id: string
    title: string
    preview: string
    updatedAt: string
    icon: 'plane' | 'arrow-up-right' | 'command' | 'sparkles'
    tone: 'mint' | 'coral' | 'lavender'
}
