/**
 * Aervox｜思隅 @aervox/repositories — 纯本地多端 P2P 设备身份、配对握手与会话加密（ITER-028）
 *
 * 设计依据：
 * - CR-030 零多租户、纯本地个人真源：无中心化云端数据库，数据主权完全归属单用户；
 * - CR-055 / CAP-018 / CAP-027：局域网内桌面端（Electron）与移动端（Capacitor）点对点安全直连。
 *
 * ## 两条握手路径（务必区分）
 *
 * 1. **承诺-揭示路径（推荐，`beginPairing` → `respondToPairing` → `completePairingAsInitiator`
 *    → `finalizePairingAsResponder`）**：发起方先对临时公钥做承诺，响应方在看到承诺后才揭示自己的
 *    临时公钥，发起方最后揭示并验证。这样任何一方都无法在看到对方密钥后反复挑选自己的密钥来"碰"
 *    出同一个 6 位 SAS，因此 6 位 SAS 的人工比对具备实际防中间人意义。
 *    该路径产出的会话在用户完成 SAS 比对（`markSessionVerified`）之前 **禁止用于加密**。
 *
 * 2. **遗留两消息路径（`createPairingInvitation` / `acceptPairingInvitation` /
 *    `completePairingAsInitiator`）**：无承诺，临时公钥与 nonce 明文交换，攻击者可离线爆破
 *    ~2×10^6 次哈希让两端看到相同 SAS。**不具备防中间人性质**，仅为兼容与既有测试保留，
 *    标记 `@deprecated`，新接入一律使用路径 1。
 *
 * ## 会话加密（两条路径共用）
 * - 由 ECDH(P-256) 共享秘密经 HKDF-SHA256 派生**分向密钥**（a2b / b2a）与确认密钥；
 * - AES-256-GCM，nonce = 4 字节随机会话前缀 + 8 字节递增计数器，计数器随报文传递；
 * - AAD 绑定 `协议版本|sessionId|方向|序号`，杜绝跨会话/跨方向重放；
 * - 接收端要求序号**严格递增**（可靠有序通道假设：unix socket / TCP），重放与乱序一律拒绝；
 * - 每次会话密钥 material 只在一端作为发送密钥使用，nonce 不会重复。
 *
 * ## 明确**未实现**（勿默认已覆盖）
 * - 未实现 OS Keychain / 安全隔区托管：身份私钥以 0600 文件保存在本地数据目录；
 * - 未实现证书链或 PKI：对端信任来自"首次配对 + SAS 人工比对 + 指纹固定（TOFU）"；
 * - 未实现密钥轮换、前向保密（无 DH 棘轮）与撤销列表；
 * - 未实现局域网传输本身（无 mDNS 收发、无 socket 服务器），本文件只提供密码学与会话原语。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/** 设备描述符/广播协议版本（保持向后兼容） */
export const P2P_PROTOCOL_VERSION = "v1";
/** 配对握手协议版本（承诺-揭示） */
export const P2P_PAIRING_PROTOCOL_VERSION = "v2";
/** HKDF 派生标签前缀 */
const HKDF_INFO_PREFIX = "aervox-p2p-session-v2";
const TRANSCRIPT_PREFIX = "aervox-p2p-pairing-v2";

/** 设备身份信息 */
export interface P2PDeviceIdentity {
  deviceId: string;
  deviceName: string;
  publicKey: string;
  privateKey: string;
}

/** 局域网广播暴露的设备描述信息（可由 mDNS TXT 记录或 UDP Multicast 广播） */
export interface P2PDeviceDescriptor {
  deviceId: string;
  deviceName: string;
  publicKey: string;
  host: string;
  port: number;
  protocolVersion: string;
  fingerprint: string;
}

/**
 * 配对邀请（消息 1，发起方 → 响应方）。
 * 承诺-揭示路径只携带 `commitment`，**不携带临时公钥**；遗留路径才携带 `ephemeralPublicKey`。
 */
export interface PairingInvitation {
  invitationId: string;
  protocolVersion: string;
  initiatorDevice: Omit<P2PDeviceDescriptor, "host" | "port">;
  commitment?: string;
  ephemeralPublicKey?: string;
  timestamp: string;
  nonce: string;
}

/** 配对响应（消息 2，响应方 → 发起方） */
export interface PairingResponse {
  invitationId: string;
  protocolVersion: string;
  responderDevice: Omit<P2PDeviceDescriptor, "host" | "port">;
  ephemeralPublicKey: string;
  nonce: string;
  /** 响应方私钥对握手 transcript 的 Ed25519 签名 */
  signature: string;
}

/** 承诺-揭示路径的发起方揭示（消息 3，发起方 → 响应方） */
export interface PairingReveal {
  invitationId: string;
  ephemeralPublicKey: string;
  nonce: string;
  /**
   * 发起方对自己身份密钥的证明：对完整 transcript 的 Ed25519 签名。
   * 响应方据此确认对端确实持有 `initiatorDevice.publicKey` 对应的私钥，
   * 而不是仅凭 SAS 目视核验（首次配对没有 TOFU 固定值时尤其重要）。
   */
  signature: string;
  /**
   * 发起方对确认密钥的 HMAC，证明其确实持有派生出的会话密钥。
   * 域分离前缀为 `i2r`，与响应方回执的 `r2i` 不同（否则只是回声，不能证明任何事）。
   */
  keyConfirmation: string;
}

/** 遗留路径的响应方确认回执 */
export interface PairingConfirmation {
  invitationId: string;
  responderDevice: Omit<P2PDeviceDescriptor, "host" | "port">;
  ephemeralPublicKey: string;
  sasCode: string;
  signature: string;
}

/** 会话安全等级：committed 为承诺-揭示路径，legacy_uncommitted 为遗留不安全路径 */
export type PairingSecurityLevel = "committed" | "legacy_uncommitted";

/** 会话角色 */
export type PairingRole = "initiator" | "responder";

/** 已建立的会话 */
export interface EstablishedP2PSession {
  sessionId: string;
  localDeviceId: string;
  remoteDeviceId: string;
  /** @deprecated 主密钥，仅为源码兼容保留；加密请使用 sendKey/receiveKey 分向密钥 */
  sharedKey: Buffer;
  /** 本端 → 对端 的发送密钥 */
  sendKey: Buffer;
  /** 对端 → 本端 的接收密钥 */
  receiveKey: Buffer;
  role: PairingRole;
  securityLevel: PairingSecurityLevel;
  /** 是否已经由用户完成 SAS 比对确认；committed 会话未确认前禁止加密 */
  verified: boolean;
  /** 对端公钥指纹（用于 TOFU 固定） */
  remoteFingerprint: string;
  establishedAt: string;
}

/** 加密同步消息载荷 */
export interface EncryptedSyncPayload {
  version: string;
  sessionId: string;
  /** 单调递增的发送序号（从 0 起） */
  sequence: number;
  /** 方向标签，绑定 AAD，防止跨方向重放 */
  direction: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

const DIRECTION_INITIATOR_TO_RESPONDER = "initiator_to_responder";
const DIRECTION_RESPONDER_TO_INITIATOR = "responder_to_initiator";

/** 密钥确认的域分离标签：两侧必须不同，否则"确认"退化为回声 */
const CONFIRMATION_LABEL_INITIATOR = "i2r";
const CONFIRMATION_LABEL_RESPONDER = "r2i";

function computeKeyConfirmation(confirmationKey: Buffer, label: string, transcript: string): string {
  return crypto
    .createHmac("sha256", confirmationKey)
    .update(lengthPrefixed([label, transcript]), "utf8")
    .digest("base64");
}

function timingSafeEqualBase64(expected: string, provided: string): boolean {
  const expectedBuf = Buffer.from(expected, "base64");
  const providedBuf = Buffer.from(provided, "base64");
  return (
    expectedBuf.length === providedBuf.length && crypto.timingSafeEqual(expectedBuf, providedBuf)
  );
}

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

/** 会话加密运行时状态（计数器等），不暴露在公开结构上 */
interface SessionCryptoState {
  noncePrefix: Buffer;
  nextSendSequence: number;
  highestReceivedSequence: number;
  /** 仅用于校验对端密钥确认，不对外暴露 */
  confirmationKey: Buffer;
}

const sessionStates = new WeakMap<EstablishedP2PSession, SessionCryptoState>();

function directionFor(role: PairingRole): string {
  return role === "initiator" ? DIRECTION_INITIATOR_TO_RESPONDER : DIRECTION_RESPONDER_TO_INITIATOR;
}

function oppositeDirection(role: PairingRole): string {
  return role === "initiator" ? DIRECTION_RESPONDER_TO_INITIATOR : DIRECTION_INITIATOR_TO_RESPONDER;
}

/** 长度前缀规范化，避免拼接歧义（与 SAS/签名/AAD 的输入相关） */
function lengthPrefixed(values: string[]): string {
  return values.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
}

/**
 * 握手 transcript：覆盖邀请、双方身份公钥、commitment、双方临时公钥与 nonce。
 * 故意不覆盖 host/port（网络位置可变且不影响身份绑定）。
 */
function pairingTranscript(parts: {
  invitationId: string;
  protocolVersion: string;
  initiatorDeviceId: string;
  initiatorPublicKey: string;
  responderDeviceId: string;
  responderPublicKey: string;
  initiatorNonce: string;
  responderNonce: string;
  initiatorEphemeralKey: string;
  responderEphemeralKey: string;
  commitment: string;
}): string {
  return lengthPrefixed([
    TRANSCRIPT_PREFIX,
    parts.invitationId,
    parts.protocolVersion,
    parts.initiatorDeviceId,
    parts.initiatorPublicKey,
    parts.responderDeviceId,
    parts.responderPublicKey,
    parts.initiatorNonce,
    parts.responderNonce,
    parts.initiatorEphemeralKey,
    parts.responderEphemeralKey,
    parts.commitment,
  ]);
}

/**
 * 消息 2 的签名 transcript。
 * 响应方在签名时尚未见到发起方临时公钥（承诺-揭示的意义所在），因此签名不得覆盖该字段；
 * 双方一律以空占位计算，保证响应方签名可被发起方复算验证。
 */
function signatureTranscript(parts: {
  invitationId: string;
  protocolVersion: string;
  initiatorDeviceId: string;
  initiatorPublicKey: string;
  responderDeviceId: string;
  responderPublicKey: string;
  initiatorNonce: string;
  responderNonce: string;
  responderEphemeralKey: string;
  commitment: string;
}): string {
  return pairingTranscript({ ...parts, initiatorEphemeralKey: "" });
}

function deriveSessionKeys(
  sharedSecret: Buffer,
  initiatorNonce: string,
  responderNonce: string,
): { master: Buffer; initiatorToResponder: Buffer; responderToInitiator: Buffer; confirmation: Buffer } {
  const salt = Buffer.from(`${initiatorNonce}:${responderNonce}`, "utf8");
  const derive = (label: string): Buffer =>
    Buffer.from(crypto.hkdfSync("sha256", sharedSecret, salt, `${HKDF_INFO_PREFIX}/${label}`, 32));
  return {
    master: derive("master"),
    initiatorToResponder: derive("a2b"),
    responderToInitiator: derive("b2a"),
    confirmation: derive("confirm"),
  };
}

function createSession(options: {
  sessionId: string;
  localDeviceId: string;
  remoteDeviceId: string;
  role: PairingRole;
  securityLevel: PairingSecurityLevel;
  remoteFingerprint: string;
  keys: {
    master: Buffer;
    initiatorToResponder: Buffer;
    responderToInitiator: Buffer;
    confirmation: Buffer;
  };
}): EstablishedP2PSession {
  const session: EstablishedP2PSession = {
    sessionId: options.sessionId,
    localDeviceId: options.localDeviceId,
    remoteDeviceId: options.remoteDeviceId,
    sharedKey: options.keys.master,
    sendKey:
      options.role === "initiator"
        ? options.keys.initiatorToResponder
        : options.keys.responderToInitiator,
    receiveKey:
      options.role === "initiator"
        ? options.keys.responderToInitiator
        : options.keys.initiatorToResponder,
    role: options.role,
    securityLevel: options.securityLevel,
    verified: false,
    remoteFingerprint: options.remoteFingerprint,
    establishedAt: new Date().toISOString(),
  };
  sessionStates.set(session, {
    noncePrefix: crypto.randomBytes(4),
    nextSendSequence: 0,
    highestReceivedSequence: -1,
    confirmationKey: options.keys.confirmation,
  });
  return session;
}

/** 生成本机设备身份（仅内存，不落盘）。新代码请使用 `loadOrCreateDeviceIdentity`。 */
export function generateDeviceIdentity(deviceName: string, deviceIdPrefix = "dev"): P2PDeviceIdentity {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  const deviceId = `${deviceIdPrefix}_${crypto.randomBytes(6).toString("hex")}`;
  return {
    deviceId,
    deviceName,
    publicKey,
    privateKey,
  };
}

/** 设备身份默认落盘路径（与主库同目录，0600） */
export function defaultP2PIdentityPath(): string {
  return path.join(repoRoot, "data", "p2p-device-identity.json");
}

function resolveIdentityPath(customPath?: string): string {
  return (
    customPath?.trim() ||
    process.env.AERVOX_P2P_IDENTITY_PATH?.trim() ||
    defaultP2PIdentityPath()
  );
}

/** 读取已持久化的设备身份；不存在时返回 null */
export async function loadDeviceIdentity(customPath?: string): Promise<P2PDeviceIdentity | null> {
  const identityPath = resolveIdentityPath(customPath);
  try {
    const raw = await fs.readFile(identityPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<P2PDeviceIdentity>;
    if (
      typeof parsed.deviceId !== "string" ||
      typeof parsed.deviceName !== "string" ||
      typeof parsed.publicKey !== "string" ||
      typeof parsed.privateKey !== "string"
    ) {
      throw new Error(`P2P device identity at ${identityPath} is malformed`);
    }
    return {
      deviceId: parsed.deviceId,
      deviceName: parsed.deviceName,
      publicKey: parsed.publicKey,
      privateKey: parsed.privateKey,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * 持久化设备身份。文件始终以 0600 创建（`wx` 独占创建避免竞态覆盖，已存在则读取既有身份）。
 *
 * 目录权限说明（勿过度声明）：本函数**只在目录由本次调用创建时**把目录设为 0700；
 * 若复用已存在的目录（如默认的仓库 `data/`，通常为 0755），不会修改其模式，
 * 以免影响同目录下的其他数据文件。私钥机密性由文件级 0600 保证；
 * 目录级收紧与 OS Keychain 托管属于后续工作。
 */
export async function saveDeviceIdentity(
  identity: P2PDeviceIdentity,
  customPath?: string,
): Promise<string> {
  const identityPath = resolveIdentityPath(customPath);
  const identityDir = path.dirname(identityPath);
  const existingDir = await fs.stat(identityDir).catch(() => null);
  await fs.mkdir(identityDir, { recursive: true, mode: 0o700 });
  if (!existingDir) {
    await fs.chmod(identityDir, 0o700).catch(() => undefined);
  }
  try {
    const handle = await fs.open(identityPath, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(identity, null, 2)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await fs.chmod(identityPath, 0o600).catch(() => undefined);
    return identityPath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return identityPath;
    throw error;
  }
}

/** 读取或首次生成设备身份并落盘（Ed25519 稳定身份，跨进程重启保持一致） */
export async function loadOrCreateDeviceIdentity(options: {
  path?: string;
  deviceName?: string;
  deviceIdPrefix?: string;
} = {}): Promise<P2PDeviceIdentity> {
  const identityPath = resolveIdentityPath(options.path);
  const existing = await loadDeviceIdentity(identityPath);
  if (existing) return existing;

  const created = generateDeviceIdentity(
    options.deviceName ?? os.hostname(),
    options.deviceIdPrefix ?? "dev",
  );
  await saveDeviceIdentity(created, identityPath);
  // 并发首次创建时以落盘者为准
  return (await loadDeviceIdentity(identityPath)) ?? created;
}

/** 从公钥计算指纹（默认 12 位十六进制，用于界面展示与描述符） */
export function computePublicKeyFingerprint(publicKeyPem: string, chars = 12): string {
  return crypto
    .createHash("sha256")
    .update(publicKeyPem.trim())
    .digest("hex")
    .slice(0, Math.max(8, chars));
}

/**
 * 对端指纹固定（TOFU）：与已知指纹不一致时 fail-closed。
 * 返回 true 表示一致或首次见到（调用方应随后持久化 newFingerprint）。
 */
export function verifyPeerFingerprint(
  publicKeyPem: string,
  expectedFingerprint: string | undefined,
  chars = 12,
): boolean {
  if (!expectedFingerprint) return true;
  return computePublicKeyFingerprint(publicKeyPem, chars) === expectedFingerprint;
}

/** 生成设备局域网广播描述符 */
export function createDeviceDescriptor(
  identity: P2PDeviceIdentity,
  options: { host: string; port: number },
): P2PDeviceDescriptor {
  return {
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    publicKey: identity.publicKey,
    host: options.host,
    port: options.port,
    protocolVersion: P2P_PROTOCOL_VERSION,
    fingerprint: computePublicKeyFingerprint(identity.publicKey),
  };
}

/** 计算临时公钥承诺：sha256(commitment || 长度前缀化(临时公钥, nonce)) */
export function computePairingCommitment(ephemeralPublicKey: string, nonce: string): string {
  return crypto
    .createHash("sha256")
    .update(lengthPrefixed([`${TRANSCRIPT_PREFIX}/commit`, ephemeralPublicKey, nonce]))
    .digest("base64");
}

/** 校验揭示的临时公钥与 nonce 是否匹配承诺（常数时间比较） */
export function verifyPairingCommitment(
  commitment: string,
  ephemeralPublicKey: string,
  nonce: string,
): boolean {
  const expected = Buffer.from(computePairingCommitment(ephemeralPublicKey, nonce), "base64");
  const actual = Buffer.from(commitment, "base64");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/** 由握手 transcript 计算 6 位 SAS（两端独立计算，必须逐位一致） */
export function computePairingSasFromTranscript(transcript: string): string {
  const hash = crypto
    .createHash("sha256")
    .update(lengthPrefixed([`${TRANSCRIPT_PREFIX}/sas`, transcript]))
    .digest();
  const num = hash.readUInt32BE(0) % 1_000_000;
  return num.toString().padStart(6, "0");
}

/**
 * @deprecated 遗留 SAS 计算（无承诺，输入为裸字段拼接）。
 * 仅用于兼容既有调用；新代码请使用 `computePairingSasFromTranscript`。
 */
export function computePairingSas(
  initiatorPubKey: string,
  responderPubKey: string,
  initiatorEphemeralKey: string,
  responderEphemeralKey: string,
  nonce: string,
): string {
  return computePairingSasFromTranscript(
    lengthPrefixed([
      `${TRANSCRIPT_PREFIX}/legacy`,
      initiatorPubKey,
      responderPubKey,
      initiatorEphemeralKey,
      responderEphemeralKey,
      nonce,
    ]),
  );
}

function signTranscript(identity: P2PDeviceIdentity, transcript: string): string {
  return crypto
    .sign(null, Buffer.from(transcript, "utf8"), identity.privateKey)
    .toString("base64");
}

function verifyTranscriptSignature(
  publicKeyPem: string,
  transcript: string,
  signature: string,
): boolean {
  try {
    return crypto.verify(
      null,
      Buffer.from(transcript, "utf8"),
      publicKeyPem,
      Buffer.from(signature, "base64"),
    );
  } catch {
    return false;
  }
}

function deviceSummary(identity: P2PDeviceIdentity): Omit<P2PDeviceDescriptor, "host" | "port"> {
  return {
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    publicKey: identity.publicKey,
    protocolVersion: P2P_PROTOCOL_VERSION,
    fingerprint: computePublicKeyFingerprint(identity.publicKey),
  };
}

function assertInvitationFreshness(invitation: PairingInvitation, maxSkewMs: number): void {
  const issuedAt = Date.parse(invitation.timestamp);
  if (!Number.isFinite(issuedAt)) {
    throw new Error("Pairing invitation has an invalid timestamp");
  }
  const skew = Math.abs(Date.now() - issuedAt);
  if (skew > maxSkewMs) {
    throw new Error(
      `Pairing invitation is stale (${skew}ms skew exceeds ${maxSkewMs}ms); refusing to pair`,
    );
  }
}

// ---------------------------------------------------------------------------
// 承诺-揭示路径（推荐）
// ---------------------------------------------------------------------------

/** 发起方待完成状态 */
export interface PendingInitiatorPairing {
  invitation: PairingInvitation;
  ephemeralEcdh: crypto.ECDH;
}

/** 响应方待完成状态 */
export interface PendingResponderPairing {
  invitationId: string;
  nonce: string;
  ephemeralEcdh: crypto.ECDH;
}

/**
 * 消息 1：发起方创建带承诺的配对邀请（不泄露临时公钥）。
 * 建议调用方在界面上同时展示 `commitment` 的短校验码，供响应方在揭示后核对。
 */
export function beginPairing(
  initiator: P2PDeviceIdentity,
  options: { invitationTtlMs?: number } = {},
): PendingInitiatorPairing {
  const ephemeralEcdh = crypto.createECDH("prime256v1");
  ephemeralEcdh.generateKeys();
  const ephemeralPublicKey = ephemeralEcdh.getPublicKey().toString("base64");
  const nonce = crypto.randomBytes(16).toString("hex");
  const invitation: PairingInvitation = {
    invitationId: `inv_${crypto.randomBytes(8).toString("hex")}`,
    protocolVersion: P2P_PAIRING_PROTOCOL_VERSION,
    initiatorDevice: deviceSummary(initiator),
    commitment: computePairingCommitment(ephemeralPublicKey, nonce),
    nonce,
    timestamp: new Date().toISOString(),
  };
  void options.invitationTtlMs;
  return { invitation, ephemeralEcdh };
}

/**
 * 消息 2：响应方校验邀请新鲜度与协议版本，生成并揭示自己的临时公钥，
 * 并对完整 transcript 签名。此时响应方尚无法派生会话密钥（未见到发起方临时公钥）。
 */
export function respondToPairing(
  responder: P2PDeviceIdentity,
  invitation: PairingInvitation,
  options: { maxClockSkewMs?: number } = {},
): { response: PairingResponse; pending: PendingResponderPairing } {
  if (invitation.protocolVersion !== P2P_PAIRING_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported pairing protocol version: ${invitation.protocolVersion} (expected ${P2P_PAIRING_PROTOCOL_VERSION})`,
    );
  }
  if (!invitation.commitment) {
    throw new Error("Pairing invitation is missing the ephemeral key commitment");
  }
  assertInvitationFreshness(invitation, options.maxClockSkewMs ?? 120_000);

  const ephemeralEcdh = crypto.createECDH("prime256v1");
  ephemeralEcdh.generateKeys();
  const ephemeralPublicKey = ephemeralEcdh.getPublicKey().toString("base64");
  const nonce = crypto.randomBytes(16).toString("hex");

  const transcript = signatureTranscript({
    invitationId: invitation.invitationId,
    protocolVersion: invitation.protocolVersion,
    initiatorDeviceId: invitation.initiatorDevice.deviceId,
    initiatorPublicKey: invitation.initiatorDevice.publicKey,
    responderDeviceId: responder.deviceId,
    responderPublicKey: responder.publicKey,
    initiatorNonce: invitation.nonce,
    responderNonce: nonce,
    responderEphemeralKey: ephemeralPublicKey,
    commitment: invitation.commitment,
  });

  const response: PairingResponse = {
    invitationId: invitation.invitationId,
    protocolVersion: P2P_PAIRING_PROTOCOL_VERSION,
    responderDevice: deviceSummary(responder),
    ephemeralPublicKey,
    nonce,
    signature: signTranscript(responder, transcript),
  };

  return {
    response,
    pending: { invitationId: invitation.invitationId, nonce, ephemeralEcdh },
  };
}

/**
 * 消息 3（发起方侧）：验证响应方签名与指纹固定，派生分向密钥，输出揭示报文。
 * 返回的会话**未验证**（`verified: false`），必须在用户比对 SAS 一致后调用
 * `markSessionVerified` 才可用于加密。
 */
export function completePairingAsInitiatorV2(
  initiator: P2PDeviceIdentity,
  pending: PendingInitiatorPairing,
  response: PairingResponse,
  options: { expectedRemoteFingerprint?: string } = {},
): { reveal: PairingReveal; session: EstablishedP2PSession; sasCode: string } {
  const invitation = pending.invitation;
  if (response.invitationId !== invitation.invitationId) {
    throw new Error("Invitation ID mismatch in pairing response");
  }
  if (response.protocolVersion !== P2P_PAIRING_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported pairing protocol version in response: ${response.protocolVersion}`,
    );
  }
  if (!invitation.commitment) {
    throw new Error("Pairing invitation is missing the ephemeral key commitment");
  }
  if (
    !verifyPeerFingerprint(
      response.responderDevice.publicKey,
      options.expectedRemoteFingerprint,
      computePublicKeyFingerprint(response.responderDevice.publicKey).length,
    )
  ) {
    throw new Error("Responder fingerprint does not match the pinned fingerprint");
  }

  const initiatorEphemeralKey = pending.ephemeralEcdh.getPublicKey().toString("base64");

  // 先校验响应方签名：签名 transcript 不覆盖发起方临时公钥（响应方当时未知）
  if (
    !verifyTranscriptSignature(
      response.responderDevice.publicKey,
      signatureTranscript({
        invitationId: invitation.invitationId,
        protocolVersion: P2P_PAIRING_PROTOCOL_VERSION,
        initiatorDeviceId: invitation.initiatorDevice.deviceId,
        initiatorPublicKey: invitation.initiatorDevice.publicKey,
        responderDeviceId: response.responderDevice.deviceId,
        responderPublicKey: response.responderDevice.publicKey,
        initiatorNonce: invitation.nonce,
        responderNonce: response.nonce,
        responderEphemeralKey: response.ephemeralPublicKey,
        commitment: invitation.commitment,
      }),
      response.signature,
    )
  ) {
    throw new Error("Invalid signature in pairing response");
  }

  const transcript = pairingTranscript({
    invitationId: invitation.invitationId,
    protocolVersion: P2P_PAIRING_PROTOCOL_VERSION,
    initiatorDeviceId: invitation.initiatorDevice.deviceId,
    initiatorPublicKey: invitation.initiatorDevice.publicKey,
    responderDeviceId: response.responderDevice.deviceId,
    responderPublicKey: response.responderDevice.publicKey,
    initiatorNonce: invitation.nonce,
    responderNonce: response.nonce,
    initiatorEphemeralKey,
    responderEphemeralKey: response.ephemeralPublicKey,
    commitment: invitation.commitment,
  });

  const sharedSecret = pending.ephemeralEcdh.computeSecret(
    Buffer.from(response.ephemeralPublicKey, "base64"),
  );
  const keys = deriveSessionKeys(sharedSecret, invitation.nonce, response.nonce);
  const session = createSession({
    sessionId: invitation.invitationId,
    localDeviceId: initiator.deviceId,
    remoteDeviceId: response.responderDevice.deviceId,
    role: "initiator",
    securityLevel: "committed",
    remoteFingerprint: computePublicKeyFingerprint(response.responderDevice.publicKey),
    keys,
  });

  const keyConfirmation = computeKeyConfirmation(
    keys.confirmation,
    CONFIRMATION_LABEL_INITIATOR,
    transcript,
  );

  const reveal: PairingReveal = {
    invitationId: invitation.invitationId,
    ephemeralPublicKey: initiatorEphemeralKey,
    nonce: invitation.nonce,
    // 证明本端持有发起方身份私钥（响应方据此完成对端身份认证）
    signature: signTranscript(initiator, transcript),
    keyConfirmation,
  };

  return { reveal, session, sasCode: computePairingSasFromTranscript(transcript) };
}

/**
 * 消息 3（响应方侧）：验证发起方揭示与承诺一致、双方 transcript 一致、发起方持有会话密钥，
 * 派生分向密钥并返回本端确认报文。会话同样**未验证**，待用户比对 SAS。
 */
export function finalizePairingAsResponder(
  responder: P2PDeviceIdentity,
  pending: PendingResponderPairing,
  invitation: PairingInvitation,
  reveal: PairingReveal,
  options: { expectedRemoteFingerprint?: string } = {},
): { session: EstablishedP2PSession; sasCode: string; keyConfirmation: string } {
  if (reveal.invitationId !== pending.invitationId || invitation.invitationId !== pending.invitationId) {
    throw new Error("Invitation ID mismatch in pairing reveal");
  }
  if (!invitation.commitment) {
    throw new Error("Pairing invitation is missing the ephemeral key commitment");
  }
  if (reveal.nonce !== invitation.nonce) {
    throw new Error("Pairing reveal nonce does not match the invitation nonce");
  }
  // 关键一步：承诺必须成立，否则发起方可能是在看到响应方密钥后挑选的临时密钥。
  if (!verifyPairingCommitment(invitation.commitment, reveal.ephemeralPublicKey, reveal.nonce)) {
    throw new Error("Pairing reveal does not match the committed ephemeral key (possible MITM)");
  }
  if (
    !verifyPeerFingerprint(
      invitation.initiatorDevice.publicKey,
      options.expectedRemoteFingerprint,
      computePublicKeyFingerprint(invitation.initiatorDevice.publicKey).length,
    )
  ) {
    throw new Error("Initiator fingerprint does not match the pinned fingerprint");
  }

  const responderEphemeralKey = pending.ephemeralEcdh.getPublicKey().toString("base64");
  const transcript = pairingTranscript({
    invitationId: invitation.invitationId,
    protocolVersion: P2P_PAIRING_PROTOCOL_VERSION,
    initiatorDeviceId: invitation.initiatorDevice.deviceId,
    initiatorPublicKey: invitation.initiatorDevice.publicKey,
    responderDeviceId: responder.deviceId,
    responderPublicKey: responder.publicKey,
    initiatorNonce: invitation.nonce,
    responderNonce: pending.nonce,
    initiatorEphemeralKey: reveal.ephemeralPublicKey,
    responderEphemeralKey,
    commitment: invitation.commitment,
  });

  const sharedSecret = pending.ephemeralEcdh.computeSecret(
    Buffer.from(reveal.ephemeralPublicKey, "base64"),
  );
  const keys = deriveSessionKeys(sharedSecret, invitation.nonce, pending.nonce);

  // 对端身份认证：发起方必须证明其持有 invitation.initiatorDevice.publicKey 的私钥。
  if (!verifyTranscriptSignature(invitation.initiatorDevice.publicKey, transcript, reveal.signature)) {
    throw new Error("Invalid signature in pairing reveal (initiator identity not proven)");
  }

  const expectedConfirmation = computeKeyConfirmation(
    keys.confirmation,
    CONFIRMATION_LABEL_INITIATOR,
    transcript,
  );
  if (!timingSafeEqualBase64(expectedConfirmation, reveal.keyConfirmation)) {
    throw new Error("Initiator failed to prove possession of the derived session key");
  }

  const session = createSession({
    sessionId: invitation.invitationId,
    localDeviceId: responder.deviceId,
    remoteDeviceId: invitation.initiatorDevice.deviceId,
    role: "responder",
    securityLevel: "committed",
    remoteFingerprint: computePublicKeyFingerprint(invitation.initiatorDevice.publicKey),
    keys,
  });

  // 响应方回执使用不同域分离标签，避免与发起方确认值相同（回声不能证明任何事）
  const keyConfirmation = computeKeyConfirmation(
    keys.confirmation,
    CONFIRMATION_LABEL_RESPONDER,
    transcript,
  );

  return { session, sasCode: computePairingSasFromTranscript(transcript), keyConfirmation };
}

/**
 * 发起方校验响应方的密钥确认（双向确认的最后一步）：
 * 响应方回执使用 `r2i` 域分离标签，因此把发起方自己的 `i2r` 确认值原样回传**不会**通过，
 * 只有独立派生出同一确认密钥的一方才算证明成立。
 */
export function verifyResponderKeyConfirmation(options: {
  session: EstablishedP2PSession;
  invitation: PairingInvitation;
  response: PairingResponse;
  /** 发起方自己的临时公钥（`pending.ephemeralEcdh.getPublicKey()` 的 base64） */
  initiatorEphemeralPublicKey: string;
  keyConfirmation: string;
}): boolean {
  const state = sessionStates.get(options.session);
  if (!state || state.confirmationKey.length === 0 || !options.invitation.commitment) return false;
  const transcript = pairingTranscript({
    invitationId: options.invitation.invitationId,
    protocolVersion: P2P_PAIRING_PROTOCOL_VERSION,
    initiatorDeviceId: options.invitation.initiatorDevice.deviceId,
    initiatorPublicKey: options.invitation.initiatorDevice.publicKey,
    responderDeviceId: options.response.responderDevice.deviceId,
    responderPublicKey: options.response.responderDevice.publicKey,
    initiatorNonce: options.invitation.nonce,
    responderNonce: options.response.nonce,
    initiatorEphemeralKey: options.initiatorEphemeralPublicKey,
    responderEphemeralKey: options.response.ephemeralPublicKey,
    commitment: options.invitation.commitment,
  });
  const expected = computeKeyConfirmation(
    state.confirmationKey,
    CONFIRMATION_LABEL_RESPONDER,
    transcript,
  );
  return timingSafeEqualBase64(expected, options.keyConfirmation);
}

/**
 * 用户确认 SAS 一致后调用，把会话标记为可用（并返回同一个会话对象）。
 * committed 会话在此之前调用 `encryptSyncPayload` 会抛错（fail-closed）。
 */
export function markSessionVerified(session: EstablishedP2PSession): EstablishedP2PSession {
  if (session.securityLevel !== "committed") {
    throw new Error(
      "Only commit-reveal sessions can be marked verified; legacy uncommitted handshakes are not MITM-safe",
    );
  }
  session.verified = true;
  return session;
}

// ---------------------------------------------------------------------------
// 遗留两消息路径（不安全，仅为兼容保留）
// ---------------------------------------------------------------------------

/**
 * @deprecated 遗留路径：无承诺，SAS 可被离线爆破，不具备防中间人性质。
 * 请使用 `beginPairing` / `respondToPairing` / `completePairingAsInitiatorV2` /
 * `finalizePairingAsResponder`。
 */
export function createPairingInvitation(
  initiator: P2PDeviceIdentity,
): { invitation: PairingInvitation; ephemeralEcdh: crypto.ECDH } {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const ephemeralPublicKey = ecdh.getPublicKey().toString("base64");

  const invitation: PairingInvitation = {
    invitationId: `inv_${crypto.randomBytes(8).toString("hex")}`,
    protocolVersion: P2P_PAIRING_PROTOCOL_VERSION,
    initiatorDevice: deviceSummary(initiator),
    ephemeralPublicKey,
    timestamp: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString("hex"),
  };

  return { invitation, ephemeralEcdh: ecdh };
}

/**
 * @deprecated 遗留路径响应方：无承诺校验，仅用于兼容既有调用。
 */
export function acceptPairingInvitation(
  responder: P2PDeviceIdentity,
  invitation: PairingInvitation,
): { confirmation: PairingConfirmation; session: EstablishedP2PSession } {
  if (!invitation.ephemeralPublicKey) {
    throw new Error(
      "Legacy acceptPairingInvitation requires invitation.ephemeralPublicKey; use respondToPairing for commit-reveal",
    );
  }
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const responderEphemeralKey = ecdh.getPublicKey().toString("base64");

  const rawSharedSecret = ecdh.computeSecret(
    Buffer.from(invitation.ephemeralPublicKey, "base64"),
  );
  const sasCode = computePairingSas(
    invitation.initiatorDevice.publicKey,
    responder.publicKey,
    invitation.ephemeralPublicKey,
    responderEphemeralKey,
    invitation.nonce,
  );

  const signPayload = Buffer.from(
    `${invitation.invitationId}:${sasCode}:${invitation.nonce}`,
  );
  const signature = crypto.sign(null, signPayload, responder.privateKey).toString("base64");

  const confirmation: PairingConfirmation = {
    invitationId: invitation.invitationId,
    responderDevice: deviceSummary(responder),
    ephemeralPublicKey: responderEphemeralKey,
    sasCode,
    signature,
  };

  const keys = deriveSessionKeys(rawSharedSecret, invitation.nonce, invitation.nonce);
  const session = createSession({
    sessionId: invitation.invitationId,
    localDeviceId: responder.deviceId,
    remoteDeviceId: invitation.initiatorDevice.deviceId,
    role: "responder",
    securityLevel: "legacy_uncommitted",
    remoteFingerprint: computePublicKeyFingerprint(invitation.initiatorDevice.publicKey),
    keys,
  });

  return { confirmation, session };
}

/**
 * @deprecated 遗留路径发起方：无承诺，SAS 可被离线爆破，不能用于真实配对。
 */
export function completePairingAsInitiator(
  initiator: P2PDeviceIdentity,
  invitation: PairingInvitation,
  ephemeralEcdh: crypto.ECDH,
  confirmation: PairingConfirmation,
): { session: EstablishedP2PSession; sasCode: string } {
  if (confirmation.invitationId !== invitation.invitationId) {
    throw new Error("Invitation ID mismatch in confirmation");
  }

  const signPayload = Buffer.from(
    `${invitation.invitationId}:${confirmation.sasCode}:${invitation.nonce}`,
  );
  const verified = verifyTranscriptSignature(
    confirmation.responderDevice.publicKey,
    signPayload.toString("utf8"),
    confirmation.signature,
  );
  if (!verified) {
    throw new Error("Invalid signature in pairing confirmation");
  }

  const initiatorEphemeralKey = ephemeralEcdh.getPublicKey().toString("base64");
  const expectedSas = computePairingSas(
    initiator.publicKey,
    confirmation.responderDevice.publicKey,
    initiatorEphemeralKey,
    confirmation.ephemeralPublicKey,
    invitation.nonce,
  );
  if (confirmation.sasCode !== expectedSas) {
    throw new Error("SAS code mismatch (possible man-in-the-middle)");
  }

  const rawSharedSecret = ephemeralEcdh.computeSecret(
    Buffer.from(confirmation.ephemeralPublicKey, "base64"),
  );
  const keys = deriveSessionKeys(rawSharedSecret, invitation.nonce, invitation.nonce);
  const session = createSession({
    sessionId: invitation.invitationId,
    localDeviceId: initiator.deviceId,
    remoteDeviceId: confirmation.responderDevice.deviceId,
    role: "initiator",
    securityLevel: "legacy_uncommitted",
    remoteFingerprint: computePublicKeyFingerprint(confirmation.responderDevice.publicKey),
    keys,
  });

  return { session, sasCode: expectedSas };
}

// ---------------------------------------------------------------------------
// 会话加密
// ---------------------------------------------------------------------------

interface SyncCryptoOptions {
  /** 仅用于兼容遗留路径：允许未验证/未承诺会话参与加密（默认 false，fail-closed） */
  allowUncommittedSession?: boolean;
}

function stateFor(session: EstablishedP2PSession): SessionCryptoState {
  const existing = sessionStates.get(session);
  if (existing) return existing;
  // 手工构造的会话（非本模块配对产出）没有确认密钥，密钥确认校验会 fail-closed 返回 false。
  const created: SessionCryptoState = {
    noncePrefix: crypto.randomBytes(4),
    nextSendSequence: 0,
    highestReceivedSequence: -1,
    confirmationKey: Buffer.alloc(0),
  };
  sessionStates.set(session, created);
  return created;
}

function assertSessionUsable(
  session: EstablishedP2PSession,
  options: SyncCryptoOptions,
): void {
  if (session.securityLevel === "committed" && !session.verified) {
    throw new Error(
      "Pairing session is not verified yet: confirm the 6-digit SAS and call markSessionVerified before syncing",
    );
  }
  if (session.securityLevel === "legacy_uncommitted" && !options.allowUncommittedSession) {
    throw new Error(
      "Legacy uncommitted pairing session cannot be used for sync (not MITM-safe); " +
        "use the commit-reveal pairing flow or pass allowUncommittedSession explicitly",
    );
  }
}

function buildAad(session: EstablishedP2PSession, direction: string, sequence: number): Buffer {
  return Buffer.from(
    lengthPrefixed([
      `${HKDF_INFO_PREFIX}/aad`,
      session.sessionId,
      direction,
      String(sequence),
    ]),
    "utf8",
  );
}

function buildNonce(prefix: Buffer, sequence: number): Buffer {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(sequence));
  return Buffer.concat([prefix, counter]);
}

/** 使用会话发送密钥对同步数据执行 AES-256-GCM 加密（带序号与 AAD 绑定） */
export function encryptSyncPayload(
  session: EstablishedP2PSession,
  data: unknown,
  options: SyncCryptoOptions = {},
): EncryptedSyncPayload {
  assertSessionUsable(session, options);
  const state = stateFor(session);
  const sequence = state.nextSendSequence;
  const direction = directionFor(session.role);
  const nonce = buildNonce(state.noncePrefix, sequence);

  const cipher = crypto.createCipheriv("aes-256-gcm", session.sendKey, nonce);
  cipher.setAAD(buildAad(session, direction, sequence));
  const json = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  state.nextSendSequence = sequence + 1;

  return {
    version: P2P_PAIRING_PROTOCOL_VERSION,
    sessionId: session.sessionId,
    sequence,
    direction,
    iv: nonce.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/**
 * 使用会话接收密钥解密并校验：版本、会话 ID、方向、AAD、GCM 认证标签与序号单调性。
 * 序号不严格大于已见最大值的报文（重放/乱序）一律拒绝。
 */
export function decryptSyncPayload<T = unknown>(
  session: EstablishedP2PSession,
  payload: EncryptedSyncPayload,
  options: SyncCryptoOptions = {},
): T {
  assertSessionUsable(session, options);
  if (payload.version !== P2P_PAIRING_PROTOCOL_VERSION) {
    throw new Error(
      `Unsupported sync payload version: ${payload.version} (expected ${P2P_PAIRING_PROTOCOL_VERSION})`,
    );
  }
  if (payload.sessionId !== session.sessionId) {
    throw new Error(`Session ID mismatch: expected ${session.sessionId}, got ${payload.sessionId}`);
  }
  const expectedDirection = oppositeDirection(session.role);
  if (payload.direction !== expectedDirection) {
    throw new Error(
      `Unexpected sync payload direction: ${payload.direction} (expected ${expectedDirection})`,
    );
  }
  const state = stateFor(session);
  if (!Number.isInteger(payload.sequence) || payload.sequence <= state.highestReceivedSequence) {
    throw new Error(
      `Replayed or out-of-order sync payload: sequence ${payload.sequence} <= ${state.highestReceivedSequence}`,
    );
  }

  const nonce = Buffer.from(payload.iv, "base64");
  if (nonce.length !== 12) {
    throw new Error(`Invalid sync payload nonce length: ${nonce.length}`);
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", session.receiveKey, nonce);
  decipher.setAAD(buildAad(session, payload.direction, payload.sequence));
  decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "base64")),
    decipher.final(),
  ]);

  state.highestReceivedSequence = payload.sequence;
  return JSON.parse(decrypted.toString("utf8")) as T;
}
