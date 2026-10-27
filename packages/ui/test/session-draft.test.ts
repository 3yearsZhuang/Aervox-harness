import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { useSessionDraft } from '../src/composables/session-draft';

const key = (id: string) => `aervox-mobile-draft:${encodeURIComponent(id)}`;
let values: Map<string, string>;
let store: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };
const bindings: ReturnType<typeof useSessionDraft>[] = [];
beforeEach(() => {
  values = new Map();
  store = {
    getItem: vi.fn((name: string) => values.get(name) ?? null),
    setItem: vi.fn((name: string, value: string) => { values.set(name, value); }),
    removeItem: vi.fn((name: string) => { values.delete(name); }),
  };
  vi.stubGlobal('localStorage', store);
});
afterEach(() => { for (const binding of bindings.splice(0)) binding.dispose(); vi.unstubAllGlobals(); });
function fixture(id = 'a', enabled = true) {
  const input = ref(''), sessionId = ref(id), active = ref(enabled), onRestore = vi.fn();
  const draft = useSessionDraft({ input, sessionId, enabled: active, onRestore });
  bindings.push(draft);
  return { input, sessionId, enabled: active, onRestore, ...draft };
}

describe('shared session draft ownership', () => {
  it('restores existing text without first clearing it and preserves encoded storage keys', () => {
    const id = '会话/a?';
    values.set(key(id), '  原始草稿  ');
    const draft = fixture(id);
    expect(draft.input.value).toBe('  原始草稿  ');
    expect(values.get(key(id))).toBe('  原始草稿  ');
    expect(draft.onRestore).toHaveBeenCalledOnce();
    expect(store.removeItem).not.toHaveBeenCalled();
  });

  it('saves the previous owner before a same-tick switch and never assigns its input to the new ID', () => {
    values.set(key('b'), '乙已有草稿');
    const draft = fixture();
    draft.input.value = '甲刚输入';
    draft.sessionId.value = 'b';
    expect(draft.input.value).toBe('乙已有草稿');
    expect(values.get(key('a'))).toBe('甲刚输入');
    draft.input.value = '乙修改';
    draft.sessionId.value = 'a';
    expect(draft.input.value).toBe('甲刚输入');
    expect(values.get(key('b'))).toBe('乙修改');
  });

  it('flushes the old enabled owner before disabling and does not write while disabled', () => {
    const draft = fixture();
    draft.input.value = '甲草稿';
    values.delete(key('a'));
    draft.enabled.value = false;
    expect(values.get(key('a'))).toBe('甲草稿');
    draft.sessionId.value = 'b';
    draft.input.value = '禁用期间的输入';
    expect(values.has(key('b'))).toBe(false);
    values.set(key('b'), '乙保存值');
    draft.enabled.value = true;
    expect(draft.input.value).toBe('乙保存值');
  });

  it('clears the visible text when selection becomes empty without moving the former draft', () => {
    const draft = fixture();
    draft.input.value = '甲保留';
    draft.sessionId.value = '';
    expect(draft.input.value).toBe('');
    draft.sessionId.value = 'b';
    expect(draft.input.value).toBe('');
    expect(values.get(key('a'))).toBe('甲保留');
    expect(values.has(key('b'))).toBe(false);
  });

  it('retains submitted text for a failed request and removes it after a successful retry clears the input', () => {
    const draft = fixture();
    draft.input.value = '待提交';
    draft.beginDraftSubmission('待提交');
    draft.input.value = '';
    expect(values.get(key('a'))).toBe('待提交');
    draft.restoreFailedDraft();
    expect(draft.input.value).toBe('待提交');
    draft.input.value = '';
    draft.completeDraftSubmission();
    expect(values.has(key('a'))).toBe(false);
  });

  it('keeps even an identical next draft when an old submission completes after leaving the session', () => {
    const draft = fixture();
    draft.beginDraftSubmission('同样的文本');
    draft.input.value = '同样的文本';
    draft.sessionId.value = 'b';
    draft.input.value = '乙草稿';
    draft.completeDraftSubmission('a');
    expect(values.get(key('a'))).toBe('同样的文本');
    expect(values.get(key('b'))).toBe('乙草稿');
    expect(draft.input.value).toBe('乙草稿');
    draft.sessionId.value = 'a';
    expect(draft.input.value).toBe('同样的文本');
  });

  it('clears only the untouched reserved input when the request is accepted', () => {
    const draft = fixture();
    draft.input.value = '  原文  ';
    draft.beginDraftSubmission('  原文  ');
    draft.acceptDraftSubmission();
    expect(draft.input.value).toBe('');
    expect(values.has(key('a'))).toBe(false);
  });

  it('preserves a newer draft edited back to the original text before acceptance', () => {
    const draft = fixture();
    draft.input.value = '原文';
    draft.beginDraftSubmission('原文');
    draft.input.value = '临时改写';
    draft.input.value = '原文';
    draft.acceptDraftSubmission();
    expect(draft.input.value).toBe('原文');
    expect(values.get(key('a'))).toBe('原文');
    draft.acceptDraftSubmission();
    expect(draft.input.value).toBe('原文');
  });

  it('accepts an inactive session without clearing the selected session or its draft', () => {
    const draft = fixture();
    draft.input.value = '甲提交';
    draft.beginDraftSubmission('甲提交');
    draft.sessionId.value = 'b';
    draft.input.value = '乙草稿';
    draft.acceptDraftSubmission('a');
    expect(values.has(key('a'))).toBe(false);
    expect(draft.input.value).toBe('乙草稿');
    expect(values.get(key('b'))).toBe('乙草稿');
  });

  it('does not resurrect submitted text after a newer draft was deliberately cleared', () => {
    const draft = fixture();
    draft.beginDraftSubmission('旧输入');
    draft.input.value = '较新草稿';
    draft.input.value = '';
    draft.restoreFailedDraft();
    expect(draft.input.value).toBe('');
    draft.sessionId.value = 'b';
    draft.completeDraftSubmission('a');
    expect(values.has(key('a'))).toBe(false);
  });

  it('owns pending receipts per session and protects both sessions from late completions', () => {
    const draft = fixture();
    draft.beginDraftSubmission('甲提交');
    draft.input.value = '甲下一条';
    draft.sessionId.value = 'b';
    draft.beginDraftSubmission('乙提交');
    draft.input.value = '乙下一条';
    draft.completeDraftSubmission('a');
    draft.completeDraftSubmission('b');
    expect(values.get(key('a'))).toBe('甲下一条');
    expect(values.get(key('b'))).toBe('乙下一条');
  });

  it('does not erase a replacement stored value or a newer draft on duplicate completion', () => {
    const draft = fixture();
    draft.beginDraftSubmission('提交');
    draft.input.value = '';
    values.set(key('a'), '外部较新草稿');
    draft.completeDraftSubmission();
    expect(values.get(key('a'))).toBe('外部较新草稿');
    draft.input.value = '本地下一条';
    draft.completeDraftSubmission();
    expect(values.get(key('a'))).toBe('本地下一条');
  });

  it('flushes explicitly without a Vue scope and detaches watchers and late callbacks on disposal', () => {
    const draft = fixture();
    draft.input.value = '离开前草稿';
    values.delete(key('a'));
    draft.dispose();
    expect(values.get(key('a'))).toBe('离开前草稿');
    draft.input.value = '卸载后陈旧回调';
    draft.sessionId.value = 'b';
    draft.completeDraftSubmission('a');
    expect(values.get(key('a'))).toBe('离开前草稿');
    expect(values.has(key('b'))).toBe(false);
  });

  it('flushes and detaches automatically with its Vue scope', () => {
    const scope = effectScope();
    const draft = scope.run(() => fixture())!;
    draft.input.value = '组件卸载前';
    values.delete(key('a'));
    scope.stop();
    expect(values.get(key('a'))).toBe('组件卸载前');
    draft.input.value = '已销毁';
    expect(values.get(key('a'))).toBe('组件卸载前');
  });

  it('keeps typing and failure restoration usable when storage rejects writes', () => {
    const draft = fixture();
    store.setItem.mockImplementation(() => { throw new Error('quota'); });
    expect(() => { draft.input.value = '仍可输入'; draft.beginDraftSubmission('仍可输入'); draft.input.value = ''; draft.restoreFailedDraft(); }).not.toThrow();
    expect(draft.input.value).toBe('仍可输入');
  });
});

describe('explicit unsubmitted draft transfer', () => {
  it('copies the exact draft to a newly selected empty session before clearing its source', () => {
    const draft = fixture('web_default');
    draft.input.value = '  待发文本  ';
    draft.sessionId.value = 'created';
    expect(draft.transferUnsubmittedDraft('web_default', 'created', '  待发文本  ')).toBe(true);
    expect(values.has(key('web_default'))).toBe(false);
    expect(values.get(key('created'))).toBe('  待发文本  ');
    expect(draft.input.value).toBe('  待发文本  ');
  });

  it('does not write the moved text back to its former owner on the next switch', () => {
    const draft = fixture('web_default');
    draft.input.value = '精确文本';
    expect(draft.transferUnsubmittedDraft('web_default', 'created', '精确文本')).toBe(true);
    expect(draft.input.value).toBe('');
    draft.sessionId.value = 'created';
    expect(values.has(key('web_default'))).toBe(false);
    expect(draft.input.value).toBe('精确文本');
  });

  it('refuses stale source text, different destination text and any pending submission', () => {
    const draft = fixture('source');
    draft.input.value = '新文本';
    expect(draft.transferUnsubmittedDraft('source', 'target', '旧文本')).toBe(false);
    values.set(key('target'), '目标已有草稿');
    expect(draft.transferUnsubmittedDraft('source', 'target', '新文本')).toBe(false);
    values.delete(key('target'));
    draft.beginDraftSubmission('新文本');
    expect(draft.transferUnsubmittedDraft('source', 'target', '新文本')).toBe(false);
    expect(values.get(key('source'))).toBe('新文本');
  });

  it('leaves its source intact when destination persistence fails', () => {
    const draft = fixture('source');
    draft.input.value = '保留源';
    store.setItem.mockImplementation(() => { throw new Error('quota'); });
    expect(draft.transferUnsubmittedDraft('source', 'target', '保留源')).toBe(false);
    expect(values.get(key('source'))).toBe('保留源');
    expect(store.removeItem).not.toHaveBeenCalled();
  });

  it('does not clear a newer visible source draft whose storage write failed', () => {
    const draft = fixture('source');
    draft.input.value = '已保存文本';
    store.setItem.mockImplementationOnce(() => { throw new Error('quota'); });
    draft.input.value = '更新但未保存的输入';
    expect(draft.transferUnsubmittedDraft('source', 'target', '已保存文本')).toBe(false);
    expect(draft.input.value).toBe('更新但未保存的输入');
    expect(values.get(key('source'))).toBe('已保存文本');
  });

  it('does not clear a source replaced while destination persistence is being confirmed', () => {
    const draft = fixture('source');
    draft.input.value = '旧文本';
    store.setItem.mockImplementation((name: string, value: string) => {
      values.set(name, value);
      if (name === key('target')) values.set(key('source'), '更晚的输入');
    });
    expect(draft.transferUnsubmittedDraft('source', 'target', '旧文本')).toBe(false);
    expect(values.get(key('source'))).toBe('更晚的输入');
  });

  it('keeps a safe duplicate if source cleanup is rejected after the destination is saved', () => {
    const draft = fixture('source');
    draft.input.value = '保留副本';
    store.removeItem.mockImplementation(() => { throw new Error('blocked'); });
    expect(draft.transferUnsubmittedDraft('source', 'target', '保留副本')).toBe(false);
    expect(values.get(key('source'))).toBe('保留副本');
    expect(values.get(key('target'))).toBe('保留副本');
  });
});
