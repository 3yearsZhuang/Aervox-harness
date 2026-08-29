/**
 * Aervox｜思隅 @aervox/ui — 轻量安全 Markdown 渲染器
 *
 * 支持：
 * - 标题（# ~ ######）
 * - 代码块（```lang ... ```）与行内代码（`code`）
 * - 粗体（**bold**）、斜体（*italic*）、删除线（~~strike~~）
 * - 无序列表（- / *）与有序列表（1. ）
 * - 引用块（> quote）
 * - 链接（[text](url)）与图片（![alt](url)）
 * - 分割线（--- / ***）
 * - HTML 特殊字符转义与 XSS 防护
 */

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function sanitizeUrl(url: string): string {
  const trimmed = url.trim();
  if (/^(?:https?:\/\/|mailto:|#|\/)/i.test(trimmed)) {
    return trimmed;
  }
  return '#';
}

function parseInline(text: string): string {
  // 1. 行内代码
  const codeTokens: string[] = [];
  let out = text.replace(/`([^`]+)`/g, (_match, code: string) => {
    codeTokens.push(`<code>${escapeHtml(code)}</code>`);
    return `\x1a${codeTokens.length - 1}\x1a`;
  });

  // 2. 图片 ![alt](url)
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, url: string) => {
    return `<img src="${escapeHtml(sanitizeUrl(url))}" alt="${escapeHtml(alt)}" loading="lazy" class="md-image" />`;
  });

  // 3. 链接 [text](url)
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) => {
    const safeUrl = sanitizeUrl(url);
    const target = safeUrl.startsWith('http') ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${escapeHtml(safeUrl)}"${target} class="md-link">${escapeHtml(label)}</a>`;
  });

  // 4. 粗斜体 ***text*** / ___text___
  out = out.replace(/(\*\*\*|___)(.+?)\1/g, '<strong><em>$2</em></strong>');

  // 5. 粗体 **text** / __text__
  out = out.replace(/(\*\*|__)(.+?)\1/g, '<strong>$2</strong>');

  // 6. 斜体 *text* / _text_
  out = out.replace(/(\*|_)(.+?)\1/g, '<em>$2</em>');

  // 7. 删除线 ~~text~~
  out = out.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // 还原行内代码
  out = out.replace(/\x1a(\d+)\x1a/g, (_match, indexStr: string) => {
    const idx = Number(indexStr);
    return codeTokens[idx] ?? '';
  });

  return out;
}

export function renderMarkdown(markdown: string): string {
  if (!markdown) return '';

  const lines = markdown.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const htmlChunks: string[] = [];

  let inCodeBlock = false;
  let codeLang = '';
  let codeBuffer: string[] = [];

  let inList: 'ul' | 'ol' | null = null;
  let inBlockquote = false;
  let quoteBuffer: string[] = [];

  const flushList = () => {
    if (inList) {
      htmlChunks.push(`</${inList}>`);
      inList = null;
    }
  };

  const flushQuote = () => {
    if (inBlockquote) {
      const quoteHtml = renderMarkdown(quoteBuffer.join('\n'));
      htmlChunks.push(`<blockquote class="md-blockquote">${quoteHtml}</blockquote>`);
      inBlockquote = false;
      quoteBuffer = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // 代码块处理
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        // 结束代码块
        const codeContent = escapeHtml(codeBuffer.join('\n'));
        const langClass = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : '';
        htmlChunks.push(`<pre class="md-pre"><code${langClass}>${codeContent}</code></pre>`);
        inCodeBlock = false;
        codeBuffer = [];
        codeLang = '';
      } else {
        // 开始代码块
        flushList();
        flushQuote();
        inCodeBlock = true;
        codeLang = line.trim().slice(3).trim();
        codeBuffer = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    // 引用块处理
    if (line.trimStart().startsWith('>')) {
      flushList();
      inBlockquote = true;
      const content = line.trimStart().replace(/^>\s?/, '');
      quoteBuffer.push(content);
      continue;
    } else if (inBlockquote) {
      flushQuote();
    }

    // 分割线
    if (/^(?:[-*_]\s*){3,}$/.test(line.trim())) {
      flushList();
      htmlChunks.push('<hr class="md-hr" />');
      continue;
    }

    // 标题 # ~ ######
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch && headingMatch[1] && headingMatch[2]) {
      flushList();
      const level = headingMatch[1].length;
      const content = parseInline(escapeHtml(headingMatch[2]));
      htmlChunks.push(`<h${level} class="md-heading md-h${level}">${content}</h${level}>`);
      continue;
    }

    // 无序列表 (- / * / +)
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/);
    if (ulMatch && ulMatch[2]) {
      if (inList !== 'ul') {
        flushList();
        inList = 'ul';
        htmlChunks.push('<ul class="md-ul">');
      }
      const content = parseInline(escapeHtml(ulMatch[2]));
      htmlChunks.push(`<li>${content}</li>`);
      continue;
    }

    // 有序列表 (1. 2. )
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/);
    if (olMatch && olMatch[2]) {
      if (inList !== 'ol') {
        flushList();
        inList = 'ol';
        htmlChunks.push('<ol class="md-ol">');
      }
      const content = parseInline(escapeHtml(olMatch[2]));
      htmlChunks.push(`<li>${content}</li>`);
      continue;
    }

    // 非列表行
    flushList();

    // 空行
    if (!line.trim()) {
      continue;
    }

    // 普通段落
    const inline = parseInline(escapeHtml(line));
    htmlChunks.push(`<p class="md-p">${inline}</p>`);
  }

  // 循环结束收尾
  if (inCodeBlock) {
    const codeContent = escapeHtml(codeBuffer.join('\n'));
    const langClass = codeLang ? ` class="language-${escapeHtml(codeLang)}"` : '';
    htmlChunks.push(`<pre class="md-pre"><code${langClass}>${codeContent}</code></pre>`);
  }
  flushList();
  flushQuote();

  return htmlChunks.join('\n');
}
