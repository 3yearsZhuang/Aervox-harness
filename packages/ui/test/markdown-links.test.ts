import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/utils/markdown.js';

function renderedLink(url: string, label = 'link'): HTMLAnchorElement {
  const container = document.createElement('div');
  container.innerHTML = renderMarkdown(`[${label}](${url})`);
  const link = container.querySelector('a');
  expect(link).not.toBeNull();
  return link!;
}

describe('Markdown navigation boundaries', () => {
  it.each([
    'https://example.test/path',
    'http://example.test/path',
    'HTTP://example.test/path',
    'hTtPs://example.test/path',
    '//example.test/path',
    '  HTTPS://example.test/path  ',
  ])('opens external link %s in a separate window without an opener', url => {
    const link = renderedLink(url);
    expect(link.getAttribute('href')).toBe(url.trim());
    expect(link.target).toBe('_blank');
    expect(link.relList.contains('noopener')).toBe(true);
    expect(link.relList.contains('noreferrer')).toBe(true);
  });

  it.each(['/local/path', '#section', 'mailto:owner@example.test'])('preserves local or mail link %s', url => {
    const link = renderedLink(url);
    expect(link.getAttribute('href')).toBe(url);
    expect(link.hasAttribute('target')).toBe(false);
    expect(link.hasAttribute('rel')).toBe(false);
  });

  it.each(['javascript:alert', 'data:text/html,attack', 'file:///tmp/attack.html', 'relative/path'])('rejects unsupported URL %s', url => {
    const link = renderedLink(url);
    expect(link.getAttribute('href')).toBe('#');
    expect(link.hasAttribute('target')).toBe(false);
  });

  it('keeps external URLs and labels escaped without creating event attributes or elements', () => {
    const link = renderedLink('HTTP://example.test/" onclick="attack', '<img src=x onerror=attack>');
    expect(link.target).toBe('_blank');
    expect(link.hasAttribute('onclick')).toBe(false);
    expect(link.querySelector('img')).toBeNull();
    expect(link.attributes.length).toBe(4);
  });
});
