/**
 * Aervox｜思隅 @aervox/web — 浏览器 API 桥
 *
 * 直接 Fetch 访问 @aervox/api 用户侧路由（源自 desktop `useAervoxApi` 的浏览器降级分支）。
 * 租户头可在构建/开发期通过 VITE_WORKSPACE_ID / VITE_USER_ID 注入，缺省时服务端回退默认租户。
 */

const API_BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '') || 'http://127.0.0.1:3000';

const tenantHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (import.meta.env.VITE_WORKSPACE_ID) headers['x-workspace-id'] = import.meta.env.VITE_WORKSPACE_ID;
  if (import.meta.env.VITE_USER_ID) headers['x-user-id'] = import.meta.env.VITE_USER_ID;
  return headers;
};

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function apiRequest<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...tenantHeaders() },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new ApiError(`API ${method} ${path} → HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

export const http = {
  get: <T = unknown>(path: string): Promise<T> => apiRequest<T>('GET', path),
  post: <T = unknown>(path: string, body?: unknown): Promise<T> => apiRequest<T>('POST', path, body),
};

/** 拼出带基址的完整 URL（SSE 等需要原生 fetch 的路径使用） */
export function apiBase(path: string): string {
  return `${API_BASE}${path}`;
}