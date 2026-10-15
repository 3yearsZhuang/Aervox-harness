import { randomBytes, randomUUID } from "node:crypto";
import type {
  BotAdapterContext, BotAdapterInstance, BotAddress, BotLoginResult, BotMessage, BotSendReceipt,
} from "@aervox/host-plugin-api";

type JsonObject = Record<string, unknown>;
type LoginSession = BotLoginResult & { pollingToken: string };

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : {};
}

function string(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

function errorCode(value: JsonObject): number {
  return Number(value.errcode ?? 0) || Number(value.ret ?? 0);
}

function endpoint(value: unknown): string {
  const url = new URL(typeof value === "string" && value ? value : "https://ilinkai.weixin.qq.com");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("weixin_invalid_endpoint");
  }
  return url.toString().replace(/\/$/, "");
}

/** Extract only direct text. Missing platform IDs are rejected because they cannot be deduplicated. */
export function normalizeWeixinMessage(value: unknown, accountId: string, now = Date.now()): BotMessage | undefined {
  const event = object(value);
  const senderId = string(event.from_user_id);
  const id = string(event.message_id ?? event.msg_id);
  if (!id || !senderId || senderId === accountId || senderId.endsWith("@chatroom")
    || Number(event.message_type) !== 1 || (event.to_user_id && string(event.to_user_id) !== accountId)) return;
  const items = Array.isArray(event.item_list) ? event.item_list.map(object) : [];
  const text = items.filter((item) => Number(item.type) === 1)
    .map((item) => string(object(item.text_item).text)).join("").trim();
  if (!text) return;
  const timestamp = Number(event.create_time_ms);
  const milliseconds = Number.isFinite(timestamp) && timestamp > 0 && timestamp < 8.64e15 ? timestamp : now;
  const reference = items.map((item) => object(object(item.ref_msg).message_item))
    .map((item) => string(item.message_id ?? item.msg_id)).find(Boolean);
  return {
    id, accountId, senderId, text, mentions: [],
    address: { kind: "direct", conversationId: senderId, senderId },
    receivedAt: new Date(milliseconds).toISOString(),
    ...(reference ? { replyToId: reference } : {}),
  };
}

interface WeixinDependencies {
  fetch?: typeof fetch;
  /** Shorter values are injectable for deterministic transport tests, never taken from inbound data. */
  retryDelayMs?: number;
  requestTimeoutMs?: number;
  pollTimeoutMs?: number;
}

/** Independently implemented text-only iLink client; no AstrBot code is bundled or executed. */
export class WeixinAdapter implements BotAdapterInstance {
  private readonly abort = new AbortController();
  private readonly fetcher: typeof fetch;
  private readonly onHostAbort = () => { void this.stop().catch(() => undefined); };
  private readonly tasks = new Set<Promise<unknown>>();
  private baseUrl: string;
  private secrets: Record<string, string> = {};
  private progress: Record<string, unknown> = {};
  private accountId = "";
  private loading?: Promise<void>;
  private receiver?: (message: BotMessage) => Promise<void>;
  private pollAbort?: AbortController;
  private polling?: Promise<void>;
  private login?: LoginSession;
  private loginOperation: Promise<unknown> = Promise.resolve();
  private secretOperation: Promise<unknown> = Promise.resolve();
  private started = false;
  private stopping?: Promise<void>;

  constructor(private readonly context: BotAdapterContext, private readonly dependencies: WeixinDependencies = {}) {
    this.baseUrl = endpoint(context.config.endpoint);
    this.fetcher = dependencies.fetch ?? fetch;
    context.signal.addEventListener("abort", this.onHostAbort, { once: true });
    if (context.signal.aborted) this.abort.abort();
  }

  private live(): void {
    if (this.abort.signal.aborted) throw new Error("weixin_stopped");
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.tasks.add(operation);
    void operation.then(() => this.tasks.delete(operation), () => this.tasks.delete(operation));
    return operation;
  }

  private async load(): Promise<void> {
    this.loading ??= (async () => {
      this.secrets = await this.context.secrets.read();
      this.progress = await this.context.checkpoint.read();
      this.live();
      this.accountId = this.secrets.accountId || string(this.progress.accountId);
      if (this.secrets.accountId && this.progress.accountId !== this.secrets.accountId) {
        this.progress = { accountId: this.secrets.accountId, ...(this.secrets.baseUrl ? { baseUrl: this.secrets.baseUrl } : {}) };
      }
      const savedEndpoint = this.secrets.baseUrl ?? this.progress.baseUrl;
      if (typeof savedEndpoint === "string") this.baseUrl = this.trustedLoginEndpoint(savedEndpoint);
    })();
    await this.loading;
    this.live();
  }

  private trustedLoginEndpoint(value: string): string {
    const resolved = endpoint(value);
    const url = new URL(resolved);
    const configured = new URL(endpoint(this.context.config.endpoint));
    if (url.origin !== configured.origin && !url.hostname.endsWith(".weixin.qq.com")) {
      throw new Error("weixin_untrusted_login_endpoint");
    }
    return resolved;
  }

  private async request(path: string, body?: JsonObject, signal?: AbortSignal, token = true): Promise<JsonObject> {
    this.live();
    const timeoutMs = path.includes("getupdates") || path.includes("get_qrcode_status")
      ? this.dependencies.pollTimeoutMs ?? 40_000 : this.dependencies.requestTimeoutMs ?? 15_000;
    const signals = [this.abort.signal, AbortSignal.timeout(timeoutMs)];
    if (signal) signals.push(signal);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE())).toString("base64"),
      "iLink-App-ClientVersion": "1",
    };
    if (token && this.secrets.token) headers.Authorization = `Bearer ${this.secrets.token}`;
    const response = await this.fetcher(`${this.baseUrl}/${path}`, {
      method: body ? "POST" : "GET", headers, redirect: "error",
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any(signals),
    });
    this.live();
    // Do not include upstream bodies, tokens, IDs or URLs in errors/logs.
    if (!response.ok) throw new Error(`weixin_http_${response.status}`);
    const result = await response.json() as unknown;
    this.live();
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("weixin_invalid_response");
    return result as JsonObject;
  }

  async start(receiver: (message: BotMessage) => Promise<void>): Promise<void> {
    this.live();
    if (this.started) throw new Error("weixin_already_started");
    this.started = true;
    this.receiver = receiver;
    await this.load();
    if (!this.secrets.token || !this.accountId) {
      await this.context.setState("login_required");
      return;
    }
    this.startPolling();
  }

  private startPolling(): void {
    if (this.polling || !this.started || this.abort.signal.aborted || !this.secrets.token) return;
    const controller = new AbortController();
    this.pollAbort = controller;
    this.polling = this.poll(controller.signal).finally(() => {
      if (this.pollAbort === controller) {
        this.pollAbort = undefined;
        this.polling = undefined;
      }
    });
    // The loop reports protocol failures; a failed host state write must not become an unhandled rejection.
    void this.polling.catch(() => undefined);
  }

  private async pausePolling(): Promise<void> {
    this.pollAbort?.abort();
    await this.polling?.catch(() => undefined);
  }

  private async delay(milliseconds: number, signal: AbortSignal): Promise<void> {
    const combined = AbortSignal.any([signal, this.abort.signal]);
    if (combined.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); combined.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, milliseconds);
      combined.addEventListener("abort", done, { once: true });
    });
  }

  private updateSecrets(update: (current: Record<string, string>) => Record<string, string> | undefined): Promise<void> {
    const operation = this.secretOperation.then(async () => {
      this.live();
      const next = update(this.secrets);
      if (!next) return;
      await this.context.secrets.write(next);
      this.live();
      this.secrets = next;
    });
    this.secretOperation = operation.catch(() => undefined);
    return operation;
  }

  private async expireLogin(expiredToken: string | undefined): Promise<void> {
    let expired = false;
    await this.updateSecrets((current) => {
      // A delayed response from a previous login cannot revoke freshly confirmed credentials.
      if (current.token !== expiredToken) return;
      const { token: _token, ...remaining } = current;
      expired = true;
      return remaining;
    });
    this.live();
    if (!expired) return;
    this.pollAbort?.abort();
    await this.context.setState("login_required", { error: "weixin_session_expired" });
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let failures = 0;
    // The host must persist the authenticated account (and revoke old owner bindings) before
    // even the first pairing/message callback. Waiting until after getupdates loses that event.
    await this.context.setState("connecting", { accountId: this.accountId });
    while (!signal.aborted && !this.abort.signal.aborted && this.secrets.token) {
      let authenticated = false;
      try {
        const pollingToken = this.secrets.token;
        const data = await this.request("ilink/bot/getupdates", {
          base_info: { channel_version: "aervox" }, get_updates_buf: string(this.progress.cursor),
        }, signal);
        if (signal.aborted) return;
        const code = errorCode(data);
        if (code === -14) { await this.expireLogin(pollingToken); return; }
        if (code !== 0 || (!Array.isArray(data.msgs) && data.get_updates_buf === undefined && data.ret === undefined)) {
          throw new Error("weixin_poll_rejected");
        }
        await this.context.setState("connected", { accountId: this.accountId });
        authenticated = true;
        for (const raw of Array.isArray(data.msgs) ? data.msgs : []) {
          if (signal.aborted || this.abort.signal.aborted) return;
          const message = normalizeWeixinMessage(raw, this.accountId);
          if (!message) continue;
          const contextToken = string(object(raw).context_token);
          if (contextToken) {
            await this.updateSecrets((current) => ({ ...current, [`context:${message.senderId}`]: contextToken }));
          }
          if (signal.aborted || this.abort.signal.aborted) return;
          await this.receiver?.(message);
        }
        // A crash before this checkpoint safely replays IDs into the host's durable dedupe table.
        if (signal.aborted || this.abort.signal.aborted) return;
        const nextCursor = typeof data.get_updates_buf === "string" ? data.get_updates_buf : string(this.progress.cursor);
        const next = { ...this.progress, cursor: nextCursor };
        await this.context.checkpoint.write(next);
        this.progress = next;
        failures = 0;
        await this.context.setState("connected", { accountId: this.accountId });
        await this.delay(50, signal);
      } catch {
        if (signal.aborted || this.abort.signal.aborted) return;
        failures++;
        // A full host queue must keep draining while this batch waits for durable admission.
        // It is not a platform disconnection; changing to reconnecting here deadlocks first-poll backlogs.
        await this.context.setState(authenticated ? "connected" : "reconnecting", {
          accountId: this.accountId,
          error: authenticated ? "weixin_message_admission_retrying" : "weixin_poll_interrupted",
        });
        await this.delay(Math.min(30_000, (this.dependencies.retryDelayMs ?? 1_000) * 2 ** Math.min(failures - 1, 5)), signal);
      }
    }
  }

  beginLogin(): Promise<BotLoginResult> {
    const operation = this.loginOperation.then(() => this.createLogin());
    this.loginOperation = operation.catch(() => undefined);
    return this.track(operation);
  }

  private async createLogin(): Promise<BotLoginResult> {
    await this.load();
    await this.pausePolling();
    this.live();
    const data = await this.request("ilink/bot/get_bot_qrcode?bot_type=3", undefined, undefined, false);
    const pollingToken = string(data.qrcode);
    const qrCodeUrl = string(data.qrcode_img_content);
    if (!pollingToken || !qrCodeUrl || errorCode(data) !== 0) throw new Error("weixin_invalid_login_response");
    this.login = { pollingToken, status: "waiting", qrCodeUrl, expiresAt: new Date(Date.now() + 300_000).toISOString() };
    await this.context.setState("login_required");
    return this.loginResult(this.login);
  }

  private loginResult(login: LoginSession): BotLoginResult {
    const { pollingToken: _private, ...result } = login;
    return result;
  }

  pollLogin(): Promise<BotLoginResult> {
    const operation = this.loginOperation.then(() => this.checkLogin());
    this.loginOperation = operation.catch(() => undefined);
    return this.track(operation);
  }

  private async checkLogin(): Promise<BotLoginResult> {
    await this.load();
    const login = this.login;
    if (!login) throw new Error("weixin_login_not_started");
    if (login.status === "confirmed" || login.status === "expired") return this.loginResult(login);
    if (Date.parse(login.expiresAt!) <= Date.now()) {
      login.status = "expired";
      return this.loginResult(login);
    }
    const data = await this.request(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(login.pollingToken)}`, undefined, undefined, false);
    if (login !== this.login) throw new Error("weixin_login_replaced");
    if (errorCode(data) !== 0) throw new Error("weixin_login_rejected");
    if (data.status === "confirmed") {
      const token = string(data.bot_token);
      const accountId = string(data.ilink_bot_id);
      if (!token || !accountId) throw new Error("weixin_login_credentials_missing");
      const baseUrl = data.baseurl ? this.trustedLoginEndpoint(string(data.baseurl)) : this.baseUrl;
      const changedAccount = accountId !== this.accountId;
      // A newly logged-in account never inherits another account's reply credentials or cursor.
      const nextProgress = { ...(changedAccount ? {} : this.progress), accountId, baseUrl };
      await this.updateSecrets((current) => ({ ...(changedAccount ? {} : current), token, accountId, baseUrl }));
      this.live();
      await this.context.checkpoint.write(nextProgress);
      this.live();
      this.progress = nextProgress;
      this.accountId = accountId;
      this.baseUrl = baseUrl;
      await this.context.setState("connecting", { accountId });
      this.live();
      this.login = { pollingToken: "", status: "confirmed", accountId };
      this.startPolling();
      return this.loginResult(this.login);
    }
    login.status = data.status === "expired" ? "expired" : data.status === "scanned" ? "scanned" : "waiting";
    return this.loginResult(login);
  }

  send(address: BotAddress, text: string): Promise<BotSendReceipt> {
    return this.track(this.sendText(address, text));
  }

  private async sendText(address: BotAddress, text: string): Promise<BotSendReceipt> {
    try { await this.load(); } catch { return { status: "failed", error: "weixin_stopped", retryable: false }; }
    if (address.kind !== "direct" || !text.trim() || Array.from(text).length > 2000) {
      return { status: "failed", error: "weixin_invalid_message", retryable: false };
    }
    const contextToken = this.secrets[`context:${address.conversationId}`];
    if (!this.secrets.token || !contextToken) {
      return { status: "failed", error: "weixin_login_or_context_required", retryable: false };
    }
    try {
      const sendingToken = this.secrets.token;
      const data = await this.request("ilink/bot/sendmessage", {
        base_info: { channel_version: "aervox" },
        msg: {
          from_user_id: "", to_user_id: address.conversationId, client_id: randomUUID(),
          message_type: 2, message_state: 2, context_token: contextToken,
          item_list: [{ type: 1, text_item: { text } }],
        },
      });
      const code = errorCode(data);
      if (code === -14) await this.expireLogin(sendingToken);
      if (code !== 0) return { status: "failed", error: "weixin_send_rejected", retryable: false };
      if (data.ret === undefined && data.errcode === undefined) {
        return { status: "unknown", error: "weixin_send_receipt_missing", retryable: false };
      }
      const messageId = string(data.message_id ?? data.msg_id);
      return { status: "accepted", ...(messageId ? { messageId } : {}) };
    } catch {
      // A network/HTTP failure after dispatch cannot prove that Weixin did not accept the text.
      return { status: "unknown", error: "weixin_send_receipt_unknown", retryable: false };
    }
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.abort.abort();
      this.pollAbort?.abort();
      this.context.signal.removeEventListener("abort", this.onHostAbort);
      this.login = undefined;
      await Promise.allSettled([...(this.polling ? [this.polling] : []), ...this.tasks]);
      this.receiver = undefined;
      await this.context.setState("stopped");
    })();
    return this.stopping;
  }
}
