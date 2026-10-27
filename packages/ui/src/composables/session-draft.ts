import { getCurrentScope, onScopeDispose, watch, type Ref } from 'vue';

const MOBILE_DRAFT_STORAGE_PREFIX = 'aervox-mobile-draft:';
const keyFor = (sessionId: string) => `${MOBILE_DRAFT_STORAGE_PREFIX}${encodeURIComponent(sessionId)}`;
type Submission = { text: string; hasNewerDraft: boolean };

/** Shared text-draft ownership; callers serialize submissions within a session. */
export function useSessionDraft(options: {
  input: Ref<string>;
  sessionId: Ref<string>;
  enabled: Ref<boolean>;
  onRestore?: () => void;
}) {
  const pending = new Map<string, Submission>();
  let ownerId = options.sessionId.value;
  let ownerEnabled = options.enabled.value;
  let initialized = false;
  let restoring = false;
  let disposed = false;

  function storage(): Storage | undefined {
    try { return typeof localStorage === 'undefined' ? undefined : localStorage; }
    catch { return undefined; }
  }

  function persist(text: string, sessionId: string, enabled: boolean) {
    if (!enabled || !sessionId) return;
    try {
      const target = storage();
      if (text.trim()) target?.setItem(keyFor(sessionId), text);
      else if (!pending.has(sessionId) || pending.get(sessionId)!.hasNewerDraft) target?.removeItem(keyFor(sessionId));
    } catch {
      // Storage failure must not block typing or sending.
    }
  }

  function restore(sessionId: string) {
    restoring = true;
    try { options.input.value = storage()?.getItem(keyFor(sessionId)) ?? ''; }
    catch { options.input.value = ''; }
    finally { restoring = false; }
    if (options.input.value.trim()) options.onRestore?.();
  }

  // Synchronous ownership matters: a same-tick switch must save the old text
  // before restoring the new session, and must never write it under the new ID.
  const stopSelection = watch([options.sessionId, options.enabled], ([sessionId, enabled]) => {
    if (initialized) persist(options.input.value, ownerId, ownerEnabled);
    ownerId = sessionId;
    ownerEnabled = enabled;
    initialized = true;
    if (enabled && sessionId) restore(sessionId);
    else if (enabled) {
      restoring = true;
      try { options.input.value = ''; }
      finally { restoring = false; }
    }
  }, { immediate: true, flush: 'sync' });
  const stopInput = watch(options.input, text => {
    if (disposed || restoring || !ownerEnabled) return;
    const submission = pending.get(ownerId);
    if (text.trim() && submission) submission.hasNewerDraft = true;
    persist(text, ownerId, ownerEnabled);
  }, { flush: 'sync' });

  function saveDraft(text = options.input.value, sessionId = ownerId) {
    if (!disposed) persist(text, sessionId, ownerEnabled);
  }

  function beginDraftSubmission(text: string, sessionId = ownerId) {
    if (disposed || !ownerEnabled || !sessionId || !text.trim()) return;
    pending.set(sessionId, { text, hasNewerDraft: false });
    persist(text, sessionId, true);
  }

  function completeDraftSubmission(sessionId = ownerId) {
    if (disposed) return;
    const submission = pending.get(sessionId);
    // An old/duplicate completion has no authority over a newer saved draft.
    if (!submission) return;
    try {
      const target = storage();
      const visibleDraft = sessionId === ownerId && Boolean(options.input.value.trim());
      if (!visibleDraft && !submission.hasNewerDraft && target?.getItem(keyFor(sessionId)) === submission.text) target.removeItem(keyFor(sessionId));
    } catch { /* A successful send must not depend on draft cleanup. */ }
    pending.delete(sessionId);
  }

  /** An accepted request owns only the untouched input it reserved. */
  function acceptDraftSubmission(sessionId = ownerId) {
    if (disposed) return;
    const submission = pending.get(sessionId);
    if (!submission) return;
    if (sessionId === ownerId && !submission.hasNewerDraft && options.input.value === submission.text) {
      restoring = true;
      try { options.input.value = ''; }
      finally { restoring = false; }
    }
    completeDraftSubmission(sessionId);
  }

  function restoreFailedDraft() {
    if (disposed || !ownerEnabled) return;
    const submission = pending.get(ownerId);
    if (!submission) return;
    // Clearing a newer draft is also user intent; do not resurrect old input.
    if (!options.input.value.trim() && !submission.hasNewerDraft) {
      restoring = true;
      try { options.input.value = submission.text; }
      finally { restoring = false; }
    }
    if (options.input.value.trim()) options.onRestore?.();
  }

  /** Move only this exact unsubmitted text after a known new-session creation. */
  function transferUnsubmittedDraft(fromSessionId: string, toSessionId: string, expectedText: string): boolean {
    if (disposed || !ownerEnabled || !fromSessionId || !toSessionId || !expectedText.trim() || pending.has(fromSessionId) || pending.has(toSessionId)) return false;
    try {
      const target = storage();
      if (!target || target.getItem(keyFor(fromSessionId)) !== expectedText) return false;
      if (fromSessionId === toSessionId) return true;
      if (ownerId === fromSessionId && options.input.value !== expectedText) return false;
      const destination = target.getItem(keyFor(toSessionId));
      if (destination !== null && destination !== '' && destination !== expectedText) return false;
      if (ownerId === toSessionId && options.input.value && options.input.value !== expectedText) return false;
      target.setItem(keyFor(toSessionId), expectedText);
      if (target.getItem(keyFor(toSessionId)) !== expectedText || target.getItem(keyFor(fromSessionId)) !== expectedText) return false;
      target.removeItem(keyFor(fromSessionId));
      if (target.getItem(keyFor(fromSessionId)) !== null) return false;
      restoring = true;
      try {
        if (ownerId === fromSessionId) options.input.value = '';
        else if (ownerId === toSessionId) options.input.value = expectedText;
      } finally { restoring = false; }
      if (ownerId === toSessionId) options.onRestore?.();
      return true;
    } catch { return false; }
  }

  function dispose() {
    if (disposed) return;
    persist(options.input.value, ownerId, ownerEnabled);
    disposed = true;
    stopSelection();
    stopInput();
    pending.clear();
  }
  if (getCurrentScope()) onScopeDispose(dispose);
  return { saveDraft, beginDraftSubmission, acceptDraftSubmission, completeDraftSubmission, restoreFailedDraft, transferUnsubmittedDraft, dispose };
}
