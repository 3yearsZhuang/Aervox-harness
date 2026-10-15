import { describe, expect, it } from 'vitest';
import {
  COMPANION_DEFAULT_NAME,
  readCompanionIdentity,
  saveCompanionIdentity,
  SPACE_NAME,
} from '../src/utils/companion-identity';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    map,
  };
}

describe('companion identity（ADR-027 命名分层）', () => {
  it('defaults to 小隅 / 你 with no stored settings', () => {
    expect(readCompanionIdentity(memoryStorage())).toEqual({ companionName: '小隅', userAddress: '你' });
    expect(COMPANION_DEFAULT_NAME).toBe('小隅');
    expect(SPACE_NAME).toBe('思隅');
  });

  it('migrates a custom legacy assistantName into companionName', () => {
    const storage = memoryStorage({ 'aervox-settings': JSON.stringify({ assistantName: '团子' }) });
    expect(readCompanionIdentity(storage).companionName).toBe('团子');
  });

  it('corrects the early mistake: legacy value 思隅 falls back to 小隅', () => {
    const storage = memoryStorage({ 'aervox-settings': JSON.stringify({ assistantName: '思隅' }) });
    expect(readCompanionIdentity(storage).companionName).toBe('小隅');
  });

  it('saves both names and drops the legacy field', () => {
    const storage = memoryStorage({ 'aervox-settings': JSON.stringify({ assistantName: '旧名', theme: 'dark' }) });
    const next = saveCompanionIdentity({ companionName: '阿雾', userAddress: '阿庄' }, storage);
    expect(next).toEqual({ companionName: '阿雾', userAddress: '阿庄' });
    const stored = JSON.parse(storage.map.get('aervox-settings')!);
    expect(stored.assistantName).toBeUndefined();
    expect(stored.theme).toBe('dark');
    expect(stored.companionName).toBe('阿雾');
    expect(stored.userAddress).toBe('阿庄');
  });

  it('ignores empty patches and keeps current values', () => {
    const storage = memoryStorage({ 'aervox-settings': JSON.stringify({ companionName: '团子', userAddress: '掌柜' }) });
    const next = saveCompanionIdentity({ companionName: '  ' }, storage);
    expect(next).toEqual({ companionName: '团子', userAddress: '掌柜' });
  });
});
