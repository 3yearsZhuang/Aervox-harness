import { describe, expect, it } from 'vitest'
import { replyBubbleDurationMs, stripMarkdownForBubble } from '../src/renderer/src/quick-chat.js'

describe('stripMarkdownForBubble', () => {
  it('空文本返回空串', () => {
    expect(stripMarkdownForBubble('')).toBe('')
    expect(stripMarkdownForBubble('   ')).toBe('')
  })

  it('清理标题、加粗、斜体与列表标记', () => {
    expect(stripMarkdownForBubble('### 学习建议\n- **专注** 25 分钟\n- *复盘* 错题')).toBe(
      '学习建议\n专注 25 分钟\n复盘 错题',
    )
  })

  it('链接与图片保留可读文本', () => {
    expect(stripMarkdownForBubble('看[这里](https://example.com)和![图](a.png)')).toBe('看这里和图')
  })

  it('围栏代码块整段移除、行内代码保留内容', () => {
    expect(stripMarkdownForBubble('答案如下\n```js\nconst a = 1\n```\n用 `let` 声明')).toBe('答案如下\n用 let 声明')
  })

  it('表格分隔行与竖线被压平', () => {
    expect(stripMarkdownForBubble('| 项目 | 值 |\n| --- | --- |\n| 睡眠 | 8h |')).toBe('项目 值\n睡眠 8h')
  })

  it('纯文本原样透传（仅去首尾空白）', () => {
    expect(stripMarkdownForBubble('  嗨～我在这儿哦  ')).toBe('嗨～我在这儿哦')
  })
})

describe('replyBubbleDurationMs', () => {
  it('短回复为基础时长加少量加成', () => {
    expect(replyBubbleDurationMs('好')).toBe(6_000 + 90)
  })

  it('随长度线性增长', () => {
    const short = replyBubbleDurationMs('a'.repeat(20))
    const long = replyBubbleDurationMs('a'.repeat(60))
    expect(long).toBeGreaterThan(short)
    expect(short).toBe(6_000 + 20 * 90)
  })

  it('超长回复封顶 18 秒', () => {
    expect(replyBubbleDurationMs('a'.repeat(500))).toBe(18_000)
  })

  it('空白不计入长度', () => {
    expect(replyBubbleDurationMs('   ')).toBe(6_000)
  })
})
