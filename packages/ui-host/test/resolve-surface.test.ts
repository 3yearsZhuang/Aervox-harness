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

  it('uses the configured default without storing it as an explicit choice', () => {
    const storage = memoryStorage();
    expect(resolveSurfaceChoice(surfaces, storage, {
      storageKey: 'k', defaultSurfaceId: 'workbench-compact-ui',
    }).id).toBe('workbench-compact-ui');
    expect(storage.map.has('k')).toBe(false);
  });

  it('keeps an explicit stored or URL choice ahead of the configured default', () => {
    const storage = memoryStorage({ k: 'workbench-ui' });
    expect(resolveSurfaceChoice(surfaces, storage, {
      storageKey: 'k', defaultSurfaceId: 'workbench-compact-ui',
    }).id).toBe('workbench-ui');
    expect(resolveSurfaceChoice(surfaces, storage, {
      storageKey: 'k', defaultSurfaceId: 'workbench-ui', queryValue: 'workbench-compact-ui',
    }).id).toBe('workbench-compact-ui');
  });

  it('uses the configured default for a removed surface and the first trusted entry for an unknown default', () => {
    const storage = memoryStorage({ k: 'removed-surface' });
    expect(resolveSurfaceChoice(surfaces, storage, {
      storageKey: 'k', defaultSurfaceId: 'workbench-compact-ui',
    }).id).toBe('workbench-compact-ui');
    expect(resolveSurfaceChoice(surfaces, storage, {
      storageKey: 'k', defaultSurfaceId: 'removed-default',
    }).id).toBe('workbench-ui');
  });

  it('keeps URL selection and defaults available when storage throws', () => {
    const storage = {
      getItem: () => { throw new Error('storage unavailable'); },
      setItem: () => { throw new Error('storage unavailable'); },
    };
    expect(resolveSurfaceChoice(surfaces, storage, {
      storageKey: 'k', defaultSurfaceId: 'workbench-compact-ui',
    }).id).toBe('workbench-compact-ui');
    expect(resolveSurfaceChoice(surfaces, storage, {
      storageKey: 'k', defaultSurfaceId: 'workbench-compact-ui', queryValue: 'workbench-ui',
    }).id).toBe('workbench-ui');
  });

  it('requires at least one surface', () => {
    expect(() => resolveSurfaceChoice([], undefined, { storageKey: 'k' })).toThrow(/at least one surface/);
  });
});

it('navigates only through the injected trusted catalog and preserves other URL state', async () => {
  const {createSurfaceNavigation} = await import('../src/resolve-surface');
  const storage = memoryStorage();
  const urls: string[] = [];
  const navigation = createSurfaceNavigation([{id: 'new-view', displayName: 'New view'}, {id: 'default-view'}], {
    currentSurfaceId: 'new-view', defaultSurfaceId: 'default-view', storageKey: 'choice', storage,
    location: {href: 'https://example.test/app?x=1#anchor', replace: url => {urls.push(url);}},
  });
  expect(navigation.options).toEqual([{value: 'new-view', label: 'New view'}, {value: 'default-view', label: 'default-view'}]);
  navigation.select('new-view');
  expect(storage.getItem('choice')).toBe('new-view');
  expect(urls[0]).toBe('https://example.test/app?x=1&surface=new-view#anchor');
  navigation.openDefault();
  expect(storage.getItem('choice')).toBe('default-view');
  expect(() => navigation.select('removed-view')).toThrow('not registered');
  expect(urls).toHaveLength(2);
});
