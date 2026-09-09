import { describe, expect, it } from 'vitest';
import { splitIntoSentences } from '../src/composables/useWorkbenchConversation';
import { resolveMediaType, formatAttachmentSize } from '../src/composables/useWorkbenchComposer';
import { DIAL_RADIUS, DIAL_CIRCUMFERENCE } from '../src/composables/useWorkbenchTimer';

describe('Workbench Composables Logic', () => {
  it('splits text into visual novel sentences properly', () => {
    const text = '你好！ 这是第一句。 这是第二句？ 没错！';
    const sentences = splitIntoSentences(text);
    expect(sentences).toEqual(['你好！', '这是第一句。', '这是第二句？', '没错！']);
  });

  it('formats attachment size cleanly', () => {
    expect(formatAttachmentSize(500)).toBe('500 B');
    expect(formatAttachmentSize(2048)).toBe('2 KB');
    expect(formatAttachmentSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('resolves supported media types correctly', () => {
    const pngFile = new File([''], 'test.png', { type: 'image/png' });
    expect(resolveMediaType(pngFile)).toBe('image/png');

    const pdfFile = new File([''], 'doc.pdf', { type: 'application/pdf' });
    expect(resolveMediaType(pdfFile)).toBe('application/pdf');

    const unknownFile = new File([''], 'file.xyz', { type: '' });
    expect(resolveMediaType(unknownFile)).toBeNull();
  });

  it('has consistent timer geometry constants', () => {
    expect(DIAL_RADIUS).toBe(80);
    expect(DIAL_CIRCUMFERENCE).toBeCloseTo(2 * Math.PI * 80, 4);
  });
});
