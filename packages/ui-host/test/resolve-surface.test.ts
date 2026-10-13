import { describe, expect, it } from 'vitest';
import { resolveSurfaceChoice } from '../src/resolve-surface';

const surfaces = [
  { id: 'workbench-ui' },
  { id: 'workbench-compact-ui' },
] as const;

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    map,
  };
}

describe('resolveSurfaceChoice', () => {
  it('falls back to the first surface without any stored choice', () => {
    expect(resolveSurfaceChoice(surfaces, memoryStorage(), { storageKey: 'k' }).id).toBe('workbench-ui');
  });

  it('honors a stored choice', () => {
    const storage = memoryStorage({ k: 'workbench-compact-ui' });
    expect(resolveSurfaceChoice(surfaces, storage, { storageKey: 'k' }).id).toBe('workbench-compact-ui');
  });

  it('query value wins and persists into storage', () => {
    const storage = memoryStorage({ k: 'workbench-ui' });
    const picked = resolveSurfaceChoice(surfaces, storage, { storageKey: 'k', queryValue: 'workbench-compact-ui' });
    expect(picked.id).toBe('workbench-compact-ui');
    expect(storage.map.get('k')).toBe('workbench-compact-ui');
  });

  it('silently falls back when the stored id is unknown', () => {
    const storage = memoryStorage({ k: 'removed-surface' });
    expect(resolveSurfaceChoice(surfaces, storage, { storageKey: 'k' }).id).toBe('workbench-ui');
  });

  it('requires at least one surface', () => {
    expect(() => resolveSurfaceChoice([], undefined, { storageKey: 'k' })).toThrow(/at least one surface/);
  });
});
