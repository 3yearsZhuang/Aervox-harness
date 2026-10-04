import { describe, expect, it, vi } from 'vitest';
import { resolveStartupQuiet, runStartupDiary } from '../src/composables/workbench-startup';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    has: (key: string) => map.has(key),
  };
}

describe('resolveStartupQuiet（CR-060：插件诉求必须在同步完成后读取）', () => {
  it('读取发生在插件同步之后，因此插件在 setup 期间写入的诉求可被观察到', async () => {
    let quiet = false;
    // 模拟插件在 setup() 阶段表达诉求（异步同步流程内）
    const pluginStartup = (async () => {
      await Promise.resolve();
      quiet = true;
    })();

    // 若宿主反过来先读再 await，这里会是 false —— 该断言即顺序回归守卫
    await expect(resolveStartupQuiet(pluginStartup, () => quiet)).resolves.toBe(true);
  });

  it('插件同步失败不阻断宿主，也不误判为已诉求', async () => {
    const failing = Promise.reject(new Error('offline'));
    await expect(resolveStartupQuiet(failing, () => false)).resolves.toBe(false);
  });
});

describe('runStartupDiary（CR-060：尊重插件启动期静默诉求）', () => {
  it('插件已诉求启动期静默时不生成日记，也不写标记（下一轮仍可生成）', async () => {
    const storage = memoryStorage();
    const generateToday = vi.fn(async () => ({ content: '今日日记' }));
    const applyGenerated = vi.fn();

    const outcome = await runStartupDiary({
      quietStartup: true,
      markerKey: 'marker',
      storage,
      generateToday,
      applyGenerated,
    });

    expect(outcome).toBe('skipped-quiet-startup');
    expect(generateToday).not.toHaveBeenCalled();
    expect(applyGenerated).not.toHaveBeenCalled();
    expect(storage.has('marker')).toBe(false);
  });

  it('未诉求静默时生成并落位，写入首开标记', async () => {
    const storage = memoryStorage();
    const applyGenerated = vi.fn();

    const outcome = await runStartupDiary({
      quietStartup: false,
      markerKey: 'marker',
      storage,
      generateToday: async () => ({ content: '今日日记' }),
      applyGenerated,
    });

    expect(outcome).toBe('generated');
    expect(applyGenerated).toHaveBeenCalledWith({ content: '今日日记' });
    expect(storage.has('marker')).toBe(true);
  });

  it('已有首开标记时不再重复生成', async () => {
    const storage = memoryStorage({ marker: '1' });
    const generateToday = vi.fn(async () => ({ content: '今日日记' }));

    const outcome = await runStartupDiary({
      quietStartup: false,
      markerKey: 'marker',
      storage,
      generateToday,
      applyGenerated: vi.fn(),
    });

    expect(outcome).toBe('skipped-already-generated');
    expect(generateToday).not.toHaveBeenCalled();
  });

  it('生成失败时不写标记，允许下一轮重试', async () => {
    const storage = memoryStorage();

    const outcome = await runStartupDiary({
      quietStartup: false,
      markerKey: 'marker',
      storage,
      generateToday: async () => {
        throw new Error('network');
      },
      applyGenerated: vi.fn(),
    });

    expect(outcome).toBe('failed');
    expect(storage.has('marker')).toBe(false);
  });
});
