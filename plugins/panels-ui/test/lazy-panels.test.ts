import { describe, expect, it } from 'vitest';
import { settingsPanels } from '../src';

describe('settingsPanels 懒加载契约', () => {
  it('registers exactly the five built-in categories', () => {
    expect(settingsPanels.map((p) => p.category)).toEqual([
      'model', 'local-models', 'persona', 'voice', 'plugins',
    ]);
  });

  it('every panel is an async component so it stays out of the first bundle', () => {
    for (const panel of settingsPanels) {
      expect(
        (panel.component as { __asyncLoader?: unknown }).__asyncLoader,
        `panel ${panel.category} 必须是 defineAsyncComponent 异步组件`,
      ).toBeTypeOf('function');
    }
  });

  it('async loaders resolve to real panel components', async () => {
    for (const panel of settingsPanels) {
      const loader = (panel.component as unknown as { __asyncLoader: () => Promise<{ default?: unknown }> }).__asyncLoader;
      const mod = await loader();
      expect(mod).toBeTruthy();
    }
  });
});
