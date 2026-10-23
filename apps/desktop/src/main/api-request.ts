/** JSON API forwarding owned by Electron main; renderer credentials never cross IPC. */
export function createDesktopApiRequest(options: {apiBaseUrl: string; authToken: () => string | undefined}) {
  return async (payload: unknown) => {
    if (!isApiRequest(payload)) return {status: 400, ok: false, json: null, text: 'invalid api request'};
    const method = (payload.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {Accept: 'application/json'};
    const token = options.authToken()?.trim();
    if (token) headers.Authorization = `Bearer ${token}`;
    const key = payload.headers?.['Idempotency-Key'];
    if (typeof key === 'string' && key.length > 0) headers['Idempotency-Key'] = key;
    let body: string | undefined;
    if (method !== 'GET' && payload.body !== undefined) {
      headers['Content-Type'] = 'application/json'; body = JSON.stringify(payload.body);
    }
    try {
      const response = await fetch(`${options.apiBaseUrl}${payload.path}`, {method, headers, body, redirect: 'error'});
      const text = await response.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* Non-JSON responses retain the existing envelope. */ }
      return {status: response.status, ok: response.ok, json, text};
    } catch (error) {
      return {status: 0, ok: false, json: null, text: error instanceof Error ? error.message : 'request failed'};
    }
  };
}
function isApiRequest(value: unknown): value is {method?: string; path: string; body?: unknown; headers?: Record<string, string>} {
  if (!value || typeof value !== 'object') return false;
  const request = value as Record<string, unknown>;
  if (typeof request.path !== 'string' || !request.path.startsWith('/') || request.path.startsWith('//') || /[\\\u0000-\u001f]/.test(request.path) || request.path.includes('://')) return false;
  if (request.method !== undefined && typeof request.method !== 'string') return false;
  if (request.headers !== undefined && (!request.headers || typeof request.headers !== 'object' || Array.isArray(request.headers))) return false;
  return true;
}
