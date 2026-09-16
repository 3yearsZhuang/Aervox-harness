export interface XiaomiHealthClientOptions {
  apiBaseUrl: string;
  accessToken: string;
  refreshToken?: string;
  tokenEndpoint?: string;
  clientId?: string;
  clientSecret?: string;
  dailyPath?: string;
  timeoutMs?: number;
}

export interface XiaomiHealthDailySample {
  localDate: string;
  steps?: number;
  sleepMinutes?: number;
  restingHeartRate?: number;
  metadata?: Record<string, unknown>;
}

function normalizeDailyPayload(payload: unknown, requestedDate: string): XiaomiHealthDailySample {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const data = root.data && typeof root.data === "object" ? root.data as Record<string, unknown> : root;
  const number = (...keys: string[]): number | undefined => {
    for (const key of keys) {
      const value = data[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return undefined;
  };
  return {
    localDate: typeof data.date === "string" ? data.date : requestedDate,
    steps: number("steps", "step_count", "stepCount"),
    sleepMinutes: number("sleep_minutes", "sleepMinutes", "total_sleep_minutes"),
    restingHeartRate: number("resting_heart_rate", "restingHeartRate"),
    metadata: {providerPayloadVersion: root.version ?? null},
  };
}

export class XiaomiHealthClient {
  private readonly timeoutMs: number;

  constructor(private readonly options: XiaomiHealthClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  private async fetchJson(url: URL, init: RequestInit): Promise<unknown> {
    if (url.protocol !== "https:" && url.hostname !== "127.0.0.1" && url.hostname !== "::1") {
      throw new Error("xiaomi_health_endpoint_requires_https");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {...init, redirect: "error", signal: controller.signal});
      if (!response.ok) throw new Error(`xiaomi_health_http_${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async testConnection(date = new Date().toISOString().slice(0, 10)): Promise<{ok: true; sample: XiaomiHealthDailySample}> {
    return {ok: true, sample: await this.fetchDaily(date)};
  }

  async fetchDaily(date: string): Promise<XiaomiHealthDailySample> {
    const url = new URL(this.options.dailyPath ?? "/v1/health/daily", this.options.apiBaseUrl);
    url.searchParams.set("date", date);
    const payload = await this.fetchJson(url, {
      method: "GET",
      headers: {Accept: "application/json", Authorization: `Bearer ${this.options.accessToken}`},
    });
    return normalizeDailyPayload(payload, date);
  }

  async refreshAccessToken(): Promise<{accessToken: string; refreshToken?: string; expiresIn?: number}> {
    if (!this.options.tokenEndpoint || !this.options.refreshToken || !this.options.clientId) {
      throw new Error("xiaomi_health_refresh_not_configured");
    }
    const url = new URL(this.options.tokenEndpoint);
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.options.refreshToken,
      client_id: this.options.clientId,
    });
    if (this.options.clientSecret) body.set("client_secret", this.options.clientSecret);
    const payload = await this.fetchJson(url, {
      method: "POST",
      headers: {Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded"},
      body: body.toString(),
    }) as Record<string, unknown>;
    if (typeof payload.access_token !== "string") throw new Error("xiaomi_health_refresh_missing_access_token");
    return {
      accessToken: payload.access_token,
      refreshToken: typeof payload.refresh_token === "string" ? payload.refresh_token : undefined,
      expiresIn: typeof payload.expires_in === "number" ? payload.expires_in : undefined,
    };
  }
}
