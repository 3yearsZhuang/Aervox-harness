import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setImmediate as nextTask } from "node:timers/promises";
import type { BotAdapterContribution, BotAdapterInstance, BotMessage } from "@aervox/host-plugin-api";
import type { BotConnection, BotDelivery, BotPairing, CreateBotConnectionRequest, UpdateBotConnectionRequest } from "@aervox/contracts";
import { botConnectionSchema, botDeliverySchema } from "@aervox/contracts";
import { SqliteBotRepository, type BotConnectionRecord, type BotInboxRecord, type BotLeaseFence, type ProactiveVaultCipher, type SqliteConversationRepository } from "@aervox/repositories";
import { acceptConversationTurn, executeAcceptedConversationTurn, recoverApiOwnedTurn, type ConversationRouteDeps } from "../../companion/conversation/index.js";

const local = () => ({ workspaceId: "local", subjectUserId: "local" });
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const now = () => new Date().toISOString();
const terminal = new Set(["Completed", "Failed", "Interrupted", "Cancelled"]);
const clearPairing = { pairingHash: null, pairingCandidate: null, pairingExpiresAt: null };
export interface RegisteredBotAdapter { pluginId: string; adapter: BotAdapterContribution }
interface RunningConnection { revision: number; abort: AbortController; instance: BotAdapterInstance; adapter: BotAdapterContribution; ready: boolean }
export interface BotManagerOptions {
  store: SqliteBotRepository;
  conversations: SqliteConversationRepository;
  conversationDeps: ConversationRouteDeps;
  cipher: () => Promise<ProactiveVaultCipher>;
  adapters: () => RegisteredBotAdapter[];
  pluginEnabled: (id: string) => Promise<boolean>;
}
export class BotError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }

/** One API host holds each connection lease. All model and transport work happens outside transactions. */
export class BotManager {
  private readonly hostId = randomUUID();
  private readonly running = new Map<string, RunningConnection>();
  private readonly working = new Map<string, Promise<void>>();
  private readonly starting = new Set<Promise<void>>();
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly retryAt = new Map<string, number>();
  private admission: Promise<unknown> = Promise.resolve();
  private timer?: ReturnType<typeof setInterval>;
  private ticking?: Promise<void>;
  private closed = false;
  constructor(private readonly options: BotManagerOptions) {}
  adapters() { return this.options.adapters().map(({ adapter: { create: _create, ...descriptor } }) => descriptor); }
  private registered(adapterId: string) {
    const entry = this.options.adapters().find(item => item.adapter.id === adapterId);
    if (!entry) throw new BotError(400, "bot_adapter_unavailable");
    const max = entry.adapter.capabilities.maxTextLength;
    if (!Number.isSafeInteger(max) || max < 1 || max > 32_000) throw new BotError(400, "bot_adapter_invalid_capabilities");
    return entry;
  }
  private async required(id: string) {
    const row = await this.options.store.getConnection(id);
    if (!row) throw new BotError(404, "bot_connection_not_found");
    return row;
  }
  private async publicConnection(row: BotConnectionRecord): Promise<BotConnection> {
    let hasCredentials = false;
    if (row.secretCipher) {
      try {
        const secrets = JSON.parse((await this.options.cipher()).decrypt(row.secretCipher, row.id));
        hasCredentials = typeof secrets.token === "string" && secrets.token.length > 0;
      } catch { /* The lifecycle reports vault failures without returning cipher content. */ }
    }
    return botConnectionSchema.parse({ ...row, config: JSON.parse(row.configJson),
      ownerSenderId: row.ownerSenderId ?? undefined, hasCredentials, lastError: row.lastError ?? undefined });
  }
  async list() { return Promise.all((await this.options.store.listConnections()).map(row => this.publicConnection(row))); }
  async create(input: CreateBotConnectionRequest) {
    const { pluginId } = this.registered(input.adapterId);
    const id = `bot_${randomUUID()}`;
    const cipher = await this.options.cipher();
    const row = await this.options.store.createConnection({ id, pluginId, adapterId: input.adapterId,
      displayName: input.displayName, enabled: input.enabled ?? false, configJson: JSON.stringify(input.config ?? {}),
      secretCipher: input.secretValues?.token ? cipher.encrypt(JSON.stringify(input.secretValues), id) : null, createdAt: now() });
    await this.reconcile();
    return this.publicConnection(await this.required(row.id));
  }
  async update(id: string, input: UpdateBotConnectionRequest) {
    const row = await this.required(id);
    if (row.revision !== input.revision) throw new BotError(409, "bot_connection_revision_conflict");
    const cipher = await this.options.cipher();
    const patch: Partial<BotConnectionRecord> = { state: "stopped", lastError: null, ...clearPairing };
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.displayName !== undefined) patch.displayName = input.displayName;
    if (input.config !== undefined) {
      patch.configJson = JSON.stringify(input.config);
      const previous = JSON.parse(row.configJson);
      if (previous.accountId !== input.config.accountId || previous.endpoint !== input.config.endpoint) {
        patch.ownerSenderId = null; patch.accountId = null; patch.checkpointCipher = null;
        patch.secretCipher = null;
      }
    }
    if (input.secretValues?.token !== undefined) {
      // Auth replacement intentionally drops account-scoped cursors/context credentials and owner pairing.
      patch.secretCipher = input.secretValues.token ? cipher.encrypt(JSON.stringify({ token: input.secretValues.token }), id) : null;
      patch.checkpointCipher = null; patch.ownerSenderId = null; patch.accountId = null;
    }
    const saved = await this.options.store.updateConnection(id, row.revision, patch);
    if (!saved) throw new BotError(409, "bot_connection_revision_conflict");
    this.retryAt.delete(id);
    await this.stopConnection(id);
    await this.reconcile();
    return this.publicConnection(await this.required(id));
  }
  async remove(id: string) {
    await this.required(id);
    // Remove the durable activation target before awaiting network shutdown. A concurrent
    // stale PATCH cannot re-enable it while deletion is draining the old instance.
    const deletion = this.admission.then(() => this.options.store.deleteConnection(id));
    this.admission = deletion.catch(() => undefined);
    await deletion;
    await this.stopConnection(id);
  }
  async stopPlugin(pluginId: string, uninstall = false) {
    for (const row of await this.options.store.listConnections()) {
      if (row.pluginId !== pluginId) continue;
      await this.options.store.revokeConnection(row.id, uninstall);
      await this.stopConnection(row.id);
    }
  }
  async start() {
    if (this.closed || this.timer) return;
    await this.reconcile();
    this.timer = setInterval(() => { void this.reconcile().catch(() => undefined); }, 1000);
    this.timer.unref();
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await this.ticking;
    await Promise.all([...this.running.keys()].map(id => this.stopConnection(id)));
    await Promise.all([...this.stopping.values(), ...this.starting, ...this.working.values()]);
  }
  private async stopConnection(id: string, state = "stopped") {
    const stopping = this.stopping.get(id);
    if (stopping) return stopping;
    const active = this.running.get(id);
    this.running.delete(id); active?.abort.abort();
    const operation = (async () => {
      // Fence storage before waiting on transport callbacks; an acknowledgement after
      // this point cannot turn an uncertain delivery into an accepted one.
      await this.options.store.markInterruptedSends(id, this.hostId);
      await this.options.store.releaseLease(id, this.hostId, state);
      await this.options.store.markInterruptedSends(id, null);
      if (active) {
        for (const item of await this.options.store.listPending(id)) if (item.turnId) await this.cancelTurn(item.turnId);
        await active.instance.stop().catch(() => undefined);
      }
    })().finally(() => this.stopping.delete(id));
    this.stopping.set(id, operation);
    return operation;
  }
  private fence(id: string, active: RunningConnection): BotLeaseFence { return { connectionId: id, revision: active.revision, owner: this.hostId }; }
  private async valid(id: string, active: RunningConnection) {
    if (this.closed || active.abort.signal.aborted || this.running.get(id) !== active) return null;
    const row = await this.options.store.getConnection(id);
    if (!row || !row.enabled || row.revision !== active.revision || row.leaseOwner !== this.hostId || !row.leaseUntil || row.leaseUntil <= now()) return null;
    return await this.options.pluginEnabled(row.pluginId) ? row : null;
  }
  async reconcile() {
    if (this.closed) return;
    if (this.ticking) return this.ticking;
    this.ticking = this.tick().finally(() => { this.ticking = undefined; });
    return this.ticking;
  }
  private async tick() {
    for (const row of await this.options.store.listConnections()) {
      const active = this.running.get(row.id);
      const enabled = row.enabled && await this.options.pluginEnabled(row.pluginId);
      if (active && (!enabled || active.revision !== row.revision || active.abort.signal.aborted)) await this.stopConnection(row.id);
      if (!enabled || this.closed) {
        if (row.enabled && !enabled && row.lastError !== "bot_plugin_unavailable") await this.options.store.updateConnection(row.id, row.revision, { state: "error", lastError: "bot_plugin_unavailable", ...clearPairing });
        continue;
      }
      if ((this.retryAt.get(row.id) ?? 0) > Date.now()) continue;
      if (this.stopping.has(row.id)) continue;
      const leasing = this.admission.then(() => this.options.store.acquireLease(row.id, this.hostId, now(), new Date(Date.now() + 30_000).toISOString(), row.revision));
      this.admission = leasing.catch(() => undefined);
      const lease = await leasing;
      if (!lease) { await this.stopConnection(row.id); continue; }
      if (!this.running.has(row.id)) {
        try { await this.activate(lease); }
        catch { await this.startFailed(row.id, row.revision); }
      }
      const current = this.running.get(row.id);
      if (!current || current.abort.signal.aborted || !current.ready) continue;
      for (const command of await this.options.store.listPendingControls(row.id)) {
        if (command.connectionRevision === row.revision && this.authorized(row, JSON.parse(command.messageJson))) {
          await this.applyCancel(command, current);
        }
      }
      if ((await this.valid(row.id, current))?.state !== "connected") continue;
      const seen = new Set<string>();
      for (const item of await this.options.store.listPending(row.id)) {
        if (seen.has(item.sessionId)) continue;
        seen.add(item.sessionId);
        if (this.working.size >= 4 || this.working.has(item.sessionId)) continue;
        // Each session starts in its own event-loop task, so synchronous local SQLite
        // commits finish before another session begins. Model/network waits still overlap.
        const job = nextTask().then(() => this.process(current, item)).catch(async () => {
          if (await this.valid(row.id, current)) {
            await this.options.store.updateInbox(item.id, { state: "failed", lastError: "bot_processing_failed" }, this.fence(row.id, current));
            await this.options.store.writeRuntime(row.id, current.revision, this.hostId, { lastError: "bot_processing_failed" });
          }
        }).finally(() => this.working.delete(item.sessionId));
        this.working.set(item.sessionId, job);
      }
    }
  }
  private async startFailed(id: string, revision: number) {
    this.retryAt.set(id, Date.now() + 15_000);
    await this.options.store.writeRuntime(id, revision, this.hostId, { state: "error", lastError: "bot_adapter_start_failed" });
    await this.stopConnection(id, "error");
  }
  private async activate(row: BotConnectionRecord) {
    const { adapter } = this.registered(row.adapterId);
    const abort = new AbortController();
    const cipher = await this.options.cipher();
    const active = { revision: row.revision, abort, adapter, ready: false } as RunningConnection;
    const read = async (field: "secretCipher" | "checkpointCipher") => {
      const current = await this.valid(row.id, active);
      if (!current) throw new Error("bot_connection_inactive");
      return current[field] ? JSON.parse(cipher.decrypt(current[field], row.id)) : {};
    };
    const write = async (field: "secretCipher" | "checkpointCipher", value: Record<string, unknown>) => {
      if (!await this.valid(row.id, active)) throw new Error("bot_connection_inactive");
      if (!await this.options.store.writeRuntime(row.id, row.revision, this.hostId, { [field]: cipher.encrypt(JSON.stringify(value), row.id) })) throw new Error("bot_connection_reconfigured");
    };
    active.instance = adapter.create({ connectionId: row.id, config: JSON.parse(row.configJson), signal: abort.signal,
      secrets: { read: () => read("secretCipher"), write: value => write("secretCipher", value) },
      checkpoint: { read: () => read("checkpointCipher"), write: value => write("checkpointCipher", value) },
      setState: async (state, detail) => {
        const current = await this.valid(row.id, active); if (!current) return;
        const changedAccount = Boolean(detail?.accountId && current.accountId && current.accountId !== detail.accountId);
        if (changedAccount) {
          const saved = await this.options.store.writeRuntime(row.id, row.revision, this.hostId, {
            revision: row.revision + 1, state: "connecting", accountId: detail!.accountId,
            ownerSenderId: null, checkpointCipher: null, lastError: null, ...clearPairing,
          });
          if (saved) active.abort.abort();
          return;
        }
        await this.options.store.writeRuntime(row.id, row.revision, this.hostId, { state, lastError: detail?.error ?? null,
          ...(detail?.accountId ? { accountId: detail.accountId } : {}) });
      },
    });
    this.running.set(row.id, active);
    await this.options.store.markInterruptedSends(row.id, this.hostId);
    await this.options.store.writeRuntime(row.id, row.revision, this.hostId, { state: "connecting", lastError: null });
    const startup = Promise.resolve().then(() => active.instance.start(message => this.receive(row.id, active, message)))
      .then(() => { active.ready = true; })
      .catch(async () => { if (await this.valid(row.id, active)) await this.startFailed(row.id, row.revision); })
      .finally(() => this.starting.delete(startup));
    this.starting.add(startup);
  }
  private authorized(row: BotConnectionRecord, message: BotMessage) {
    if (!row.accountId || row.accountId !== message.accountId || message.senderId === message.accountId) return false;
    if (message.address.kind === "direct") return row.ownerSenderId === message.senderId;
    const config = JSON.parse(row.configJson);
    return Array.isArray(config.allowedGroupIds) && config.allowedGroupIds.includes(message.address.conversationId)
      && message.mentions.includes(message.accountId);
  }
  private async receive(id: string, active: RunningConnection, message: BotMessage) {
    const row = await this.valid(id, active); if (!row) return;
    if (!message.id || !message.senderId || !message.accountId || message.address.senderId !== message.senderId
      || message.senderId === message.accountId || !message.address.conversationId || message.text.length > 32_000 || !message.text.trim()) return;
    if (message.address.kind === "direct" ? !active.adapter.capabilities.directMessages : !active.adapter.capabilities.groupMessages) return;
    if (message.address.kind === "direct" && row.pairingHash && row.pairingExpiresAt && row.pairingExpiresAt > now()
      && message.accountId === row.accountId && hash(message.text.trim()) === row.pairingHash) {
      await this.options.store.recordPairingCandidate(id, row.revision, this.hostId, row.pairingHash, message.senderId);
      return;
    }
    if (!this.authorized(row, message)) return;
    const eventId = `bi_${hash(JSON.stringify([id, message.accountId, message.id]))}`;
    if (await this.options.store.getInbox(eventId)) return;
    const routeKey = JSON.stringify([message.accountId, message.address.kind, message.address.conversationId, message.senderId]);
    const sessionId = `bs_${hash(id + routeKey)}`;
    const isCancel = message.text.trim() === "/cancel";
    const policy = message.address.kind === "group" ? "bot-group-member-v1" : "bot-owner-v1";
    await this.options.conversations.getOrCreateSession(local(), sessionId, `Bot · ${message.address.kind}`, undefined, policy);
    await this.options.store.bindSession(id, routeKey, sessionId);
    const item = await this.options.store.enqueue({ id: eventId, connectionId: id, sessionId,
      messageJson: JSON.stringify(isCancel ? { ...message, text: "/cancel" } : message),
      connectionRevision: row.revision, createdAt: now(), state: "queued" }, this.fence(id, active), isCancel);
    if (!item) return;
    if (isCancel) {
      await this.applyCancel(item, active);
      await this.makeReply(item, "已请求取消本会话当前回合。", active);
    }
  }
  private async cancelTurn(turnId: string) {
    const attempts = await this.options.conversations.listTurnAttempts(local(), turnId);
    const running = attempts.find(attempt => attempt.status === "Running");
    if (running) await this.options.conversations.requestCancelTurnAttempt(local(), { turnId, attemptId: running.id });
  }
  private async applyCancel(item: BotInboxRecord, active: RunningConnection) {
    const cancellation = this.admission.then(() => this.options.store.cancelBefore(item.id, this.fence(item.connectionId, active)));
    this.admission = cancellation.catch(() => undefined);
    await cancellation;
  }
  private async process(active: RunningConnection, item: BotInboxRecord) {
    const row = await this.valid(item.connectionId, active);
    if (!row) return;
    const fresh = await this.options.store.getInbox(item.id);
    if (!fresh || ["deleted", "cancelled", "superseded"].includes(fresh.state)) return;
    const message = JSON.parse(fresh.messageJson) as BotMessage;
    const fence = this.fence(item.connectionId, active);
    if (fresh.connectionRevision !== row.revision || !this.authorized(row, message)) {
      await this.options.store.updateInbox(item.id, { state: "superseded", lastError: "bot_binding_changed" }, fence); return;
    }
    const isCancel = message.text.trim() === "/cancel";
    if (isCancel && !fresh.turnId) {
      // Recovery also completes a command admitted just before a process exit.
      // Cancellation is idempotent and creates no model Turn.
      if (fresh.state !== "responding") await this.applyCancel(item, active);
      await this.makeReply(item, "已请求取消本会话当前回合。", active);
      if (!await this.options.store.updateInbox(item.id, { state: "responding" }, fence)) return;
    }
    if (!isCancel && fresh.state !== "responding") {
      const turnId = fresh.turnId ?? `bt_${hash(item.id)}`;
      const ctx = local();
      // Serialize short acceptance transactions on this host; model work still runs
      // concurrently across sessions and SQLite remains the durable admission owner.
      const acceptance = this.admission.then(async () => {
        const latest = await this.options.store.getInbox(item.id);
        if (!latest || !["queued", "processing"].includes(latest.state) || !await this.valid(item.connectionId, active)) return null;
        return acceptConversationTurn(this.options.conversations, ctx, {
          turnId, sessionId: item.sessionId, idempotencyKey: `bot:${item.id}`, attemptId: `atp_${turnId}`,
          message: { id: `msg_${turnId}`, content: message.text }, consumeInbox: false,
        });
      });
      this.admission = acceptance.catch(() => undefined);
      const accepted = await acceptance;
      if (!accepted) return;
      // Let already queued acceptance/control commits finish before model-side writes.
      await this.admission;
      if (!await this.valid(item.connectionId, active)
        || !await this.options.store.updateInbox(item.id, { state: "processing", turnId }, fence)) return;
      const recovery = await recoverApiOwnedTurn(this.options.conversations, turnId);
      if (recovery === "active") return;
      if (recovery === "unclaimed") {
        if (terminal.has(accepted.turn.status)) return;
        const attempt = (await this.options.conversations.listTurnAttempts(ctx, turnId))[0];
        if (!attempt) return;
        await executeAcceptedConversationTurn(this.options.conversations, ctx,
          { turnId, sessionId: item.sessionId, attemptId: attempt.id, userMessage: message.text }, this.options.conversationDeps);
      }
      const turn = await this.options.conversations.getTurn(ctx, turnId);
      if (!turn || !terminal.has(turn.status)) return;
      if (!await this.valid(item.connectionId, active) || ["deleted", "cancelled", "superseded"].includes((await this.options.store.getInbox(item.id))?.state ?? "deleted")) return;
      const events = await this.options.conversations.getStreamEvents(ctx, turnId, 0);
      const currentAttempt = (await this.options.conversations.listTurnAttempts(ctx, turnId))[0];
      const visible = events.filter(event => event.attemptId === currentAttempt?.id);
      const withdrawn = visible.some(event => event.eventType === "redacted" || event.safetyDecision === "blocked");
      const text = (withdrawn ? [] : visible).filter(event => event.eventType === "delta" && (event.safetyDecision === "approved" || event.safetyDecision === "redacted"))
        .map(event => { const data = event.data as { text?: unknown }; return typeof data?.text === "string" ? data.text : ""; }).join("");
      const suffix = turn.status === "Interrupted" ? "\n回合已中断或需要审批，请在思隅工作台处理后重新发送。"
        : turn.status === "Failed" ? "\n本次处理失败，请稍后重试。" : turn.status === "Cancelled" ? "\n回合已取消。" : "";
      await this.makeReply(item, (text + suffix).trim() || "回合已完成，请在思隅工作台查看。", active);
      if (!await this.options.store.updateInbox(item.id, { state: "responding" }, fence)) return;
    }
    for (const part of await this.options.store.deliveryParts(item.id)) {
      if (part.status === "accepted") continue;
      // A missing receipt blocks every subsequent segment. Only an explicit retry
      // may requeue the uncertain segment, so restart never guesses delivery.
      if (part.status !== "queued") break;
      const current = await this.valid(item.connectionId, active);
      if (!current || !this.authorized(current, message) || ["deleted", "cancelled", "superseded"].includes((await this.options.store.getInbox(item.id))?.state ?? "deleted")) return;
      if (!await this.options.store.updateDelivery(part.id, { status: "sending" }, "queued", fence)) break;
      if (!await this.valid(item.connectionId, active)) return;
      try {
        const receipt = await active.instance.send(message.address, part.text, { replyToId: message.id });
        if (!await this.valid(item.connectionId, active)) return;
        await this.options.store.updateDelivery(part.id, { status: receipt.status, platformMessageId: receipt.messageId ?? null, lastError: receipt.error ?? null }, "sending", fence);
      } catch {
        if (!await this.valid(item.connectionId, active)) return;
        await this.options.store.updateDelivery(part.id, { status: "unknown", lastError: "bot_send_without_receipt" }, "sending", fence);
      }
      const delivered = (await this.options.store.deliveryParts(item.id)).find(value => value.id === part.id);
      if (delivered?.status !== "accepted") break;
    }
    const parts = await this.options.store.deliveryParts(item.id);
    if (parts.length > 0 && parts.every(part => part.status === "accepted")) await this.options.store.updateInbox(item.id, { state: "done" }, fence);
    else if (parts.some(part => part.status === "failed" || part.status === "unknown")) {
      await this.options.store.updateInbox(item.id, { state: "delivery_failed" }, fence);
    }
  }
  private async makeReply(item: BotInboxRecord, text: string, active: RunningConnection) {
    if ((await this.options.store.getInbox(item.id))?.state === "deleted") return;
    const maxLength = active.adapter.capabilities.maxTextLength;
    const points = Array.from(text); const rows = [];
    for (let start = 0; start < points.length; start += maxLength) {
      const partIndex = Math.floor(start / maxLength);
      rows.push({ id: `bd_${hash(`${item.id}:${partIndex}`)}`, connectionId: item.connectionId, inboxId: item.id,
        partIndex, text: points.slice(start, start + maxLength).join(""), createdAt: now() });
    }
    await this.options.store.addDeliveries(rows, this.fence(item.connectionId, active));
  }
  private async live(id: string) {
    const row = await this.required(id);
    if (!row.enabled) throw new BotError(409, "bot_enable_connection_first");
    await this.reconcile();
    const active = this.running.get(id);
    if (!active || !await this.valid(id, active)) throw new BotError(409, "bot_connection_not_active");
    return active;
  }
  async login(id: string, begin: boolean) {
    const active = await this.live(id);
    const operation = begin ? active.instance.beginLogin : active.instance.pollLogin;
    if (!operation) throw new BotError(400, "bot_login_not_supported");
    return operation.call(active.instance);
  }
  async beginPairing(id: string): Promise<BotPairing> {
    const active = await this.live(id);
    if (!active.adapter.capabilities.directMessages) throw new BotError(400, "bot_pairing_not_supported");
    const code = `SIYU-${randomBytes(12).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    if (!await this.options.store.writeRuntime(id, active.revision, this.hostId, {
      pairingHash: hash(code), pairingExpiresAt: expiresAt, pairingCandidate: null,
    })) throw new BotError(409, "bot_connection_reconfigured");
    return { code, expiresAt, confirmed: false };
  }
  async pairing(id: string): Promise<BotPairing> {
    const row = await this.required(id);
    return { confirmed: Boolean(row.ownerSenderId), ...(row.pairingExpiresAt && row.pairingExpiresAt > now()
      ? { expiresAt: row.pairingExpiresAt, candidateSenderId: row.pairingCandidate ?? undefined } : {}) };
  }
  async confirmPairing(id: string, senderId: string): Promise<BotPairing> {
    const row = await this.required(id);
    if (!row.enabled || !row.pairingHash || !row.pairingExpiresAt || row.pairingExpiresAt <= now() || row.pairingCandidate !== senderId || !row.accountId) throw new BotError(409, "bot_pairing_invalid_or_expired");
    const active = await this.live(id);
    const saved = await this.options.store.confirmPairing(this.fence(id, active), row.accountId, row.pairingHash, senderId);
    if (!saved) throw new BotError(409, "bot_connection_revision_conflict");
    await this.stopConnection(id); await this.reconcile();
    return { confirmed: true };
  }
  async deliveries(id: string): Promise<BotDelivery[]> {
    await this.required(id);
    return (await this.options.store.listDeliveries(id)).map(part => botDeliverySchema.parse({ ...part,
      platformMessageId: part.platformMessageId ?? undefined, lastError: part.lastError ?? undefined }));
  }
  async retry(id: string, deliveryId: string) {
    const row = await this.required(id);
    const delivery = await this.options.store.getDelivery(id, deliveryId);
    if (!delivery || !["failed", "unknown"].includes(delivery.status)) throw new BotError(409, "bot_delivery_not_retryable");
    const item = await this.options.store.getInbox(delivery.inboxId);
    if (!item || ["deleted", "cancelled", "superseded"].includes(item.state) || item.connectionRevision !== row.revision || !this.authorized(row, JSON.parse(item.messageJson))) throw new BotError(409, "bot_binding_changed");
    if ((await this.options.store.deliveryParts(item.id)).some(part => part.partIndex < delivery.partIndex && part.status !== "accepted")) throw new BotError(409, "bot_prior_delivery_unresolved");
    const active = await this.live(id);
    const fence = this.fence(id, active);
    if (!await this.options.store.updateDelivery(deliveryId, { status: "queued", lastError: null }, delivery.status, fence)) throw new BotError(409, "bot_delivery_not_retryable");
    await this.options.store.updateInbox(item.id, { state: "responding" }, fence);
    const updated = await this.options.store.getDelivery(id, deliveryId);
    if (!updated) throw new BotError(404, "bot_delivery_not_found");
    return botDeliverySchema.parse({ ...updated, platformMessageId: updated.platformMessageId ?? undefined,
      lastError: updated.lastError ?? undefined });
  }
  /** Deterministic integration tests can wait for already dispatched work without timing sleeps. */
  async settle() {
    await this.reconcile();
    if (this.starting.size) {
      await Promise.all([...this.starting]);
      await this.reconcile();
    }
    await Promise.all([...this.working.values()]);
  }
}
