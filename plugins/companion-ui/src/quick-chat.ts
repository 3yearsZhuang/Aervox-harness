/**
 * Aervox 桌宠快捷对话 — 气泡展示纯函数
 *
 * 供 PetWindow.vue 快捷输入流式气泡复用：markdown 轻清理为纯文本、
 * 按回复长度计算气泡停留时长。保持无副作用以便单元测试。
 */

/** 把常见 markdown 标记清理为适合桌宠气泡的纯文本（不追求完整渲染） */
export function stripMarkdownForBubble(text: string): string {
    if (!text) return ''
    return text
        // 围栏代码块整段移除（气泡内不可读），未闭合围栏兜底；行内代码保留内容
        .replace(/```[\s\S]*?```\n?/g, '')
        .replace(/```[a-zA-Z0-9_-]*\n?/g, '')
        .replace(/`([^`]*)`/g, '$1')
        // 标题、引用、列表、分隔线（仅行首）
        .replace(/^\s{0,3}#{1,6}\s+/gm, '')
        .replace(/^\s{0,3}>\s?/gm, '')
        .replace(/^\s{0,3}[-*+]\s+/gm, '')
        .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
        .replace(/^\s{0,3}([-*_]\s*){3,}$/gm, '')
        // 图片与链接：保留可读文本
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        // 加粗/斜体/删除线/高亮
        .replace(/(\*{1,3}|_{1,3}|~~|==)([^*_~\n]+)\1/g, '$2')
        // 表格分隔行与单元格分隔符
        .replace(/^\s*\|?[-: |]+\|[-: |]*$/gm, '')
        .replace(/\|/g, ' ')
        // 压平多余空白并去掉行首尾空格；气泡内连续空行折叠为单行
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/^[ \t]+|[ \t]+$/gm, '')
        .replace(/\n{2,}/g, '\n')
        // HTML 标签兜底
        .replace(/<[^>]+>/g, '')
        .trim()
}

/** 回复气泡停留时长：比短台词更持久，随长度增长，封顶 18s */
export function replyBubbleDurationMs(text: string): number {
    const length = text.trim().length
    const duration = 6_000 + length * 90
    return Math.min(18_000, Math.max(6_000, duration))
}
