/**
 * Aervox｜思隅 @aervox/repositories — 局域网设备发现：UDP 多播信标 + 静态对端列表（ITER-028）
 *
 * ## 这是什么（以及**不是**什么）
 * - **是**：一个极小的 UDP 多播（multicast）信标发现层——周期性向可配置的多播组/端口发送
 *   明文 JSON 信标，收到信标即登记对端，超过 TTL 未刷新即过期移除。
 * - **不是** mDNS / DNS-SD / Bonjour：不构造或解析任何 DNS 报文，不做 `_services._dns-sd._udp`
 *   查询，也不声明 SRV/TXT 记录。`P2P_SERVICE_TYPE` 只是与未来 mDNS 实现对齐的服务类型
 *   **字符串常量**，当前仅作为信标内的自描述字段，没有任何 DNS 语义。
 *   （同日更正：探索文档此前把 `_aervox-sync._tcp` 描述为 mDNS 服务类型，措辞已同步修订。）
 *
 * ## 明确不保证（诚实边界，勿默认已覆盖）
 * - 多播在部分网络 / CI / 容器 / 开了 AP 隔离（client isolation）的环境下**不可用或不可靠**：
 *   丢包、被过滤、`addMembership` 抛错都属正常现象。因此多播被视为**尽力而为的优化**，
 *   失败只上报不崩溃；`multicast: false` 时完全不创建 socket，仅使用静态对端列表兜底。
 * - **发现结果不构成任何信任**：信标是明文、可伪造、可重放（局域网内任何人可广播任意描述符）。
 *   设备身份必须在 `p2p-transport` 的承诺-揭示握手 + 6 位 SAS 人工比对 + 指纹固定（TOFU）
 *   之后才成立。"出现在 `listPeers()` 里"绝不等于"该对端可信"。
 * - 收到的信标里 `device.host` 一律**不采信**：对端地址取报文源地址（`rinfo.address`）；
 *   对端自报 TTL 只能**缩短**存活时间，绝不允许超过本地 `peerTtlMs`（防止对端把自己变成永久在线）。
 * - 未实现：在线/离线事件队列与重连、跨网段发现、IPv6 多播、mDNS/SRV、信标鉴权与加密、
 *   对端身份指纹校验（属于握手层职责）。
 */
import dgram from "node:dgram";
import {
  P2P_PROTOCOL_VERSION,
  createDeviceDescriptor,
  type P2PDeviceDescriptor,
  type P2PDeviceIdentity,
} from "./p2p-pairing.js";

/**
 * 服务类型**字符串常量**（与未来 mDNS/DNS-SD 实现对齐用）。
 * 当前**没有**任何 DNS 语义：本模块不会注册或查询该服务类型。
 */
export const P2P_SERVICE_TYPE = "_aervox-sync._tcp";

/** 信标载荷魔数：用于快速拒绝非本协议报文（长度/字段校验之外的第一道闸） */
export const P2P_DISCOVERY_BEACON_MAGIC = "aervox-p2p-discovery";

/** 信标**格式**版本（与 `P2P_PROTOCOL_VERSION` 区分：后者是设备/配对协议版本） */
export const P2P_DISCOVERY_BEACON_VERSION = 1;

/** 默认多播组（管理范围 239.0.0.0/8，不会外泄到公网）与端口 */
export const P2P_DISCOVERY_DEFAULT_GROUP = "239.255.42.99";
export const P2P_DISCOVERY_DEFAULT_PORT = 48201;

/** 默认发送间隔与本地对端存活上限 */
export const P2P_DISCOVERY_DEFAULT_BEACON_INTERVAL_MS = 2_000;
export const P2P_DISCOVERY_DEFAULT_PEER_TTL_MS = 8_000;

/** 绝对下限：即使本地 TTL 配得再小，也不接受低于该值的存活时间（避免抖动误判掉线） */
export const P2P_DISCOVERY_MIN_PEER_TTL_MS = 100;

/** 单个信标载荷的硬上限（编码与解码两侧都强制，拒绝超长/畸形报文） */
export const P2P_DISCOVERY_MAX_BEACON_BYTES = 4_096;

/** 默认 socket 绑定/关闭/发送的兜底超时（毫秒），避免回调不触发时永久悬挂 */
export const P2P_DISCOVERY_DEFAULT_BIND_TIMEOUT_MS = 3_000;
export const P2P_DISCOVERY_DEFAULT_SEND_TIMEOUT_MS = 1_000;
export const P2P_DISCOVERY_DEFAULT_CLOSE_TIMEOUT_MS = 1_000;

const MAX_DEVICE_ID_CHARS = 128;
const MAX_DEVICE_NAME_CHARS = 200;
const MAX_PUBLIC_KEY_BYTES = 4_096;
const MAX_FINGERPRINT_CHARS = 128;
const MAX_HOST_CHARS = 255;

/** 发现层错误码（fail-closed：无法解析/无法绑定时明确抛出，绝不静默降级） */
export type P2PDiscoveryErrorCode =
  | "beacon_not_json"
  | "beacon_too_large"
  | "beacon_malformed"
  | "beacon_invalid_fields"
  | "invalid_options"
  | "socket_bind_failed"
  | "socket_bind_timeout"
  | "socket_error";

/** 发现层错误：所有失败路径都带显式 code，调用方可据此决定是否降级到静态对端模式 */
export class P2PDiscoveryError extends Error {
  readonly code: P2PDiscoveryErrorCode;

  constructor(code: P2PDiscoveryErrorCode, message: string) {
    super(message);
    this.name = "P2PDiscoveryError";
    this.code = code;
  }
}

/**
 * 信标记录：设备描述符 + 信标格式版本 + 建议存活时间。
 * 只有 `device.protocolVersion === P2P_PROTOCOL_VERSION` 的信标才会被接受（版本不兼容即忽略）。
 */
export interface P2PDiscoveryBeacon {
  magic: string;
  beaconVersion: number;
  serviceType: string;
  device: P2PDeviceDescriptor;
  /** 发送方**建议**的存活时间；接收端只会用它来缩短，不会超过本地 `peerTtlMs` */
  ttlMs: number;
  /** 发送时刻（ISO-8601，仅用于诊断；过期判定一律用接收端本地时钟） */
  sentAt: string;
}

/** 已发现对端（`source` 标明该地址来自信标还是静态声明） */
export interface P2PDiscoveredPeer {
  /** 对端描述符；`host` 已被替换为**报文源地址**，绝不使用对端自报的 host */
  device: P2PDeviceDescriptor;
  /** 地址来源：`beacon` 为多播/单播信标；`static` 为调用方显式声明的地址列表 */
  source: "beacon" | "static";
  /** 最近一次收到的本地时刻（毫秒，来自注入时钟） */
  lastSeenMs: number;
  lastSeenAt: string;
  /** 本次登记时使用的存活时长（毫秒） */
  ttlMs: number;
  /** 过期时刻（毫秒）；静态对端为 `Number.POSITIVE_INFINITY`（永不过期） */
  expiresAtMs: number;
  /** 是否为过期对端（`listPeers()` 只返回未过期对端，故正常运行下恒为 false） */
  expired: boolean;
}

/** 静态对端声明（多播不可用时的兜底地址列表；**不含**任何信任语义） */
export interface P2PStaticPeer {
  host: string;
  /** 对端 TCP 同步服务端口 */
  port: number;
  deviceId?: string;
  deviceName?: string;
  fingerprint?: string;
  publicKey?: string;
}

/** 多播报文的源信息（`dgram` 的 rinfo 子集，便于测试注入） */
export interface P2PDiscoveryRemoteInfo {
  address: string;
  port: number;
  family?: string;
  size?: number;
}

/**
 * 发现层实际使用的最小 socket 接口（`dgram.Socket` 的子集）。
 * 抽出接口只为**测试注入假 socket**；生产环境一律使用 `dgram.createSocket`。
 */
export interface P2PDiscoverySocket {
  on(event: "message", listener: (msg: Buffer, rinfo: P2PDiscoveryRemoteInfo) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "listening" | "close", listener: () => void): unknown;
  removeAllListeners(event?: string): unknown;
  listenerCount(event: string): number;
  bind(port: number, callback?: () => void): unknown;
  addMembership(group: string, interfaceAddress?: string): void;
  dropMembership(group: string, interfaceAddress?: string): void;
  setMulticastTTL(ttl: number): number;
  send(msg: Buffer, port: number, address: string, callback?: (error: Error | null) => void): void;
  close(callback?: () => void): unknown;
  unref?(): void;
}

/** 发现层配置 */
export interface P2PDiscoveryOptions {
  identity: P2PDeviceIdentity;
  /** 本机 TCP 同步服务对外公布的地址与端口（端口可由 `setLocalEndpoint` 在服务启动后更新） */
  host: string;
  port: number;
  /** 是否启用多播（默认 true）；false 时只使用静态对端列表，完全不创建 socket */
  multicast?: boolean;
  group?: string;
  discoveryPort?: number;
  /** 加入多播组的网卡地址列表；为空时使用系统默认路由（多网卡主机建议显式指定） */
  interfaces?: string[];
  beaconIntervalMs?: number;
  /** 本地对端存活上限；对端自报 TTL 只能在此范围内缩短 */
  peerTtlMs?: number;
  staticPeers?: P2PStaticPeer[];
  /** 注入 socket 工厂（仅供测试；生产勿传） */
  socketFactory?: () => P2PDiscoverySocket;
  /** 注入时钟（仅供测试；默认 `Date.now`） */
  now?: () => number;
  onPeer?: (peer: P2PDiscoveredPeer) => void;
  onPeerExpired?: (peer: P2PDiscoveredPeer) => void;
  /** 错误上报（多播不可用、坏信标等一律走这里，绝不抛出到调用方） */
  onError?: (error: Error) => void;
  maxBeaconBytes?: number;
  bindTimeoutMs?: number;
  sendTimeoutMs?: number;
  closeTimeoutMs?: number;
}

// ---------------------------------------------------------------------------
// 信标编解码（长度受限 + 字段校验，绝不相信对端数据）
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 读取有界字符串：类型必须正确、非空（可选）、长度不超过上限 */
function readBoundedString(
  record: Record<string, unknown>,
  field: string,
  options: { maxChars: number; allowEmpty?: boolean },
): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new P2PDiscoveryError("beacon_invalid_fields", `信标字段 ${field} 必须是字符串`);
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new P2PDiscoveryError("beacon_invalid_fields", `信标字段 ${field} 不能为空`);
  }
  if (value.length > options.maxChars) {
    throw new P2PDiscoveryError(
      "beacon_invalid_fields",
      `信标字段 ${field} 超长：${value.length} > ${options.maxChars}`,
    );
  }
  return value;
}

/** 校验并重建设备描述符（只保留已知字段，拒绝缺失/超长/非法值） */
export function parseP2PBeaconDescriptor(value: unknown): P2PDeviceDescriptor {
  const record = asRecord(value);
  if (!record) {
    throw new P2PDiscoveryError("beacon_invalid_fields", "信标 device 必须是对象");
  }
  const deviceId = readBoundedString(record, "deviceId", { maxChars: MAX_DEVICE_ID_CHARS });
  const deviceName = readBoundedString(record, "deviceName", {
    maxChars: MAX_DEVICE_NAME_CHARS,
    allowEmpty: true,
  });
  const publicKey = readBoundedString(record, "publicKey", {
    maxChars: MAX_PUBLIC_KEY_BYTES,
    allowEmpty: true,
  });
  const host = readBoundedString(record, "host", { maxChars: MAX_HOST_CHARS, allowEmpty: true });
  const protocolVersion = readBoundedString(record, "protocolVersion", { maxChars: 32 });
  if (protocolVersion !== P2P_PROTOCOL_VERSION) {
    // 版本不兼容一律拒绝接收（fail-closed），而不是"尽力解析"
    throw new P2PDiscoveryError(
      "beacon_invalid_fields",
      `信标协议版本不兼容：${protocolVersion}（期望 ${P2P_PROTOCOL_VERSION}）`,
    );
  }
  const fingerprint = readBoundedString(record, "fingerprint", {
    maxChars: MAX_FINGERPRINT_CHARS,
    allowEmpty: true,
  });
  const rawPort = record.port;
  if (typeof rawPort !== "number" || !Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65_535) {
    throw new P2PDiscoveryError("beacon_invalid_fields", `信标端口非法：${String(rawPort)}`);
  }
  return { deviceId, deviceName, publicKey, host, port: rawPort, protocolVersion, fingerprint };
}

/** 把信标编码为有界 UTF-8 JSON（超上限直接拒绝，绝不写出超长报文） */
export function encodeP2PBeacon(
  beacon: P2PDiscoveryBeacon,
  options: { maxBytes?: number } = {},
): Buffer {
  const maxBytes = options.maxBytes ?? P2P_DISCOVERY_MAX_BEACON_BYTES;
  // 编码前先校验字段（避免把畸形记录发到网上）
  parseP2PBeaconDescriptor(beacon.device);
  const json = Buffer.from(JSON.stringify(beacon), "utf8");
  if (json.byteLength > maxBytes) {
    throw new P2PDiscoveryError(
      "beacon_too_large",
      `信标载荷超长：${json.byteLength} > ${maxBytes} 字节`,
    );
  }
  return json;
}

/**
 * 解析并校验信标载荷。
 * 顺序：字节上限 → JSON → 魔数 → 版本 → 字段。任一步失败都抛 `P2PDiscoveryError`。
 */
export function decodeP2PBeacon(
  data: Buffer | string,
  options: { maxBytes?: number } = {},
): P2PDiscoveryBeacon {
  const maxBytes = options.maxBytes ?? P2P_DISCOVERY_MAX_BEACON_BYTES;
  const byteLength = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
  if (byteLength > maxBytes) {
    throw new P2PDiscoveryError(
      "beacon_too_large",
      `收到超长信标：${byteLength} > ${maxBytes} 字节（已丢弃）`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof data === "string" ? data : data.toString("utf8"));
  } catch {
    throw new P2PDiscoveryError("beacon_not_json", "信标载荷不是合法 JSON（已丢弃）");
  }
  const record = asRecord(parsed);
  if (!record) {
    throw new P2PDiscoveryError("beacon_malformed", "信标载荷必须是 JSON 对象（已丢弃）");
  }
  if (record.magic !== P2P_DISCOVERY_BEACON_MAGIC) {
    throw new P2PDiscoveryError("beacon_malformed", "信标魔数不匹配（非本协议报文，已丢弃）");
  }
  if (record.beaconVersion !== P2P_DISCOVERY_BEACON_VERSION) {
    throw new P2PDiscoveryError(
      "beacon_malformed",
      `信标格式版本不兼容：${String(record.beaconVersion)}（期望 ${P2P_DISCOVERY_BEACON_VERSION}）`,
    );
  }
  if (record.serviceType !== P2P_SERVICE_TYPE) {
    throw new P2PDiscoveryError(
      "beacon_malformed",
      `信标服务类型不匹配：${String(record.serviceType)}（期望 ${P2P_SERVICE_TYPE}）`,
    );
  }
  const rawTtl = record.ttlMs;
  if (typeof rawTtl !== "number" || !Number.isFinite(rawTtl) || rawTtl <= 0) {
    throw new P2PDiscoveryError("beacon_invalid_fields", `信标 ttlMs 非法：${String(rawTtl)}`);
  }
  return {
    magic: P2P_DISCOVERY_BEACON_MAGIC,
    beaconVersion: P2P_DISCOVERY_BEACON_VERSION,
    serviceType: P2P_SERVICE_TYPE,
    device: parseP2PBeaconDescriptor(record.device),
    ttlMs: rawTtl,
    sentAt: readBoundedString(record, "sentAt", { maxChars: 64, allowEmpty: true }),
  };
}

/** 构造本机信标（复用 `createDeviceDescriptor`，不重复实现描述符逻辑） */
export function createP2PBeacon(options: {
  identity: P2PDeviceIdentity;
  host: string;
  port: number;
  ttlMs: number;
  now?: () => number;
}): P2PDiscoveryBeacon {
  return {
    magic: P2P_DISCOVERY_BEACON_MAGIC,
    beaconVersion: P2P_DISCOVERY_BEACON_VERSION,
    serviceType: P2P_SERVICE_TYPE,
    device: createDeviceDescriptor(options.identity, {
      host: options.host,
      port: options.port,
    }),
    ttlMs: options.ttlMs,
    sentAt: new Date(options.now ? options.now() : Date.now()).toISOString(),
  };
}

function defaultSocketFactory(): P2PDiscoverySocket {
  // dgram.Socket 的完整签名比本模块使用的最小接口更宽，这里做一次显式收窄。
  return dgram.createSocket({ type: "udp4", reuseAddr: true }) as unknown as P2PDiscoverySocket;
}

function withTimeout(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

function clampTtl(ttlMs: number, localTtlMs: number): number {
  const upper = Math.max(P2P_DISCOVERY_MIN_PEER_TTL_MS, localTtlMs);
  return Math.min(Math.max(ttlMs, P2P_DISCOVERY_MIN_PEER_TTL_MS), upper);
}

// ---------------------------------------------------------------------------
// 发现服务
// ---------------------------------------------------------------------------

/**
 * UDP 多播信标发现服务。
 *
 * 生命周期：`start()` 幂等（重复调用直接返回）→ 周期性发信标 + 周期性清理过期对端 →
 * `stop()` 幂等（清空定时器、摘除监听器、关 socket、清空对端表）。
 *
 * 所有 socket 操作都有兜底超时；所有错误走 `onError` 上报，**绝不**让坏信标或网络异常
 * 把调用方进程打挂（这是发现层"尽力而为"的定义）。
 */
export class P2PDiscovery {
  private readonly identity: P2PDeviceIdentity;
  private readonly group: string;
  private readonly discoveryPort: number;
  private readonly interfaces: string[];
  private readonly multicastEnabled: boolean;
  private readonly beaconIntervalMs: number;
  private readonly peerTtlMs: number;
  private readonly maxBeaconBytes: number;
  private readonly bindTimeoutMs: number;
  private readonly sendTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private readonly socketFactory: () => P2PDiscoverySocket;
  private readonly now: () => number;
  private readonly onPeer?: (peer: P2PDiscoveredPeer) => void;
  private readonly onPeerExpired?: (peer: P2PDiscoveredPeer) => void;
  private readonly onError?: (error: Error) => void;

  private localHost: string;
  private localPort: number;
  private socket: P2PDiscoverySocket | null = null;
  private running = false;
  private stopped = false;
  private beaconTimer: ReturnType<typeof setInterval> | null = null;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  /** 信标对端：按 deviceId 去重 */
  private readonly beaconPeers = new Map<string, P2PDiscoveredPeer>();
  /** 静态对端：按 host:port 去重，永不过期 */
  private readonly staticPeers = new Map<string, P2PDiscoveredPeer>();

  constructor(options: P2PDiscoveryOptions) {
    if (!options.identity?.deviceId) {
      throw new P2PDiscoveryError("invalid_options", "P2PDiscovery 需要合法的本机设备身份");
    }
    const peerTtlMs = options.peerTtlMs ?? P2P_DISCOVERY_DEFAULT_PEER_TTL_MS;
    if (!Number.isFinite(peerTtlMs) || peerTtlMs < P2P_DISCOVERY_MIN_PEER_TTL_MS) {
      throw new P2PDiscoveryError(
        "invalid_options",
        `peerTtlMs 必须 >= ${P2P_DISCOVERY_MIN_PEER_TTL_MS}，收到 ${String(options.peerTtlMs)}`,
      );
    }
    const discoveryPort = options.discoveryPort ?? P2P_DISCOVERY_DEFAULT_PORT;
    if (!Number.isInteger(discoveryPort) || discoveryPort < 1 || discoveryPort > 65_535) {
      throw new P2PDiscoveryError(
        "invalid_options",
        `discoveryPort 非法：${String(options.discoveryPort)}`,
      );
    }

    this.identity = options.identity;
    this.localHost = options.host;
    this.localPort = options.port;
    this.group = options.group ?? P2P_DISCOVERY_DEFAULT_GROUP;
    this.discoveryPort = discoveryPort;
    this.interfaces = [...(options.interfaces ?? [])];
    this.multicastEnabled = options.multicast !== false;
    this.beaconIntervalMs = Math.max(50, options.beaconIntervalMs ?? P2P_DISCOVERY_DEFAULT_BEACON_INTERVAL_MS);
    this.peerTtlMs = peerTtlMs;
    this.maxBeaconBytes = options.maxBeaconBytes ?? P2P_DISCOVERY_MAX_BEACON_BYTES;
    this.bindTimeoutMs = options.bindTimeoutMs ?? P2P_DISCOVERY_DEFAULT_BIND_TIMEOUT_MS;
    this.sendTimeoutMs = options.sendTimeoutMs ?? P2P_DISCOVERY_DEFAULT_SEND_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? P2P_DISCOVERY_DEFAULT_CLOSE_TIMEOUT_MS;
    this.socketFactory = options.socketFactory ?? defaultSocketFactory;
    this.now = options.now ?? (() => Date.now());
    this.onPeer = options.onPeer;
    this.onPeerExpired = options.onPeerExpired;
    this.onError = options.onError;

    this.setStaticPeers(options.staticPeers ?? []);
  }

  /** 是否已启动（多播关闭时，`start()` 后仍为 true，但不会创建 socket） */
  isRunning(): boolean {
    return this.running;
  }

  /** 本地公布的 TCP 同步端点 */
  getLocalEndpoint(): { host: string; port: number } {
    return { host: this.localHost, port: this.localPort };
  }

  /** 服务端以 0 端口启动后回填真实端口（信标内容随之更新） */
  setLocalEndpoint(endpoint: { host?: string; port: number }): void {
    if (endpoint.host) this.localHost = endpoint.host;
    if (Number.isInteger(endpoint.port) && endpoint.port >= 0 && endpoint.port <= 65_535) {
      this.localPort = endpoint.port;
    }
  }

  /** 替换静态对端列表（幂等；不触发 socket 操作） */
  setStaticPeers(peers: P2PStaticPeer[]): void {
    this.staticPeers.clear();
    const nowMs = this.now();
    for (const peer of peers) {
      if (typeof peer.host !== "string" || peer.host.trim().length === 0) continue;
      if (!Number.isInteger(peer.port) || peer.port < 1 || peer.port > 65_535) continue;
      const key = `${peer.host.trim()}:${peer.port}`;
      this.staticPeers.set(key, {
        device: {
          deviceId: peer.deviceId?.trim() || `static_${key}`,
          deviceName: peer.deviceName?.trim() || "(静态对端，身份待握手确认)",
          publicKey: peer.publicKey?.trim() ?? "",
          host: peer.host.trim(),
          port: peer.port,
          protocolVersion: P2P_PROTOCOL_VERSION,
          fingerprint: peer.fingerprint?.trim() ?? "",
        },
        source: "static",
        lastSeenMs: nowMs,
        lastSeenAt: new Date(nowMs).toISOString(),
        ttlMs: Number.POSITIVE_INFINITY,
        expiresAtMs: Number.POSITIVE_INFINITY,
        expired: false,
      });
    }
  }

  /**
   * 启动发现。
   * - `multicast: false`：只登记静态对端，不创建任何 socket（CI/受限网络下的确定性模式）；
   * - `multicast: true`：绑定 `discoveryPort` 并加入多播组；绑定失败时抛
   *   `P2PDiscoveryError`（绑定失败无法兜底），加入多播组失败只 `onError` 上报后继续
   *   （仍可广播出去，只是收不到回包）。
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.stopped = false;

    if (!this.multicastEnabled) return;

    const socket = this.socketFactory();
    this.socket = socket;

    /** bind 落地前的 socket 错误（如 EADDRINUSE）必须让 start() 立即失败，而不是白等一个超时 */
    let rejectBind: ((error: Error) => void) | null = null;
    socket.on("message", (msg: Buffer, rinfo: P2PDiscoveryRemoteInfo) => {
      this.handleBeacon(msg, rinfo);
    });
    socket.on("error", (error: Error) => {
      const reject = rejectBind;
      rejectBind = null;
      reject?.(
        new P2PDiscoveryError("socket_bind_failed", `UDP 发现 socket 错误：${error.message}`),
      );
      this.reportError(error);
    });

    let bound = false;
    try {
      bound = await withTimeout(
        new Promise<void>((resolve, reject) => {
          rejectBind = reject;
          try {
            socket.bind(this.discoveryPort, () => {
              rejectBind = null;
              resolve();
            });
          } catch (error) {
            rejectBind = null;
            reject(error);
          }
        }),
        this.bindTimeoutMs,
      );
    } catch (error) {
      // 绑定失败（如端口被占用/权限不足）无法兜底：清理 socket 并把 running 复位，允许调用方重试
      this.detachSocket();
      this.running = false;
      throw error instanceof P2PDiscoveryError
        ? error
        : new P2PDiscoveryError(
            "socket_bind_failed",
            `UDP 发现 socket 绑定失败（端口 ${this.discoveryPort}）：${
              error instanceof Error ? error.message : String(error)
            }`,
          );
    }
    if (!bound || this.stopped) {
      // 绑定超时或启动过程中被 stop()：清理后按失败处理（不留下半开 socket）
      this.detachSocket();
      if (bound) {
        this.running = false;
        return;
      }
      this.running = false;
      throw new P2PDiscoveryError(
        "socket_bind_timeout",
        `UDP 发现 socket 在 ${this.bindTimeoutMs}ms 内未绑定成功（端口 ${this.discoveryPort}）`,
      );
    }

    try {
      socket.setMulticastTTL(1); // 只在本网段传播，绝不跨路由外泄
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
    }

    const targets = this.interfaces.length > 0 ? this.interfaces : [undefined];
    for (const iface of targets) {
      try {
        if (iface === undefined) socket.addMembership(this.group);
        else socket.addMembership(this.group, iface);
      } catch (error) {
        // 多播在部分网络/CI 下不可用属预期情况：上报后继续（静态对端仍可用）
        this.reportError(
          new P2PDiscoveryError(
            "socket_error",
            `加入多播组 ${this.group}${iface ? `@${iface}` : ""} 失败（多播不可用，可改用静态对端列表）：${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    }

    socket.unref?.();
    await this.sendBeaconNow();
    this.beaconTimer = setInterval(() => {
      void this.sendBeaconNow();
    }, this.beaconIntervalMs);
    this.beaconTimer.unref?.();

    const sweepIntervalMs = Math.max(50, Math.min(Math.floor(this.peerTtlMs / 2), 1_000));
    this.sweepTimer = setInterval(() => {
      this.sweepExpiredPeers();
    }, sweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  /**
   * 关闭发现（幂等）：清空定时器、摘除所有监听器、关闭 socket（带兜底超时）、清空对端表。
   * 关闭后不再发送任何信标，也不再触发回调。
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.running = false;

    if (this.beaconTimer) {
      clearInterval(this.beaconTimer);
      this.beaconTimer = null;
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }

    const socket = this.socket;
    this.socket = null;
    if (socket) {
      for (const iface of this.interfaces.length > 0 ? this.interfaces : [undefined]) {
        try {
          if (iface === undefined) socket.dropMembership(this.group);
          else socket.dropMembership(this.group, iface);
        } catch {
          // 未加入成功或 socket 已关闭：忽略
        }
      }
      this.removeSocketListeners(socket);
      await withTimeout(
        new Promise<void>((resolve) => {
          try {
            socket.close(() => resolve());
          } catch {
            resolve();
          }
        }),
        this.closeTimeoutMs,
      );
    }

    this.beaconPeers.clear();
    this.staticPeers.clear();
  }

  /**
   * 列出当前存活对端（信标对端已按 TTL 过滤，静态对端恒在）。
   * 输出顺序确定（静态在前，随后按 deviceId 字典序），便于测试与稳定 UI。
   */
  listPeers(): P2PDiscoveredPeer[] {
    const nowMs = this.now();
    const alive: P2PDiscoveredPeer[] = [];
    for (const [deviceId, peer] of [...this.beaconPeers.entries()]) {
      if (peer.expiresAtMs <= nowMs) {
        this.beaconPeers.delete(deviceId);
        this.onPeerExpired?.(peer);
        continue;
      }
      alive.push(peer);
    }
    const staticEntries = [...this.staticPeers.values()].filter((peer) => {
      // 已被信标确认的同一地址只输出信标版本（描述符更可信）
      return !alive.some(
        (beaconPeer) =>
          beaconPeer.device.host === peer.device.host && beaconPeer.device.port === peer.device.port,
      );
    });
    return [
      ...staticEntries.sort((a, b) => a.device.deviceId.localeCompare(b.device.deviceId)),
      ...alive.sort((a, b) => a.device.deviceId.localeCompare(b.device.deviceId)),
    ];
  }

  /** 立即发送一次信标（`start()` 时会自动调用；手动调用可用于加速配对流程） */
  async sendBeaconNow(): Promise<void> {
    const socket = this.socket;
    if (!socket || this.stopped) return;
    const beacon = createP2PBeacon({
      identity: this.identity,
      host: this.localHost,
      port: this.localPort,
      ttlMs: this.peerTtlMs,
      now: this.now,
    });
    let payload: Buffer;
    try {
      payload = encodeP2PBeacon(beacon, { maxBytes: this.maxBeaconBytes });
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(finish, this.sendTimeoutMs);
      timer.unref?.();
      try {
        socket.send(payload, this.discoveryPort, this.group, () => {
          clearTimeout(timer);
          finish();
        });
      } catch (error) {
        clearTimeout(timer);
        this.reportError(error instanceof Error ? error : new Error(String(error)));
        finish();
      }
    });
  }

  /**
   * 处理收到的信标。
   * 任何解析/校验失败都只上报 `onError`，绝不让坏包影响已发现对端或调用方进程。
   */
  private handleBeacon(data: Buffer, rinfo: P2PDiscoveryRemoteInfo): void {
    let beacon: P2PDiscoveryBeacon;
    try {
      beacon = decodeP2PBeacon(data, { maxBytes: this.maxBeaconBytes });
    } catch (error) {
      this.reportError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // 自己的信标（多播回环）不登记为对端
    if (beacon.device.deviceId === this.identity.deviceId) return;
    const sourceAddress =
      typeof rinfo?.address === "string" && rinfo.address.trim().length > 0
        ? rinfo.address.trim()
        : "";
    if (sourceAddress.length === 0) {
      this.reportError(
        new P2PDiscoveryError("beacon_malformed", "收到无源地址的信标（已丢弃，绝不采信自报 host）"),
      );
      return;
    }

    const nowMs = this.now();
    const ttlMs = clampTtl(beacon.ttlMs, this.peerTtlMs);
    // 关键：host 取报文源地址，绝不采用对端自报的 device.host
    const device: P2PDeviceDescriptor = { ...beacon.device, host: sourceAddress };
    const previous = this.beaconPeers.get(device.deviceId);
    const peer: P2PDiscoveredPeer = {
      device,
      source: "beacon",
      lastSeenMs: nowMs,
      lastSeenAt: new Date(nowMs).toISOString(),
      ttlMs,
      expiresAtMs: nowMs + ttlMs,
      expired: false,
    };
    this.beaconPeers.set(device.deviceId, peer);

    const isNew = previous === undefined;
    const changed =
      previous !== undefined &&
      (previous.device.host !== device.host ||
        previous.device.port !== device.port ||
        previous.device.fingerprint !== device.fingerprint);
    if (isNew || changed) this.onPeer?.(peer);
  }

  /** 清理过期对端（`listPeers()` 也会做同样的过滤，双保险） */
  private sweepExpiredPeers(): void {
    if (this.stopped) return;
    const nowMs = this.now();
    for (const [deviceId, peer] of [...this.beaconPeers.entries()]) {
      if (peer.expiresAtMs <= nowMs) {
        this.beaconPeers.delete(deviceId);
        this.onPeerExpired?.(peer);
      }
    }
  }

  private removeSocketListeners(socket: P2PDiscoverySocket): void {
    for (const event of ["message", "error", "listening", "close"]) {
      try {
        socket.removeAllListeners(event);
      } catch {
        // 假 socket 或已关闭 socket 可能不支持，忽略
      }
    }
  }

  private detachSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    this.removeSocketListeners(socket);
    try {
      socket.close(() => undefined);
    } catch {
      // 已关闭
    }
  }

  private reportError(error: Error): void {
    if (this.onError) {
      this.onError(error);
      return;
    }
    // 没有上报回调时也不能抛出到事件循环：发现层是尽力而为的优化，绝不影响进程存活
  }
}
