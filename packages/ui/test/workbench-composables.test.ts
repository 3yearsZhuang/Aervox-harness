import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
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

  it('scrollStoryToBottom handles instant mode and rAF batching during streaming', async () => {
    const { useWorkbenchConversation } = await import('../src/composables/useWorkbenchConversation');
    const conv = useWorkbenchConversation({
      recordActivity: () => {},
    });

    let scrollToCalled = 0;
    const mockViewport = {
      scrollTop: 0,
      scrollHeight: 800,
      scrollTo: () => { scrollToCalled++; },
      querySelector: () => null,
    };
    conv.storyViewport.value = mockViewport as any;

    // instant 模式应使用 scrollTop 赋值，而不是 scrollTo({ behavior: 'smooth' })
    await conv.scrollStoryToBottom({ instant: true });
    // 等待微任务/定时器调度
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockViewport.scrollTop).toBe(800);
    expect(scrollToCalled).toBe(0);

    // 非 instant 模式应触发 scrollTo 平滑滚动
    await conv.scrollStoryToBottom();
    expect(scrollToCalled).toBe(1);
  });

  it('useWorkbenchCards dynamically merges cards from UIRegistry and defaults to core cards', async () => {
    const { useWorkbenchCards } = await import('../src/composables/useWorkbenchCards');
    const { createUIRegistry } = await import('../src/registry/ui-registry');
    const { registerFocusModePlugin } = await import('../src/plugins');
    const registry = createUIRegistry();

    const cards = useWorkbenchCards({
      activeQuestion: ref(null),
      timerRunning: ref(false),
      formattedTime: ref('25:00'),
      storyCount: ref(0),
      onOpenTool: vi.fn(),
      onStartQuiz: vi.fn(),
      onSubmitQuestionAnswers: vi.fn(),
      recordActivity: vi.fn(),
      registry,
    });

    // 1. Initially without plugin cards: only 4 core cards
    expect(cards.cardCatalog.value.map((c) => c.id)).toEqual(['todo', 'timer', 'history', 'diary']);

    // 2. When focus-mode registers cards into registry: cardCatalog reactively merges them
    const unregister = registerFocusModePlugin(registry);
    expect(cards.cardCatalog.value.map((c) => c.id)).toEqual(['study', 'mistake', 'quiz', 'todo', 'timer', 'history', 'diary']);

    // 3. Focus study card action is present
    const studyCard = cards.cardCatalog.value.find((c) => c.id === 'study');
    expect(studyCard?.extraComponent).toBeDefined();

    // 4. When focus-mode unregisters: returns back to core cards
    unregister();
    expect(cards.cardCatalog.value.map((c) => c.id)).toEqual(['todo', 'timer', 'history', 'diary']);
  });

  it('supports customizable quick tools with add, remove, reorder, reset and persistence', async () => {
    const storage: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: (k: string) => storage[k] ?? null,
      setItem: (k: string, v: string) => { storage[k] = v; },
      removeItem: (k: string) => { delete storage[k]; },
    };
    const origStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', { value: mockLocalStorage, configurable: true });

    try {
      const { useWorkbenchCards } = await import('../src/composables/useWorkbenchCards');
      const { createUIRegistry } = await import('../src/registry/ui-registry');
      const registry = createUIRegistry();

      const cards = useWorkbenchCards({
        activeQuestion: ref(null),
        timerRunning: ref(false),
        formattedTime: ref('25:00'),
        storyCount: ref(0),
        onOpenTool: vi.fn(),
        onStartQuiz: vi.fn(),
        onSubmitQuestionAnswers: vi.fn(),
        recordActivity: vi.fn(),
        registry,
      });

      // 1. Initially uncustomized
      expect(cards.customQuickToolIds.value).toBeNull();
      expect(cards.activeQuickCards.value.map((c) => c.id)).toEqual(['todo', 'timer', 'history', 'diary']);
      expect(cards.availableQuickCards.value).toEqual([]);

      // 2. Remove 'timer'
      cards.removeQuickTool('timer');
      expect(cards.activeQuickCards.value.map((c) => c.id)).toEqual(['todo', 'history', 'diary']);
      expect(cards.availableQuickCards.value.map((c) => c.id)).toEqual(['timer']);
      expect(JSON.parse(storage['aervox-quick-tools'] ?? '[]')).toEqual(['todo', 'history', 'diary']);

      // 3. Reorder: move 'history' up
      cards.moveQuickTool('history', 'up');
      expect(cards.activeQuickCards.value.map((c) => c.id)).toEqual(['history', 'todo', 'diary']);

      // 4. Reorder: boundary checks do nothing
      cards.moveQuickTool('history', 'up'); // already at top
      expect(cards.activeQuickCards.value.map((c) => c.id)).toEqual(['history', 'todo', 'diary']);

      // 5. Add 'timer' back
      cards.addQuickTool('timer');
      expect(cards.activeQuickCards.value.map((c) => c.id)).toEqual(['history', 'todo', 'diary', 'timer']);
      expect(cards.availableQuickCards.value).toEqual([]);

      // 6. Reset to default
      cards.resetQuickTools();
      expect(cards.customQuickToolIds.value).toBeNull();
      expect(cards.activeQuickCards.value.map((c) => c.id)).toEqual(['todo', 'timer', 'history', 'diary']);
      expect(storage['aervox-quick-tools']).toBeUndefined();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { value: origStorage, configurable: true });
    }
  });
});
