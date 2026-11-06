import { afterEach, expect, it, vi } from 'vitest';
import { effectScope, nextTick, ref } from 'vue';
import { configureAervoxClient } from '@aervox/api-client';
import { useWorkbenchComposer } from '../src/composables/useWorkbenchComposer';

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

it('refuses attachment submission before upload while preserving selected files and the text draft', async () => {
  const uploadAttachment = vi.fn();
  configureAervoxClient({ transport: { request: vi.fn(), streamTurn: vi.fn(), uploadAttachment } });
  const scope = effectScope();
  const composer = scope.run(() => useWorkbenchComposer({ onSendMessage: vi.fn(), streaming: ref(false), fullAccessDialogOpen: ref(false),
    draftSessionId: ref('session'), draftsEnabled: ref(true) }))!;
  try {
    const file = new File(['unverified'], 'paper.txt', { type: 'text/plain' });
    composer.input.value = '保留这段文字';
    composer.pendingAttachments.value.push({ key: 'paper', file, name: file.name, mediaType: file.type, size: file.size });
    await nextTick();
    await expect(composer.uploadPendingAttachments()).rejects.toThrow('附件扫描尚未就绪');
    expect(uploadAttachment).not.toHaveBeenCalled();
    expect(composer.attachmentError.value).toContain('请移除附件后发送文字');
    expect(composer.pendingAttachments.value).toHaveLength(1);
    expect(composer.input.value).toBe('保留这段文字');
    expect(localStorage.getItem('aervox-mobile-draft:session')).toBe('保留这段文字');
    composer.removePendingAttachment('paper');
    expect(await composer.uploadPendingAttachments()).toEqual([]);
    expect(composer.input.value).toBe('保留这段文字');
  } finally { scope.stop(); }
});
