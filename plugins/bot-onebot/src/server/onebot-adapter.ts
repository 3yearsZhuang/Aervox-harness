import { randomUUID } from "node:crypto";
import WebSocket from "ws";
import type {
  BotAdapterContext, BotAdapterInstance, BotAddress, BotMessage, BotSendReceipt,
} from "@aervox/host-plugin-api";

type JsonObject = Record<string, unknown>;
function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : {};
}
function id(value: unknown): string {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)) return "";
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/** String/CQ-code messages are deliberately not parsed: NapCat must emit array segments. */
export function normalizeOneBotMessage(value: unknown, accountId: string): BotMessage | undefined {
  const event = object(value);
  const senderId = id(event.user_id);
  const messageId = id(event.message_id);
  const groupId = id(event.group_id);
  if (event.post_type !== "message" || event.message_type !== "group" || id(event.self_id) !== accountId
    || !senderId || senderId === accountId || !messageId || !groupId || !Array.isArray(event.message)) return;
  const segments = event.message.map(object);
  const mentions = segments.filter((segment) => segment.type === "at")
    .map((segment) => id(object(segment.data).qq));
  if (mentions.includes("all") || !mentions.includes(accountId)) return;
  const text = segments.filter((segment) => segment.type === "text")
    .map((segment) => {
      const value = object(segment.data).text;
      return typeof value === "string" ? value : "";
    }).join("").trim();
  if (!text) return;
  const replyToId = segments.filter((segment) => segment.type === "reply")
    .map((segment) => id(object(segment.data).id)).find(Boolean);
  const milliseconds = Number(event.time) * 1000;
  return {
    id: messageId, accountId, senderId, text, mentions: [...new Set(mentions)],
    address: { kind: "group", conversationId: groupId, senderId },
    receivedAt: new Date(Number.isFinite(milliseconds) && milliseconds > 0 && milliseconds < 8.64e15 ? milliseconds : Date.now()).toISOString(),
    ...(replyToId ? { replyToId } : {}),
  };
}

/** A narrow injectable socket supports protocol tests without a real QQ account or port. */
export interface OneBotSocket {
  readyState: number;
  on(event: "open" | "message" | "close" | "error", listener: (...args: unknown[]) => void): unknown;
  send(data: string, callback?: (error?: Error) => void): void;
  close(): void;
  terminate(): void;
}
interface OneBotDependencies {
  createSocket?: (url: string, options: { headers: Record<string, string>; handshakeTimeout: number; maxPayload: number }) => OneBotSocket;
  requestTimeoutMs?: number;
  retryDelayMs?: number;
  heartbeatIntervalMs?: number;
}
interface PendingRequest {
  resolve: (value: JsonObject) => void;
  reject: (error: RequestFailure) => void;
  timer: ReturnType<typeof setTimeout>;
  sent: boolean;
}
class RequestFailure extends Error {
  constructor(readonly dispatched: boolean) { super("onebot_request_interrupted"); }
}

export class OneBotAdapter implements BotAdapterInstance {
  private readonly abort = new AbortController();
  private readonly onHostAbort = () => { void this.stop().catch(() => undefined); };
  private readonly pending = new Map<string, PendingRequest>();
  private readonly endpoint: string;
  private readonly accountId: string;
  private socket?: OneBotSocket;
  private loop?: Promise<void>;
  private inbound: Promise<void> = Promise.resolve();
  private pendingInbound = 0;
  private receiver?: (message: BotMessage) => Promise<void>;
  private verified = false;
  private fatal = false;
  private connectionError?: string;
  private stopping?: Promise<void>;
  private closeConnection?: () => void;

  constructor(private readonly context: BotAdapterContext, private readonly dependencies: OneBotDependencies = {}) {
    const url = new URL(typeof context.config.endpoint === "string" ? context.config.endpoint : "");
    if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.hash) {
      throw new Error("onebot_invalid_endpoint");
    }
    this.endpoint = url.toString();
    this.accountId = id(context.config.accountId);
    if (!/^\d+$/.test(this.accountId)) throw new Error("onebot_account_id_required");
    context.signal.addEventListener("abort", this.onHostAbort, { once: true });
    if (context.signal.aborted) this.abort.abort();
  }

  async start(receiver: (message: BotMessage) => Promise<void>): Promise<void> {
    if (this.abort.signal.aborted) throw new Error("onebot_stopped");
    if (this.loop) throw new Error("onebot_already_started");
    this.receiver = receiver;
    this.loop = this.run();
    void this.loop.catch(() => undefined);
  }

  private async delay(milliseconds: number): Promise<void> {
    if (this.abort.signal.aborted) return;
    await new Promise<void>((resolve) => {
      const done = () => { clearTimeout(timer); this.abort.signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, milliseconds);
      this.abort.signal.addEventListener("abort", done, { once: true });
    });
  }

  private async run(): Promise<void> {
    let attempts = 0;
    while (!this.abort.signal.aborted && !this.fatal) {
      // Publish the configured account before any frames can arrive. Ingress remains gated by
      // get_login_info verification, so an unexpected NapCat account still cannot deliver messages.
      await this.context.setState(attempts ? "reconnecting" : "connecting", {
        accountId: this.accountId, ...(this.connectionError ? { error: this.connectionError } : {}),
      });
      try {
        const secrets = await this.context.secrets.read();
        if (this.abort.signal.aborted) return;
        const headers: Record<string, string> = secrets.token ? { Authorization: `Bearer ${secrets.token}` } : {};
        const options = {
          headers,
          handshakeTimeout: this.dependencies.requestTimeoutMs ?? 15_000,
          maxPayload: 1_048_576,
        };
        const socket = this.dependencies.createSocket?.(this.endpoint, options)
          ?? new WebSocket(this.endpoint, options) as unknown as OneBotSocket;
        this.socket = socket;
        await this.consume(socket);
      } catch {
        if (this.abort.signal.aborted || this.fatal) return;
        await this.context.setState("reconnecting", { error: "onebot_connection_interrupted" });
      }
      if (this.abort.signal.aborted || this.fatal) return;
      attempts++;
      await this.delay(Math.min(30_000, (this.dependencies.retryDelayMs ?? 1_000) * 2 ** Math.min(attempts - 1, 5)));
    }
  }

  private consume(socket: OneBotSocket): Promise<void> {
    this.verified = false;
    return new Promise<void>((resolve) => {
      let finished = false;
      let heartbeat: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(heartbeat);
        this.verified = false;
        this.closeConnection = undefined;
        this.abort.signal.removeEventListener("abort", terminate);
        if (this.socket === socket) this.socket = undefined;
        for (const [echo, request] of this.pending) {
          clearTimeout(request.timer);
          request.reject(new RequestFailure(request.sent));
          this.pending.delete(echo);
        }
        resolve();
      };
      const terminate = () => {
        try { socket.terminate(); } finally { finish(); }
      };
      const scheduleHeartbeat = () => {
        heartbeat = setTimeout(() => {
          if (finished || this.abort.signal.aborted) return;
          void this.request("get_status", {}).then((result) => {
            if (finished) return;
            if (result.status !== "ok" || Number(result.retcode) !== 0 || object(result.data).online === false) {
              terminate();
              return;
            }
            scheduleHeartbeat();
          }, terminate);
        }, this.dependencies.heartbeatIntervalMs ?? 30_000);
      };
      this.closeConnection = terminate;
      this.abort.signal.addEventListener("abort", terminate, { once: true });
      socket.on("close", finish);
      socket.on("error", terminate);
      socket.on("open", () => {
        void (async () => {
          try {
            const response = await this.request("get_login_info", {});
            if (finished || this.abort.signal.aborted) return;
            if (response.status !== "ok" || Number(response.retcode) !== 0
              || id(object(response.data).user_id) !== this.accountId) {
              this.fatal = true;
              await this.context.setState("error", { error: "onebot_account_mismatch" });
              terminate();
              return;
            }
            this.verified = true;
            await this.context.setState("connected", { accountId: this.accountId });
            this.connectionError = undefined;
            if (!finished) scheduleHeartbeat();
          } catch { terminate(); }
        })();
      });
      socket.on("message", (raw) => {
        if (finished || this.abort.signal.aborted) return;
        let payload: JsonObject;
        try {
          const content = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : "";
          payload = object(JSON.parse(content));
        } catch { return; }
        const echo = id(payload.echo);
        const request = this.pending.get(echo);
        if (request) {
          clearTimeout(request.timer);
          this.pending.delete(echo);
          request.resolve(payload);
          return;
        }
        if (!this.verified) return;
        const message = normalizeOneBotMessage(payload, this.accountId);
        if (!message) return;
        if (this.pendingInbound >= 100) {
          // OneBot has no replay cursor. Bound the not-yet-admitted window and make overload
          // visible; queued frames still drain after reconnection verifies the same account.
          this.connectionError = "onebot_inbound_capacity_reached";
          terminate();
          return;
        }
        this.pendingInbound++;
        // Serialize durable admission, preserving platform event order without blocking socket receipts.
        this.inbound = this.inbound.then(async () => {
          while (!this.abort.signal.aborted && !this.fatal) {
            try { await this.receiver?.(message); return; }
            catch {
              // A host queue/storage failure is independent of transport health. Keep an
              // authenticated connection drainable and retry this frame before later frames.
              try {
                await this.context.setState(this.verified ? "connected" : "reconnecting", {
                  accountId: this.accountId, error: "onebot_message_admission_retrying",
                });
              } catch { /* A host state-store failure is retried with admission. */ }
              await this.delay(this.dependencies.retryDelayMs ?? 1_000);
            }
          }
        }).finally(() => { this.pendingInbound--; });
      });
      if (this.abort.signal.aborted) terminate();
    });
  }

  private request(action: string, params: JsonObject): Promise<JsonObject> {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1 || this.abort.signal.aborted) return Promise.reject(new RequestFailure(false));
    const echo = randomUUID();
    return new Promise<JsonObject>((resolve, reject) => {
      const entry: PendingRequest = {
        resolve, reject, sent: false,
        timer: setTimeout(() => {
          this.pending.delete(echo);
          reject(new RequestFailure(entry.sent));
        }, this.dependencies.requestTimeoutMs ?? 15_000),
      };
      this.pending.set(echo, entry);
      try {
        entry.sent = true;
        socket.send(JSON.stringify({ action, params, echo }), (error) => {
          if (!error || !this.pending.has(echo)) return;
          clearTimeout(entry.timer);
          this.pending.delete(echo);
          reject(new RequestFailure(true));
        });
      } catch {
        clearTimeout(entry.timer);
        this.pending.delete(echo);
        reject(new RequestFailure(false));
      }
    });
  }

  async send(address: BotAddress, text: string, options?: { replyToId?: string }): Promise<BotSendReceipt> {
    if (!this.verified || this.abort.signal.aborted) return { status: "failed", error: "onebot_not_connected", retryable: true };
    if (address.kind !== "group" || !/^\d+$/.test(address.conversationId) || !text.trim() || Array.from(text).length > 2000) {
      return { status: "failed", error: "onebot_invalid_message", retryable: false };
    }
    const message = [
      ...(options?.replyToId ? [{ type: "reply", data: { id: options.replyToId } }] : []),
      { type: "text", data: { text } },
    ];
    try {
      const receipt = await this.request("send_group_msg", { group_id: address.conversationId, message, auto_escape: true });
      if (receipt.status !== "ok" || Number(receipt.retcode) !== 0) {
        return { status: "failed", error: "onebot_send_rejected", retryable: false };
      }
      const messageId = id(object(receipt.data).message_id);
      if (!messageId) return { status: "unknown", error: "onebot_send_receipt_missing", retryable: false };
      return { status: "accepted", messageId };
    } catch (error) {
      const dispatched = error instanceof RequestFailure ? error.dispatched : true;
      return {
        status: dispatched ? "unknown" : "failed",
        error: dispatched ? "onebot_send_receipt_unknown" : "onebot_not_connected",
        retryable: !dispatched,
      };
    }
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.abort.abort();
      this.closeConnection?.();
      this.context.signal.removeEventListener("abort", this.onHostAbort);
      await Promise.allSettled([...(this.loop ? [this.loop] : []), this.inbound]);
      this.receiver = undefined;
      await this.context.setState("stopped");
    })();
    return this.stopping;
  }
}
