import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDataDirectory } from '../src/data-directory.js';
import { defaultP2PIdentityPath, resolveIdentityPath, loadOrCreateDeviceIdentity } from '@aervox/sync-runtime/pairing';

describe('shared data directory and legacy P2P identity', () => {
  it('resolves repository data from the shared src/dist module depth', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    expect(defaultDataDirectory()).toBe(path.join(root, 'data'));
    expect(defaultP2PIdentityPath()).toBe(path.join(root, 'data/p2p-device-identity.json'));
  });

  it('reuses legacy identity without copying, overwriting or generating another device', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aervox-identity-'));
    try {
      const options = { root, env: {} };
      const canonical = path.join(root, 'data/p2p-device-identity.json');
      const legacy = path.join(root, 'packages/data/p2p-device-identity.json');
      expect(resolveIdentityPath(undefined, options)).toBe(canonical);
      const identity = await loadOrCreateDeviceIdentity({ path: legacy, deviceName: 'existing' });
      expect(resolveIdentityPath(undefined, options)).toBe(legacy);
      expect(await loadOrCreateDeviceIdentity({ path: resolveIdentityPath(undefined, options) })).toEqual(identity);
      expect(fs.existsSync(canonical)).toBe(false);
      expect(fs.statSync(legacy).mode & 0o777).toBe(0o600);
      fs.mkdirSync(path.dirname(canonical), { recursive: true });
      fs.writeFileSync(canonical, '{}');
      expect(() => resolveIdentityPath(undefined, options)).toThrow(/Multiple P2P identity/);
      expect(resolveIdentityPath(legacy, options)).toBe(legacy);
      expect(resolveIdentityPath(undefined, { root, env: { AERVOX_P2P_IDENTITY_PATH: legacy } })).toBe(legacy);
      expect(fs.readFileSync(legacy, 'utf8')).toContain(identity.deviceId);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
