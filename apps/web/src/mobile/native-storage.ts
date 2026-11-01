import { nativeRequest } from './native-channel';
import { readonly, ref } from 'vue';

const cache = new Map<string, string>();
let hydrated = false;
let scheduled = false;
let revision = 0;
let rejectedEdits = 0;
const failure = ref(false);
export const nativeStorageFailed = readonly(failure);
const allowed = (key: string) => key === 'aervox_active_session_id' || /^aervox-mobile-draft:[A-Za-z0-9_%.'!~*()-]{1,512}$/.test(key);
function snapshot() { return Object.fromEntries(cache); }
async function flush() {
  scheduled = true;
  let attemptedRevision = revision;
  try {
    while (true) {
      const version = attemptedRevision = revision;
      const rejectedBeforeWrite = rejectedEdits;
      const values = snapshot();
      const response = await nativeRequest({ op: 'preferences', operation: 'write', values });
      if (response?.kind !== 'preferences' || !response.values || typeof response.values !== 'object' || Array.isArray(response.values)
        || Object.keys(response.values).length !== Object.keys(values).length
        || Object.entries(values).some(([key, value]) => response.values[key] !== value)) throw new Error('INVALID_UI_PREFERENCE_RECEIPT');
      if (rejectedBeforeWrite === rejectedEdits) failure.value = false;
      if (version === revision) return;
    }
  } catch { failure.value = true; }
  finally {
    scheduled = false;
    // A newer edit owns a new snapshot even when the preceding receipt failed.
    // Never replay the same unknown write or overwrite the newer cache from it.
    if (attemptedRevision !== revision) void flush();
  }
}
function changed() { revision++; if (!scheduled) void flush(); }
/** Hydrated before mounting. SQLite remains the conversation authority; this
 * native cache holds only UI selection and unsubmitted text drafts. */
export const nativeStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = {
  getItem(key) { return cache.get(key) ?? null; },
  setItem(key, value) {
    if (!hydrated || !allowed(key) || typeof value !== 'string') throw new Error('INVALID_UI_PREFERENCE');
    if (new TextEncoder().encode(value).byteLength > 32_768) { rejectedEdits++; failure.value = true; throw new Error('INVALID_UI_PREFERENCE'); }
    const old = cache.get(key);
    cache.set(key, value);
    if (cache.size > 64 || new TextEncoder().encode(JSON.stringify(snapshot())).byteLength > 256 * 1024) {
      if (old === undefined) cache.delete(key); else cache.set(key, old);
      rejectedEdits++; failure.value = true;
      throw new Error('DRAFT_STORAGE_FULL');
    }
    changed();
  },
  removeItem(key) { if (cache.delete(key)) changed(); },
};
export async function hydrateNativeStorage() {
  const response = await nativeRequest({ op: 'preferences', operation: 'read' });
  if (response.kind !== 'preferences' || !response.values || typeof response.values !== 'object' || Array.isArray(response.values)) throw new Error('INVALID_UI_PREFERENCES');
  const entries = Object.entries(response.values);
  if (entries.length > 64 || new TextEncoder().encode(JSON.stringify(response.values)).byteLength > 256 * 1024
    || entries.some(([key, value]) => !allowed(key) || typeof value !== 'string' || new TextEncoder().encode(value).byteLength > 32_768)) throw new Error('INVALID_UI_PREFERENCES');
  cache.clear(); entries.forEach(([key, value]) => cache.set(key, value as string)); hydrated = true;
}
export function draftStorageFailure() { return failure.value ? new Error('DRAFT_SAVE_FAILED') : undefined; }
