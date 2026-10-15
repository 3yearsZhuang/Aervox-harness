/** Transport-only Bot contributions. Admission, persistence and model execution belong to the host. */
export interface BotAddress {
  kind: "direct" | "group";
  conversationId: string;
  senderId: string;
}

export interface BotMessage {
  id: string;
  accountId: string;
  senderId: string;
  address: BotAddress;
  text: string;
  mentions: string[];
  receivedAt: string;
  replyToId?: string;
}

/** Accepted means the platform acknowledged the message, not that a human read it. */
export interface BotSendReceipt {
  status: "accepted" | "failed" | "unknown";
  messageId?: string;
  error?: string;
  retryable?: boolean;
}

export type BotConnectionState =
  | "stopped"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "login_required"
  | "error";

/** QR content is rendered locally; protocol polling tokens and session credentials stay private. */
export interface BotLoginResult {
  status: "waiting" | "scanned" | "confirmed" | "expired";
  qrCodeUrl?: string;
  expiresAt?: string;
  accountId?: string;
}

export interface BotAdapterContext {
  connectionId: string;
  config: Readonly<Record<string, unknown>>;
  signal: AbortSignal;
  /** Scoped encrypted storage. Writes replace the connection's complete secret map. */
  secrets: {
    read(): Promise<Record<string, string>>;
    write(value: Record<string, string>): Promise<void>;
  };
  /** Non-secret protocol progress only. Advance after onMessage resolves (durable admission). */
  checkpoint: {
    read(): Promise<Record<string, unknown>>;
    write(value: Record<string, unknown>): Promise<void>;
  };
  /** Error strings must be static/sanitized; never include response bodies or credentials. */
  setState(
    state: BotConnectionState,
    detail?: { accountId?: string; error?: string },
  ): void | Promise<void>;
}

export interface BotAdapterInstance {
  /** Returns after startup; the receiver resolves only after the host durably admits/rejects an event. */
  start(onMessage: (message: BotMessage) => Promise<void>): Promise<void>;
  send(address: BotAddress, text: string, options?: { replyToId?: string }): Promise<BotSendReceipt>;
  /** Cancels requests, reconnect timers and callbacks; resolves after all transport work stops. */
  stop(): Promise<void>;
  beginLogin?(): Promise<BotLoginResult>;
  pollLogin?(): Promise<BotLoginResult>;
}

export interface BotAdapterContribution {
  id: string;
  platform: string;
  displayName: string;
  capabilities: {
    directMessages: boolean;
    groupMessages: boolean;
    login: boolean;
    /** Maximum Unicode code points in a host-generated text segment. */
    maxTextLength: number;
  };
  create(context: BotAdapterContext): BotAdapterInstance;
}
