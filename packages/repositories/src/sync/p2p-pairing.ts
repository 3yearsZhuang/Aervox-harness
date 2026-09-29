/**
 * Aervox｜思隅 @aervox/repositories — 纯本地多端 P2P 设备发现与配对握手（ITER-028）
 *
 * 设计依据：
 * - CR-030 零多租户、纯本地个人真源：无中心化云端数据库，数据主权完全归属单用户；
 * - CR-055 / CAP-018 / CAP-027：局域网内桌面端（Electron）与移动端（Capacitor）点对点安全直连；
 * - 零信任配对：通过 mDNS / UDP 广播同网发现，基于 6 位短身份验证码（SAS, Short Authentication String）
 *   与 ECDH / Ed25519 公钥交换确认，派生会话密钥后使用 AES-256-GCM 加密全量同步流量。
 */
import crypto from "node:crypto";

/** 发现广播服务名与协议版本 */
export const P2P_DISCOVERY_SERVICE_TYPE = "_aervox-sync._tcp";
export const P2P_PROTOCOL_VERSION = "v1";

/** 设备身份信息 */
export interface P2PDeviceIdentity {
  deviceId: string;
  deviceName: string;
  publicKey: string; // PEM 或 Base64 格式公钥
  privateKey: string; // 私钥（仅本机持有，严禁外传）
}

/** 局域网广播暴露的设备描述信息（可由 mDNS TXT 记录或 UDP Multicast 广播） */
export interface P2PDeviceDescriptor {
  deviceId: string;
  deviceName: string;
  publicKey: string;
  host: string;
  port: number;
  protocolVersion: string;
  fingerprint: string; // 公钥 SHA-256 指纹（前 12 字符）
}

/** 配对邀请与握手报文 */
export interface PairingInvitation {
  invitationId: string;
  initiatorDevice: Omit<P2PDeviceDescriptor, "host" | "port">;
  ephemeralPublicKey: string; // 用于 ECDH 派生配对密钥的临时公钥
  timestamp: string;
  nonce: string;
}

export interface PairingConfirmation {
  invitationId: string;
  responderDevice: Omit<P2PDeviceDescriptor, "host" | "port">;
  ephemeralPublicKey: string;
  sasCode: string; // 6 位短验证码
  signature: string; // 响应端私钥对 (invitationId + sasCode + nonce) 的签名
}

export interface EstablishedP2PSession {
  sessionId: string;
  localDeviceId: string;
  remoteDeviceId: string;
  sharedKey: Buffer; // 32 字节 AES-256-GCM 会话密钥
  establishedAt: string;
}

/** 加密同步消息载荷 */
export interface EncryptedSyncPayload {
  version: string;
  sessionId: string;
  iv: string; // Base64 12 字节 IV
  ciphertext: string; // Base64 密文
  authTag: string; // Base64 16 字节 GCM 认证标签
}

/** 生成本机永久设备身份（Ed25519 密钥对） */
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

/** 从公钥计算指纹 */
export function computePublicKeyFingerprint(publicKeyPem: string): string {
  return crypto.createHash("sha256").update(publicKeyPem.trim()).digest("hex").slice(0, 12);
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

/**
 * 计算 6 位短身份验证码（SAS, Short Authentication String）
 * 两端根据双方公钥、临时密钥与随机 nonce 独立派生，完全一致时由用户在界面核验“428 915”，
 * 杜绝中间人（MITM）嗅探与伪造攻击。
 */
export function computePairingSas(
  initiatorPubKey: string,
  responderPubKey: string,
  initiatorEphemeralKey: string,
  responderEphemeralKey: string,
  nonce: string,
): string {
  const hash = crypto
    .createHash("sha256")
    .update(initiatorPubKey)
    .update(responderPubKey)
    .update(initiatorEphemeralKey)
    .update(responderEphemeralKey)
    .update(nonce)
    .digest();

  // 取哈希前 4 字节按十进制取余 1,000,000 得到 6 位数字
  const num = hash.readUInt32BE(0) % 1_000_000;
  return num.toString().padStart(6, "0");
}

/** 发起方创建配对邀请 */
export function createPairingInvitation(
  initiator: P2PDeviceIdentity,
): { invitation: PairingInvitation; ephemeralEcdh: crypto.ECDH } {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const ephemeralPublicKey = ecdh.getPublicKey().toString("base64");

  const invitation: PairingInvitation = {
    invitationId: `inv_${crypto.randomBytes(8).toString("hex")}`,
    initiatorDevice: {
      deviceId: initiator.deviceId,
      deviceName: initiator.deviceName,
      publicKey: initiator.publicKey,
      protocolVersion: P2P_PROTOCOL_VERSION,
      fingerprint: computePublicKeyFingerprint(initiator.publicKey),
    },
    ephemeralPublicKey,
    timestamp: new Date().toISOString(),
    nonce: crypto.randomBytes(16).toString("hex"),
  };

  return { invitation, ephemeralEcdh: ecdh };
}

/** 响应方核验邀请并生成确认回执（含 SAS 码与派生密钥） */
export function acceptPairingInvitation(
  responder: P2PDeviceIdentity,
  invitation: PairingInvitation,
): { confirmation: PairingConfirmation; session: EstablishedP2PSession } {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const responderEphemeralKey = ecdh.getPublicKey().toString("base64");

  // 计算双方共享秘密 (ECDH)
  const initiatorEphemeralBuf = Buffer.from(invitation.ephemeralPublicKey, "base64");
  const rawSharedSecret = ecdh.computeSecret(initiatorEphemeralBuf);

  // 计算 6 位用户确认码
  const sasCode = computePairingSas(
    invitation.initiatorDevice.publicKey,
    responder.publicKey,
    invitation.ephemeralPublicKey,
    responderEphemeralKey,
    invitation.nonce,
  );

  // 对握手要素签名
  const signPayload = Buffer.from(`${invitation.invitationId}:${sasCode}:${invitation.nonce}`);
  const signature = crypto.sign(null, signPayload, responder.privateKey).toString("base64");

  const confirmation: PairingConfirmation = {
    invitationId: invitation.invitationId,
    responderDevice: {
      deviceId: responder.deviceId,
      deviceName: responder.deviceName,
      publicKey: responder.publicKey,
      protocolVersion: P2P_PROTOCOL_VERSION,
      fingerprint: computePublicKeyFingerprint(responder.publicKey),
    },
    ephemeralPublicKey: responderEphemeralKey,
    sasCode,
    signature,
  };

  // 通过 HKDF 派生 32 字节 AES-256-GCM 对称会话密钥
  const sharedKey = crypto.hkdfSync(
    "sha256",
    rawSharedSecret,
    Buffer.from(invitation.nonce),
    Buffer.from("aervox-p2p-session-v1"),
    32,
  );

  const session: EstablishedP2PSession = {
    sessionId: invitation.invitationId,
    localDeviceId: responder.deviceId,
    remoteDeviceId: invitation.initiatorDevice.deviceId,
    sharedKey: Buffer.from(sharedKey),
    establishedAt: new Date().toISOString(),
  };

  return { confirmation, session };
}

/** 发起方验证响应方的确认回执并建立会话 */
export function completePairingAsInitiator(
  initiator: P2PDeviceIdentity,
  invitation: PairingInvitation,
  ephemeralEcdh: crypto.ECDH,
  confirmation: PairingConfirmation,
): { session: EstablishedP2PSession; sasCode: string } {
  if (confirmation.invitationId !== invitation.invitationId) {
    throw new Error("Invitation ID mismatch in confirmation");
  }

  // 1. 验证签名（确保回执来自持有对应公钥的设备）
  const signPayload = Buffer.from(`${invitation.invitationId}:${confirmation.sasCode}:${invitation.nonce}`);
  const verified = crypto.verify(
    null,
    signPayload,
    confirmation.responderDevice.publicKey,
    Buffer.from(confirmation.signature, "base64"),
  );
  if (!verified) {
    throw new Error("Invalid signature in pairing confirmation");
  }

  // 2. 独立重新计算 SAS 码，确保一致
  const expectedSas = computePairingSas(
    initiator.publicKey,
    confirmation.responderDevice.publicKey,
    invitation.ephemeralPublicKey,
    confirmation.ephemeralPublicKey,
    invitation.nonce,
  );
  if (confirmation.sasCode !== expectedSas) {
    throw new Error("SAS code mismatch (possible man-in-the-middle)");
  }

  // 3. 计算 ECDH 共享密钥并 HKDF 派生
  const responderEphemeralBuf = Buffer.from(confirmation.ephemeralPublicKey, "base64");
  const rawSharedSecret = ephemeralEcdh.computeSecret(responderEphemeralBuf);

  const sharedKey = crypto.hkdfSync(
    "sha256",
    rawSharedSecret,
    Buffer.from(invitation.nonce),
    Buffer.from("aervox-p2p-session-v1"),
    32,
  );

  const session: EstablishedP2PSession = {
    sessionId: invitation.invitationId,
    localDeviceId: initiator.deviceId,
    remoteDeviceId: confirmation.responderDevice.deviceId,
    sharedKey: Buffer.from(sharedKey),
    establishedAt: new Date().toISOString(),
  };

  return { session, sasCode: expectedSas };
}

/** 使用会话对称密钥对同步数据执行 AES-256-GCM 加密 */
export function encryptSyncPayload(session: EstablishedP2PSession, data: unknown): EncryptedSyncPayload {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", session.sharedKey, iv);
  const json = JSON.stringify(data);
  const encrypted = Buffer.concat([cipher.update(json, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    version: P2P_PROTOCOL_VERSION,
    sessionId: session.sessionId,
    iv: iv.toString("base64"),
    ciphertext: encrypted.toString("base64"),
    authTag: authTag.toString("base64"),
  };
}

/** 使用会话对称密钥解密并验签同步数据 */
export function decryptSyncPayload<T = unknown>(session: EstablishedP2PSession, payload: EncryptedSyncPayload): T {
  if (payload.sessionId !== session.sessionId) {
    throw new Error(`Session ID mismatch: expected ${session.sessionId}, got ${payload.sessionId}`);
  }

  const iv = Buffer.from(payload.iv, "base64");
  const authTag = Buffer.from(payload.authTag, "base64");
  const encrypted = Buffer.from(payload.ciphertext, "base64");

  const decipher = crypto.createDecipheriv("aes-256-gcm", session.sharedKey, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}
