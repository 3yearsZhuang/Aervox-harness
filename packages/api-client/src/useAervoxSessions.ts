/**
 * Aervox｜思隅 @aervox/api-client — 多会话管理 Composable (CR-035 / CR-046)
 *
 * 提供会话列表拉取、新建、重命名、删除及活跃会话切换，
 * 支持本地存储持久化与纯本地 SQLite 存储契约。
 */
import { computed, ref, type ComputedRef, type Ref } from 'vue';
import type {
  CreateSessionRequest,
  ListSessionsResponse,
  RenameSessionRequest,
  SessionItem,
} from '@aervox/contracts';
import { getSessionId, getTransport, setSessionId } from './transport';

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

export function useAervoxSessions(): UseAervoxSessionsReturn {
  const sessions = ref<SessionItem[]>([]);
  
  // 初始化活跃会话：优先从 localStorage 恢复，其次读取 transport 默认值
  let initialSessionId = getSessionId();
  try {
    if (typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
      if (stored && stored.trim()) {
        initialSessionId = stored.trim();
        setSessionId(initialSessionId);
      }
    }
  } catch {
    // 忽略在非浏览器/测试环境中的访问异常
  }

  const activeSessionId = ref<string>(initialSessionId);
  const loading = ref<boolean>(false);
  const error = ref<string | null>(null);

  const activeSession = computed<SessionItem | null>(() => {
    return sessions.value.find((s) => s.id === activeSessionId.value) ?? null;
  });

  const persistActiveSession = (id: string): void => {
    activeSessionId.value = id;
    setSessionId(id);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, id);
      }
    } catch {
      // 忽略存储异常
    }
  };

  const fetchSessions = async (options?: { projectId?: string | null }): Promise<SessionItem[]> => {
    loading.value = true;
    error.value = null;
    try {
      const path = options?.projectId
        ? `/v1/sessions?projectId=${encodeURIComponent(options.projectId)}`
        : '/v1/sessions';
      const res = await getTransport().request<ListSessionsResponse>('GET', path);
      sessions.value = res.items ?? [];

      // 若列表非空且当前活跃 ID 不在列表中，自动对齐到首个会话
      if (sessions.value.length > 0) {
        const found = sessions.value.some((s) => s.id === activeSessionId.value);
        if (!found && sessions.value[0]) {
          persistActiveSession(sessions.value[0].id);
        }
      }
      return sessions.value;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
      return sessions.value;
    } finally {
      loading.value = false;
    }
  };

  const createNewSession = async (
    title = '新对话',
    id?: string,
    projectId?: string | null,
  ): Promise<SessionItem> => {
    loading.value = true;
    error.value = null;
    try {
      const body: CreateSessionRequest = {
        title: title || '新对话',
        ...(id ? { id } : {}),
        ...(projectId !== undefined ? { projectId } : {}),
      };
      const created = await getTransport().request<SessionItem>('POST', '/v1/sessions', body);
      // 插入到首位
      sessions.value = [created, ...sessions.value.filter((s) => s.id !== created.id)];
      persistActiveSession(created.id);
      return created;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
      // 降级本地虚拟会话
      const fallbackSession: SessionItem = {
        id: id || `ses_local_${Date.now()}`,
        title: title || '新对话',
        projectId: projectId ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      sessions.value = [fallbackSession, ...sessions.value];
      persistActiveSession(fallbackSession.id);
      return fallbackSession;
    } finally {
      loading.value = false;
    }
  };

  const switchSession = (sessionId: string): void => {
    if (!sessionId || sessionId === activeSessionId.value) return;
    persistActiveSession(sessionId);
  };

  const renameSession = async (
    sessionId: string,
    updates: string | { title?: string; projectId?: string | null },
  ): Promise<SessionItem | null> => {
    if (!sessionId) return null;
    try {
      const body: RenameSessionRequest =
        typeof updates === 'string'
          ? { title: updates.trim() }
          : updates;
      const updated = await getTransport().request<SessionItem>(
        'PATCH',
        `/v1/sessions/${encodeURIComponent(sessionId)}`,
        body,
      );
      const index = sessions.value.findIndex((s) => s.id === sessionId);
      if (index !== -1) {
        sessions.value[index] = updated;
      }
      return updated;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
      // 本地乐观更新
      const existing = sessions.value.find((s) => s.id === sessionId);
      if (existing) {
        if (typeof updates === 'string') {
          existing.title = updates.trim();
        } else {
          if (updates.title !== undefined) existing.title = updates.title;
          if (updates.projectId !== undefined) existing.projectId = updates.projectId;
        }
        existing.updatedAt = new Date().toISOString();
        return existing;
      }
      return null;
    }
  };

  const deleteSession = async (sessionId: string): Promise<boolean> => {
    if (!sessionId) return false;
    try {
      await getTransport().request<void>('DELETE', `/v1/sessions/${encodeURIComponent(sessionId)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error.value = msg;
    }
    // 本地移除
    sessions.value = sessions.value.filter((s) => s.id !== sessionId);

    // 如果删除的是当前活跃会话，切换到第一个会话或新建
    if (activeSessionId.value === sessionId) {
      if (sessions.value.length > 0 && sessions.value[0]) {
        persistActiveSession(sessions.value[0].id);
      } else {
        await createNewSession('新对话');
      }
    }
    return true;
  };

  return {
    sessions,
    activeSessionId,
    activeSession,
    loading,
    error,
    fetchSessions,
    createNewSession,
    switchSession,
    renameSession,
    deleteSession,
  };
}
