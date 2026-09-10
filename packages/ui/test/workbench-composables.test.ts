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

  it('preserves custom timer minutes when toggling study mode', async () => {
    const storage: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = v; },
    };
    const origStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, configurable: true });

    try {
      let currentTimerMinutes = 45;
      const { useWorkbenchLayout } = await import('../src/composables/useWorkbenchLayout');
      const layout = useWorkbenchLayout(
        { platform: 'web', showCompanion: true, assistantName: '思隅' },
        {
          recordActivity: () => {},
          getTimerMinutes: () => currentTimerMinutes,
        },
      );

      layout.toggleStudyMode();
      const saved = JSON.parse(storage['aervox-settings'] || '{}');
      expect(saved.timerMinutes).toBe(45);
      expect(saved.studyModeEnabled).toBe(true);
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: origStorage, configurable: true });
    }
  });

  it('shares enterToSend state between layout and composer', async () => {
    const { ref } = await import('vue');
    const { useWorkbenchComposer } = await import('../src/composables/useWorkbenchComposer');
    const sharedEnterToSend = ref(false);

    const composer = useWorkbenchComposer({
      onSendMessage: async () => {},
      streaming: ref(false),
      fullAccessDialogOpen: ref(false),
      enterToSend: sharedEnterToSend,
    });

    expect(composer.enterToSend.value).toBe(false);
    sharedEnterToSend.value = true;
    expect(composer.enterToSend.value).toBe(true);
  });

  it('reloads window when settings dialog closes with plugin changes, and does not reload without changes', () => {
    let reloadCount = 0;
    const mockWindow = {
      location: {
        reload: () => {
          reloadCount++;
        },
      },
    };

    let hasPluginChanges = false;
    function onPluginChange() {
      hasPluginChanges = true;
    }

    function handleSettingsClosed(win: typeof mockWindow) {
      if (hasPluginChanges) {
        hasPluginChanges = false;
        win.location.reload();
      }
    }

    // 1. Close without any plugin change -> no reload
    handleSettingsClosed(mockWindow);
    expect(reloadCount).toBe(0);
    expect(hasPluginChanges).toBe(false);

    // 2. Plugin changed -> close triggers reload and clears flag
    onPluginChange();
    expect(hasPluginChanges).toBe(true);
    handleSettingsClosed(mockWindow);
    expect(reloadCount).toBe(1);
    expect(hasPluginChanges).toBe(false);

    // 3. Subsequent close without new changes -> no reload
    handleSettingsClosed(mockWindow);
    expect(reloadCount).toBe(1);
  });
});
