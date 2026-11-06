/**
 * Aervox｜思隅 @aervox/api-client — 多会话管理 Composable (CR-035 / CR-046)
 *
 * 提供会话列表拉取、新建、重命名、删除及活跃会话切换，
 * 支持本地存储持久化与纯本地 SQLite 存储契约。
 */
import { computed, getCurrentScope, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue';
import type {
  CreateSessionRequest,
  ListSessionsResponse,
  RenameSessionRequest,
  SessionItem,
} from '@aervox/contracts';
import { useAervoxClient } from './client-context.js';
import type { AervoxClient } from './transport.js';
import { createResource } from './resource.js';
import { AervoxHttpError } from './transport.js';

export const ACTIVE_SESSION_STORAGE_KEY = 'aervox_active_session_id';

export interface FetchSessionsOptions {
  projectId?: string | null;
  preserveSelection?: boolean;
  /** Explicit bounded paging; omitted keeps the legacy single-read behavior. */
  pageSize?: number;
  /** Verify a restored selection independently when it is outside this page. */
  includeActive?: boolean;
}

export interface UseAervoxSessionsReturn {
  sessions: Ref<SessionItem[]>;
  activeSessionId: Ref<string>;
  activeSession: ComputedRef<SessionItem | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  fetchSessions: (options?: FetchSessionsOptions) => Promise<SessionItem[]>;
  loadMoreSessions: () => Promise<SessionItem[]>;
  hasMore: Ref<boolean>;
  activeSessionError: Ref<string | null>;
  createNewSession: (title?: string, id?: string, projectId?: string | null, options?: {select?: boolean}) => Promise<SessionItem>;
  switchSession: (sessionId: string) => void;
  renameSession: (
    sessionId: string,
    updates: string | { title?: string; projectId?: string | null },
  ) => Promise<SessionItem | null>;
  deleteSession: (sessionId: string, options?: {select?: boolean}) => Promise<boolean>;
}

export function useAervoxSessions(client: AervoxClient = useAervoxClient()): UseAervoxSessionsReturn {
  const transport = client.transport;
  client.restoreSession();
  const sessions = ref<SessionItem[]>([]);
  const selectedSession = ref<SessionItem | null>(null);
  const activeSessionError = ref<string | null>(null);
  const selectionErrors = new Map<string, string>();
  const hasMore = ref(false);
  let pagingOptions: FetchSessionsOptions | undefined;
  let nextOffset = 0;
  let sourceIds = new Set<string>();
  const activeSessionId = ref(client.sessionId);
  let selectionVersion = 0;
  const unsubscribe = client.subscribeSession(id => {
    const selection = ++selectionVersion;
    activeSessionId.value = id;
    // A synchronous surface watcher can retain the original request owner.
    // Its nested selection owns the metadata, even when it returns to this ID.
    if (selection !== selectionVersion || client.sessionId !== id) return;
    if (selectedSession.value?.id !== id) selectedSession.value = null;
    if (selection !== selectionVersion || client.sessionId !== id) return;
    activeSessionError.value = selectionErrors.get(id) ?? null;
  });
  if (getCurrentScope()) onScopeDispose(unsubscribe);
  const activeSession = computed(() => activeSessionError.value ? null
    : sessions.value.find(session => session.id === activeSessionId.value)
      ?? (selectedSession.value?.id === activeSessionId.value ? selectedSession.value : null));
  const mutationError = ref<string | null>(null);
  const writes = ref(0);
  const resource = createResource(async (options?: FetchSessionsOptions, offset: number = 0, append: boolean = false) => {
    const selection = selectionVersion;
    const selectedId = activeSessionId.value;
    if (options?.pageSize !== undefined && (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)) throw new Error('INVALID_SESSION_PAGE_SIZE');
    const filtered = Boolean(options?.projectId);
    const params = new URLSearchParams();
    if (filtered) params.set('projectId', options!.projectId!);
    if (options?.pageSize !== undefined) { params.set('limit', String(options.pageSize)); params.set('offset', String(offset)); }
    const path = '/v1/sessions' + (params.size ? '?' + params.toString() : '');
    const response = await transport.request<ListSessionsResponse>('GET', path);
    const items = response.items ?? [];
    let selected = items.find(row => row.id === selectedId) ?? null;
    let selectionError: string | null = null;
    if (options?.includeActive && selectedId && selectedId !== 'web_default' && !selected) {
      try {
        selected = await transport.request<SessionItem>('GET', `/v1/sessions/${encodeURIComponent(selectedId)}`);
        if (selected.id !== selectedId) throw new Error('SESSION_ID_MISMATCH');
      }
      catch (cause) {
        selectionError = cause instanceof AervoxHttpError && cause.status === 404
          ? '当前会话已不存在，请明确选择或新建会话。'
          : '当前会话未能确认，请刷新后重试。';
      }
    }
    return {items, filtered, selection, selectedId, selected, selectionError, options, offset, append,
      preserveSelection: append || options?.preserveSelection === true};
  }, result => {
    const merged = result.append ? [...sessions.value, ...result.items] : result.items;
    sessions.value = [...new Map(merged.map(item => [item.id, item])).values()];
    if (!result.append) sourceIds = new Set();
    for (const item of result.items) sourceIds.add(item.id);
    pagingOptions = result.options ? { ...result.options } : undefined;
    nextOffset = result.offset + result.items.length;
    hasMore.value = result.options?.pageSize !== undefined && result.items.length === result.options.pageSize;
    if (result.selection === selectionVersion) {
      for (const item of result.items) selectionErrors.delete(item.id);
      if (result.items.some(item => item.id === activeSessionId.value)) activeSessionError.value = null;
    }
    if (result.selection === selectionVersion && result.options?.includeActive) {
      selectedSession.value = result.selected?.id === result.selectedId ? result.selected : null;
      activeSessionError.value = result.selectionError;
      if (result.selectionError) selectionErrors.set(result.selectedId, result.selectionError);
      else selectionErrors.delete(result.selectedId);
    }
    // Filtering changes the list projection, not the user's selected conversation.
    if (!result.preserveSelection && !result.filtered && result.selection === selectionVersion && result.items.length && !result.selected) {
      client.setSessionId(result.items[0]!.id);
    }
  });
  const loading = computed(() => resource.loading.value || writes.value > 0);
  const error = computed(() => mutationError.value ?? resource.error.value ?? activeSessionError.value);
  const replace = (items: SessionItem[]) => {
    resource.invalidate(); sessions.value = items;
  };
  const write = async <T>(action: () => Promise<T>): Promise<T> => {
    writes.value++; mutationError.value = null;
    try { return await action(); }
    catch (cause) { mutationError.value = cause instanceof Error ? cause.message : String(cause); throw cause; }
    finally { writes.value--; }
  };
  const fetchSessions = async (options?: FetchSessionsOptions) => {
    mutationError.value = null;
    try { await resource.load(options); } catch { /* Keep the previous authoritative projection and observable error. */ }
    return sessions.value;
  };
  const loadMoreSessions = async () => {
    if (!hasMore.value || !pagingOptions || loading.value) return sessions.value;
    mutationError.value = null;
    try { await resource.load({ ...pagingOptions, preserveSelection: true }, nextOffset, true); }
    catch { /* Preserve both the last projection and its retryable page offset. */ }
    return sessions.value;
  };
  const createNewSession = (title = '新对话', id?: string, projectId?: string | null, options?: {select?: boolean}): Promise<SessionItem> => write(async () => {
    const body: CreateSessionRequest = {title: title || '新对话', ...(id ? {id} : {}), ...(projectId !== undefined ? {projectId} : {})};
    const created = await transport.request<SessionItem>('POST', '/v1/sessions', body);
    selectionErrors.delete(created.id);
    if (pagingOptions?.pageSize && !sourceIds.has(created.id) && (!pagingOptions.projectId || created.projectId === pagingOptions.projectId)) {
      nextOffset++; sourceIds.add(created.id);
    }
    replace([created, ...sessions.value.filter(session => session.id !== created.id)]);
    // A surface coordinating an in-flight selection can apply this committed
    // identity after releasing its own operation lock.
    if (options?.select !== false) client.setSessionId(created.id);
    return created;
  });
  const switchSession = (id: string) => { if (id && id !== activeSessionId.value) client.setSessionId(id); };
  const renameSession = async (id: string, updates: string | {title?: string; projectId?: string | null}): Promise<SessionItem | null> => {
    if (!id) return null;
    return write(async () => {
      const body: RenameSessionRequest = typeof updates === 'string' ? {title: updates.trim()} : updates;
      const updated = await transport.request<SessionItem>('PATCH', `/v1/sessions/${encodeURIComponent(id)}`, body);
      selectionErrors.delete(id);
      if (activeSessionId.value === id) activeSessionError.value = null;
      if (selectedSession.value?.id === id) selectedSession.value = updated;
      replace(sessions.value.map(session => session.id === id ? updated : session));
      return updated;
    });
  };
  const deleteSession = async (id: string, options?: {select?: boolean}): Promise<boolean> => {
    if (!id) return false;
    await write(() => transport.request<void>('DELETE', `/v1/sessions/${encodeURIComponent(id)}`));
    if (sourceIds.delete(id)) nextOffset = Math.max(0, nextOffset - 1);
    selectionErrors.delete(id);
    if (selectedSession.value?.id === id) selectedSession.value = null;
    replace(sessions.value.filter(session => session.id !== id));
    if (activeSessionId.value === id && options?.select !== false) {
      client.setSessionId(sessions.value[0]?.id ?? '');
      // Deletion is committed; replacement failure cannot revive it.
      if (!sessions.value.length) await createNewSession().catch(() => undefined);
    }
    return true;
  };
  return {sessions, activeSessionId, activeSession, loading, error, fetchSessions, loadMoreSessions, hasMore, activeSessionError,
    createNewSession, switchSession, renameSession, deleteSession};
}
