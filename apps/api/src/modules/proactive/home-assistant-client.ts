import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

export interface HomeAssistantEntityState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_changed?: string;
  last_updated?: string;
}

export interface HomeAssistantClientOptions {
  endpoint: string;
  accessToken: string;
  timeoutMs?: number;
}

function privateAddress(address: string): boolean {
  if (address === "127.0.0.1" || address === "::1") return true;
  if (address.startsWith("10.") || address.startsWith("192.168.")) return true;
  const v4 = /^172\.(\d{1,3})\./.exec(address);
  if (v4 && Number(v4[1]) >= 16 && Number(v4[1]) <= 31) return true;
  if (address.startsWith("169.254.")) return true;
  const lower = address.toLowerCase();
  return lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
}

export async function assertPrivateHomeAssistantEndpoint(endpoint: string): Promise<URL> {
  const url = new URL(endpoint);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("home_assistant_endpoint_requires_http_or_https");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost") return url;
  if (isIP(hostname)) {
    if (!privateAddress(hostname)) throw new Error("home_assistant_endpoint_must_be_private");
    return url;
  }
  const resolved = await lookup(hostname, { all: true, verbatim: true });
  if (resolved.length === 0 || resolved.some((entry) => !privateAddress(entry.address))) {
    throw new Error("home_assistant_endpoint_must_resolve_to_private_addresses");
  }
  return url;
}

export class HomeAssistantClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: HomeAssistantClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const base = await assertPrivateHomeAssistantEndpoint(this.options.endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(new URL(path, base), {
        ...init,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.options.accessToken}`,
          ...(init.body ? {"Content-Type": "application/json"} : {}),
          ...init.headers,
        },
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`home_assistant_http_${response.status}`);
      }
      return await response.json() as T;
    } finally {
      clearTimeout(timeout);
    }
  }

  async testConnection(): Promise<{ok: true; message: string}> {
    const result = await this.request<{message?: string}>("/api/");
    return {ok: true, message: result.message ?? "Home Assistant connected"};
  }

  listStates(): Promise<HomeAssistantEntityState[]> {
    return this.request<HomeAssistantEntityState[]>("/api/states");
  }

  getState(entityId: string): Promise<HomeAssistantEntityState> {
    return this.request<HomeAssistantEntityState>(`/api/states/${encodeURIComponent(entityId)}`);
  }

  callService(domain: string, service: string, data: Record<string, unknown>): Promise<unknown> {
    if (!/^[a-z0-9_]+$/.test(domain) || !/^[a-z0-9_]+$/.test(service)) {
      throw new Error("invalid_home_assistant_service");
    }
    return this.request(`/api/services/${domain}/${service}`, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }

  async subscribeStateChanges(
    onEvent: (event: unknown) => void,
    signal?: AbortSignal,
  ): Promise<() => void> {
    const base = await assertPrivateHomeAssistantEndpoint(this.options.endpoint);
    const wsUrl = new URL("/api/websocket", base);
    wsUrl.protocol = base.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(wsUrl);
    const subscriptionId = 1;
    const close = () => {
      signal?.removeEventListener("abort", close);
      socket.close();
    };
    signal?.addEventListener("abort", close, {once: true});
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error("home_assistant_websocket_timeout")), this.timeoutMs);
      socket.addEventListener("message", (message) => {
        let payload: Record<string, unknown>;
        try {
          payload = JSON.parse(String(message.data)) as Record<string, unknown>;
        } catch {
          return;
        }
        if (payload.type === "auth_required") {
          socket.send(JSON.stringify({type: "auth", access_token: this.options.accessToken}));
        } else if (payload.type === "auth_invalid") {
          finish(new Error("home_assistant_websocket_auth_invalid"));
          close();
        } else if (payload.type === "auth_ok") {
          socket.send(JSON.stringify({id: subscriptionId, type: "subscribe_events", event_type: "state_changed"}));
        } else if (payload.type === "result" && payload.id === subscriptionId) {
          if (payload.success === true) finish();
          else finish(new Error("home_assistant_websocket_subscribe_failed"));
        } else if (payload.type === "event") {
          onEvent(payload.event);
        }
      });
      socket.addEventListener("error", () => finish(new Error("home_assistant_websocket_error")), {once: true});
      socket.addEventListener("close", () => finish(new Error("home_assistant_websocket_closed")), {once: true});
    });
    return close;
  }
}
