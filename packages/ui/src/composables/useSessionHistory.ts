import { getCurrentScope, onScopeDispose, ref, shallowRef, watch, type Ref } from 'vue';
import { AervoxHttpError, createSessionHistoryClient, getClientTransport } from '@aervox/api-client';
import type { SessionHistoryPage } from '@aervox/contracts';

/** A single explicit page. History reads never mutate the live conversation. */
export function useSessionHistory(
  open: Ref<boolean>,
  sessionId: Ref<string>,
  client = createSessionHistoryClient(getClientTransport()),
) {
  const page = shallowRef<SessionHistoryPage | null>(null);
  const limit = ref(20);
  const loading = ref(false);
  const error = ref('');
  const atLatest = ref(true);
  let generation = 0;
  let controller: AbortController | undefined;

  function clear() {
    generation++;
    controller?.abort();
    controller = undefined;
    page.value = null;
    error.value = '';
    loading.value = false;
  }

  async function load(cursor?: string) {
    clear();
    atLatest.value = cursor === undefined;
    const id = sessionId.value;
    if (!open.value || !id) return;
    const stamp = generation;
    const count = limit.value;
    const request = new AbortController();
    controller = request;
    loading.value = true;
    try {
      const result = await client.getPage(id, { limit: count, cursor, signal: request.signal });
      // Some platform transports cannot cancel in-flight work. Identity and
      // generation checks still prevent a closed or replaced view resurfacing.
      if (stamp !== generation || !open.value || sessionId.value !== id) return;
      if (result.sessionId !== id || result.items.length > count || (cursor && result.nextCursor === cursor)) {
        throw new Error('Invalid history page');
      }
      page.value = result;
    } catch (cause) {
      if (stamp !== generation || !open.value || sessionId.value !== id) return;
      error.value = cause instanceof AervoxHttpError && cause.status === 410
        ? '这页记录已变化，请回到最新记录。'
        : cause instanceof AervoxHttpError && cause.status === 422
          ? '这页记录过大，请减少每页条数后重试；单轮记录过大时暂时无法显示。'
          : cause instanceof AervoxHttpError && cause.status === 404
            ? '无法读取这段对话，记录可能已删除。'
            : '暂时无法读取对话记录，请稍后刷新。';
    } finally {
      if (stamp === generation) {
        loading.value = false;
        controller = undefined;
      }
    }
  }

  const refresh = () => load();
  const earlier = () => page.value?.nextCursor && !loading.value
    ? load(page.value.nextCursor)
    : Promise.resolve();

  watch([open, sessionId, limit], () => { void load(); }, { immediate: true, flush: 'sync' });
  if (getCurrentScope()) onScopeDispose(clear);
  return { page, limit, loading, error, atLatest, refresh, earlier };
}
