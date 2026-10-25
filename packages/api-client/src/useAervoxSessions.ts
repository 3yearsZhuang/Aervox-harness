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

export const ACTIVE_SESSION_STORAGE_KEY = 'aervox_active_session_id';

export interface UseAervoxSessionsReturn {
  sessions: Ref<SessionItem[]>;
  activeSessionId: Ref<string>;
  activeSession: ComputedRef<SessionItem | null>;
  loading: Ref<boolean>;
  error: Ref<string | null>;
  fetchSessions: (options?: { projectId?: string | null }) => Promise<SessionItem[]>;
  createNewSession: (title?: string, id?: string, projectId?: string | null) => Promise<SessionItem>;
  switchSession: (sessionId: string) => void;
  renameSession: (
    sessionId: string,
    updates: string | { title?: string; projectId?: string | null },
  ) => Promise<SessionItem | null>;
  deleteSession: (sessionId: string) => Promise<boolean>;
}

export function useAervoxSessions(client: AervoxClient = useAervoxClient()): UseAervoxSessionsReturn {
  const transport = client.transport;
  client.restoreSession();
  const sessions = ref<SessionItem[]>([]);
  const activeSessionId = ref(client.sessionId);
  let selectionVersion = 0;
  const unsubscribe = client.subscribeSession(id => { activeSessionId.value = id; selectionVersion++; });
  if (getCurrentScope()) onScopeDispose(unsubscribe);
  const activeSession = computed(() => sessions.value.find(session => session.id === activeSessionId.value) ?? null);
  const mutationError = ref<string | null>(null);
  const writes = ref(0);
  const resource = createResource(async (options?: {projectId?: string | null}) => {
    const selection = selectionVersion;
    const filtered = Boolean(options?.projectId);
    const path = filtered ? `/v1/sessions?projectId=${encodeURIComponent(options!.projectId!)}` : '/v1/sessions';
    const response = await transport.request<ListSessionsResponse>('GET', path);
    return {items: response.items ?? [], filtered, selection};
  }, result => {
    sessions.value = result.items;
    // Filtering changes the list projection, not the user's selected conversation.
    if (!result.filtered && result.selection === selectionVersion && result.items.length && !result.items.some(row => row.id === activeSessionId.value)) {
      client.setSessionId(result.items[0]!.id);
    }
  });
  const loading = computed(() => resource.loading.value || writes.value > 0);
  const error = computed(() => mutationError.value ?? resource.error.value);
  const replace = (items: SessionItem[]) => {
    resource.invalidate(); sessions.value = items;
  };
  const write = async <T>(action: () => Promise<T>): Promise<T> => {
    writes.value++; mutationError.value = null;
    try { return await action(); }
    catch (cause) { mutationError.value = cause instanceof Error ? cause.message : String(cause); throw cause; }
    finally { writes.value--; }
  };
  const fetchSessions = async (options?: {projectId?: string | null}) => {
    mutationError.value = null;
    try { await resource.load(options); } catch { /* Keep the previous authoritative projection and observable error. */ }
    return sessions.value;
  };
  const createNewSession = (title = '新对话', id?: string, projectId?: string | null): Promise<SessionItem> => write(async () => {
    const body: CreateSessionRequest = {title: title || '新对话', ...(id ? {id} : {}), ...(projectId !== undefined ? {projectId} : {})};
    const created = await transport.request<SessionItem>('POST', '/v1/sessions', body);
    replace([created, ...sessions.value.filter(session => session.id !== created.id)]);
    client.setSessionId(created.id);
    return created;
  });
  const switchSession = (id: string) => { if (id && id !== activeSessionId.value) client.setSessionId(id); };
  const renameSession = async (id: string, updates: string | {title?: string; projectId?: string | null}): Promise<SessionItem | null> => {
    if (!id) return null;
    return write(async () => {
      const body: RenameSessionRequest = typeof updates === 'string' ? {title: updates.trim()} : updates;
      const updated = await transport.request<SessionItem>('PATCH', `/v1/sessions/${encodeURIComponent(id)}`, body);
      replace(sessions.value.map(session => session.id === id ? updated : session));
      return updated;
    });
  };
  const deleteSession = async (id: string): Promise<boolean> => {
    if (!id) return false;
    await write(() => transport.request<void>('DELETE', `/v1/sessions/${encodeURIComponent(id)}`));
    replace(sessions.value.filter(session => session.id !== id));
    if (activeSessionId.value === id) {
      client.setSessionId(sessions.value[0]?.id ?? '');
      // Deletion is committed; replacement failure cannot revive it.
      if (!sessions.value.length) await createNewSession().catch(() => undefined);
    }
    return true;
  };
  return {sessions, activeSessionId, activeSession, loading, error, fetchSessions, createNewSession, switchSession, renameSession, deleteSession};
}
