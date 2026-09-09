import { describe, expect, it } from 'vitest';
import { clearMarkdownCache, renderMarkdown } from '../src/utils/markdown.js';

describe('renderMarkdown caching & performance', () => {
  it('correctly renders markdown and caches results', () => {
    clearMarkdownCache();
    const md = '## 性能优化\n\n这是一段**加粗**文本，包含`代码`与[链接](https://example.com)。';
    const firstRender = renderMarkdown(md);
    expect(firstRender).toContain('<h2 class="md-heading md-h2">性能优化</h2>');
    expect(firstRender).toContain('<strong>加粗</strong>');
    expect(firstRender).toContain('<code>代码</code>');
    expect(firstRender).toContain('<a href="https://example.com" target="_blank" rel="noopener noreferrer" class="md-link">链接</a>');

    // Second render should return identical cached result immediately
    const secondRender = renderMarkdown(md);
    expect(secondRender).toBe(firstRender);
  });

  it('handles empty strings without caching overhead', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('evicts oldest entries when exceeding max cache limit', () => {
    clearMarkdownCache();
    for (let i = 0; i < 505; i++) {
      renderMarkdown(`Markdown test text number ${i}`);
    }
    expect(renderMarkdown('Markdown test text number 504')).toContain('<p class="md-p">Markdown test text number 504</p>');
  });
});
