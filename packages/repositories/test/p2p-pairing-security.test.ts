/**
 * ITER-028 配对与传输安全回归：承诺-揭示、分向密钥、重放拒绝、fail-closed 与身份落盘。
 *
 * 这些用例对应评审发现的安全缺陷：
 * - 原实现无承诺，6 位 SAS 可被离线爆破（攻击者离线挑选临时密钥使两端看到同一 SAS）；
 * - 原实现双向共用同一把对称密钥，无方向绑定、无序号，密文可原样重放；
 * - 原实现设备私钥从不落盘，文档却称"不可导出"；
 * - 原实现对未验证会话直接放行加密。
 */
import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import {
  beginPairing,
  computePairingCommitment,
  completePairingAsInitiatorV2,
  computePublicKeyFingerprint,
  createPairingInvitation,
  acceptPairingInvitation,
  completePairingAsInitiator,
  decryptSyncPayload,
  encryptSyncPayload,
  finalizePairingAsResponder,
  generateDeviceIdentity,
  loadDeviceIdentity,
  loadOrCreateDeviceIdentity,
  markSessionVerified,
  respondToPairing,
  verifyPairingCommitment,
  verifyPeerFingerprint,
  verifyResponderKeyConfirmation,
  type PairingInvitation,
} from "../src/index.js";

function newIdentity(name: string, prefix: string) {
  return generateDeviceIdentity(name, prefix);
}

describe("ITER-028 承诺-揭示配对", () => {
  it("完整握手成功：两端 SAS 一致、双向密钥确认成立、会话初始未验证", () => {
    const initiator = newIdentity("桌面端", "desktop");
    const responder = newIdentity("移动端", "mobile");

    const pending = beginPairing(initiator);
    // 消息 1 不得泄露临时公钥，否则承诺形同虚设
    expect(pending.invitation.ephemeralPublicKey).toBeUndefined();
    expect(pending.invitation.commitment).toBeTruthy();

    const { response, pending: pendingResponder } = respondToPairing(
      responder,
      pending.invitation,
    );
    const completed = completePairingAsInitiatorV2(initiator, pending, response);
    const finalized = finalizePairingAsResponder(
      responder,
      pendingResponder,
      pending.invitation,
      completed.reveal,
    );

    expect(finalized.sasCode).toBe(completed.sasCode);
    expect(completed.sasCode).toMatch(/^\d{6}$/);
    expect(completed.session.verified).toBe(false);
    expect(finalized.session.verified).toBe(false);
    expect(completed.session.securityLevel).toBe("committed");

    // 双向密钥确认：响应方证明自己派生出了同一密钥
    expect(
      verifyResponderKeyConfirmation({
        session: completed.session,
        invitation: pending.invitation,
        response,
        initiatorEphemeralPublicKey: pending.ephemeralEcdh.getPublicKey().toString("base64"),
        keyConfirmation: finalized.keyConfirmation,
      }),
    ).toBe(true);
  });

  it("未验证的 committed 会话禁止加密（fail-closed），确认 SAS 后才可用", () => {
    const initiator = newIdentity("桌面端", "desktop");
    const responder = newIdentity("移动端", "mobile");
    const pending = beginPairing(initiator);
    const { response, pending: pendingResponder } = respondToPairing(
      responder,
      pending.invitation,
    );
    const completed = completePairingAsInitiatorV2(initiator, pending, response);
    const finalized = finalizePairingAsResponder(
      responder,
      pendingResponder,
      pending.invitation,
      completed.reveal,
    );

    expect(() => encryptSyncPayload(completed.session, { a: 1 })).toThrow(/not verified/i);

    markSessionVerified(completed.session);
    markSessionVerified(finalized.session);
    const payload = encryptSyncPayload(completed.session, { a: 1 });
    expect(decryptSyncPayload(finalized.session, payload)).toEqual({ a: 1 });
  });

  it("承诺不可抵赖：揭示的临时公钥与承诺不符时拒绝（阻止事后挑密钥）", () => {
    const initiator = newIdentity("桌面端", "desktop");
    const responder = newIdentity("移动端", "mobile");
    const pending = beginPairing(initiator);
    const { response, pending: pendingResponder } = respondToPairing(responder, pending.invitation);
    // 先走完整的合法流程取得真实揭示报文
    const completed = completePairingAsInitiatorV2(initiator, pending, response);

    // 发起方（或被篡改的发送方）把临时公钥换成一个"更能凑出目标 SAS"的密钥，
    // 由于承诺已先行发出，这一改动必然被响应方发现。
    const forgedEphemeral = crypto.createECDH("prime256v1");
    forgedEphemeral.generateKeys();
    expect(() =>
      finalizePairingAsResponder(responder, pendingResponder, pending.invitation, {
        ...completed.reveal,
        ephemeralPublicKey: forgedEphemeral.getPublicKey().toString("base64"),
      }),
    ).toThrow(/committed ephemeral key/i);
  });

  it("verifyPairingCommitment 只接受完全一致的公钥与 nonce", () => {
    const ecdh = crypto.createECDH("prime256v1");
    ecdh.generateKeys();
    const ephemeral = ecdh.getPublicKey().toString("base64");
    const commitment = computePairingCommitment(ephemeral, "nonce-a");
    expect(verifyPairingCommitment(commitment, ephemeral, "nonce-a")).toBe(true);
    expect(verifyPairingCommitment(commitment, ephemeral, "nonce-b")).toBe(false);
    const other = crypto.createECDH("prime256v1");
    other.generateKeys();
    expect(verifyPairingCommitment(commitment, other.getPublicKey().toString("base64"), "nonce-a")).toBe(
      false,
    );
  });

  it("中间人替换承诺会被发现并拒绝（消息 1 被篡改）", () => {
    const initiator = newIdentity("桌面端", "desktop");
    const responder = newIdentity("移动端", "mobile");

    const pending = beginPairing(initiator);
    // 中间人用自己的临时密钥伪造承诺转发给响应方
    const mitmEphemeral = crypto.createECDH("prime256v1");
    mitmEphemeral.generateKeys();
    const tamperedInvitation: PairingInvitation = {
      ...pending.invitation,
      commitment: computePairingCommitment(
        mitmEphemeral.getPublicKey().toString("base64"),
        pending.invitation.nonce,
      ),
    };

    const { response, pending: pendingResponder } = respondToPairing(
      responder,
      tamperedInvitation,
    );
    // 发起方持有原始承诺：篡改会在响应方签名校验阶段就被发现（更早的拦截），
    // 即便绕过签名，承诺校验也会拒绝。两种路径都必须抛错。
    expect(() => completePairingAsInitiatorV2(initiator, pending, response)).toThrow(
      /Invalid signature in pairing response/i,
    );

    // 另一条独立路径：即使签名层被绕过，发起方揭示的真实临时公钥
    // 也无法通过被篡改承诺的校验（承诺校验先于签名校验执行）。
    expect(() =>
      finalizePairingAsResponder(responder, pendingResponder, tamperedInvitation, {
        invitationId: tamperedInvitation.invitationId,
        ephemeralPublicKey: pending.ephemeralEcdh.getPublicKey().toString("base64"),
        nonce: pending.invitation.nonce,
        signature: "AAAA",
        keyConfirmation: "AAAA",
      }),
    ).toThrow(/committed ephemeral key/i);
  });

  it("SAS 绑定完整 transcript：任一握手要素变化都会改变 SAS", () => {
    const build = (responderName: string) => {
      const initiator = newIdentity("桌面端", "desktop");
      const responder = newIdentity(responderName, "mobile");
      const pending = beginPairing(initiator);
      const { response, pending: pendingResponder } = respondToPairing(
        responder,
        pending.invitation,
      );
      const completed = completePairingAsInitiatorV2(initiator, pending, response);
      const finalized = finalizePairingAsResponder(
        responder,
        pendingResponder,
        pending.invitation,
        completed.reveal,
      );
      return { sas: completed.sasCode, other: finalized.sasCode };
    };
    const first = build("移动端 A");
    const second = build("移动端 B");
    // 对端身份不同（设备 ID/公钥不同）→ 两端看到的 SAS 不可能相同，
    // 这正是中间人无法让双方看到同一 6 位码的原因。
    expect(first.sas).not.toBe(second.sas);
  });

  it("拒绝过期邀请与错误的协议版本", () => {
    const initiator = newIdentity("桌面端", "desktop");
    const responder = newIdentity("移动端", "mobile");
    const pending = beginPairing(initiator);

    expect(() =>
      respondToPairing(responder, {
        ...pending.invitation,
        protocolVersion: "v1",
      }),
    ).toThrow(/Unsupported pairing protocol version/i);

    expect(() =>
      respondToPairing(responder, {
        ...pending.invitation,
        timestamp: new Date(Date.now() - 10 * 60_000).toISOString(),
      }),
    ).toThrow(/stale/i);

    expect(() =>
      respondToPairing(responder, { ...pending.invitation, commitment: undefined }),
    ).toThrow(/missing the ephemeral key commitment/i);
  });

  it("响应方密钥确认使用独立域分离标签：把发起方确认值回声回去不能通过", () => {
    const initiator = newIdentity("桌面端", "desktop");
    const responder = newIdentity("移动端", "mobile");
    const pending = beginPairing(initiator);
    const { response, pending: pendingResponder } = respondToPairing(responder, pending.invitation);
    const completed = completePairingAsInitiatorV2(initiator, pending, response);
    const finalized = finalizePairingAsResponder(
      responder,
      pendingResponder,
      pending.invitation,
      completed.reveal,
    );

    const base = {
      session: completed.session,
      invitation: pending.invitation,
      response,
      initiatorEphemeralPublicKey: pending.ephemeralEcdh.getPublicKey().toString("base64"),
    };

    // 真实响应方确认值通过
    expect(
      verifyResponderKeyConfirmation({ ...base, keyConfirmation: finalized.keyConfirmation }),
    ).toBe(true);

    // 旧实现两侧使用同一 HMAC，回声即可通过——这正是"确认"退化为回声的缺陷
    expect(
      verifyResponderKeyConfirmation({
        ...base,
        keyConfirmation: completed.reveal.keyConfirmation,
      }),
    ).toBe(false);
    expect(verifyResponderKeyConfirmation({ ...base, keyConfirmation: "AAAA" })).toBe(false);
  });

  it("发起方必须证明身份私钥持有：揭示签名被伪造或出自他人密钥时拒绝", () => {
    const initiator = newIdentity("桌面端", "desktop");
    const responder = newIdentity("移动端", "mobile");
    const attacker = newIdentity("攻击者", "evil");
    const pending = beginPairing(initiator);
    const { response, pending: pendingResponder } = respondToPairing(responder, pending.invitation);
    const completed = completePairingAsInitiatorV2(initiator, pending, response);

    // 攻击者用自己的私钥签署同一 message：公钥校验必须失败
    const forged = crypto
      .sign(null, Buffer.from("whatever"), attacker.privateKey)
      .toString("base64");
    expect(() =>
      finalizePairingAsResponder(responder, pendingResponder, pending.invitation, {
        ...completed.reveal,
        signature: forged,
      }),
    ).toThrow(/initiator identity not proven/i);

    // 合法揭示仍然通过（签名覆盖完整 transcript，且承诺一致）
    expect(() =>
      finalizePairingAsResponder(responder, pendingResponder, pending.invitation, completed.reveal),
    ).not.toThrow();
  });

  it("指纹固定：与固定值不一致时拒绝建立会话", () => {
    const initiator = newIdentity("桌面端", "desktop");
    const responder = newIdentity("移动端", "mobile");
    const pending = beginPairing(initiator);
    const { response } = respondToPairing(responder, pending.invitation);

    expect(verifyPeerFingerprint(response.responderDevice.publicKey, undefined)).toBe(true);
    expect(
      verifyPeerFingerprint(
        response.responderDevice.publicKey,
        computePublicKeyFingerprint(response.responderDevice.publicKey),
      ),
    ).toBe(true);
    expect(verifyPeerFingerprint(response.responderDevice.publicKey, "deadbeef0000")).toBe(false);
    expect(() =>
      completePairingAsInitiatorV2(initiator, pending, response, {
        expectedRemoteFingerprint: "deadbeef0000",
      }),
    ).toThrow(/pinned fingerprint/i);
  });
});

describe("ITER-028 分向密钥、重放与篡改防护", () => {
  function verifiedPair() {
    const initiator = newIdentity("桌面端", "desktop");
    const responder = newIdentity("移动端", "mobile");
    const pending = beginPairing(initiator);
    const { response, pending: pendingResponder } = respondToPairing(
      responder,
      pending.invitation,
    );
    const completed = completePairingAsInitiatorV2(initiator, pending, response);
    const finalized = finalizePairingAsResponder(
      responder,
      pendingResponder,
      pending.invitation,
      completed.reveal,
    );
    markSessionVerified(completed.session);
    markSessionVerified(finalized.session);
    return { initiator: completed.session, responder: finalized.session };
  }

  it("分向密钥：A 的发送密钥等于 B 的接收密钥，且发送/接收密钥不同", () => {
    const { initiator, responder } = verifiedPair();
    expect(initiator.sendKey.equals(responder.receiveKey)).toBe(true);
    expect(responder.sendKey.equals(initiator.receiveKey)).toBe(true);
    expect(initiator.sendKey.equals(initiator.receiveKey)).toBe(false);
    expect(initiator.role).toBe("initiator");
    expect(responder.role).toBe("responder");
  });

  it("方向绑定：自己加密的报文不能由自己解密", () => {
    const { initiator } = verifiedPair();
    const payload = encryptSyncPayload(initiator, { a: 1 });
    expect(() => decryptSyncPayload(initiator, payload)).toThrow(/direction/i);
  });

  it("重放拒绝：同一密文第二次解密必须失败", () => {
    const { initiator, responder } = verifiedPair();
    const payload = encryptSyncPayload(initiator, { a: 1 });
    expect(decryptSyncPayload(responder, payload)).toEqual({ a: 1 });
    expect(() => decryptSyncPayload(responder, payload)).toThrow(/Replayed or out-of-order/i);
  });

  it("乱序拒绝：序号回退的报文必须失败", () => {
    const { initiator, responder } = verifiedPair();
    const first = encryptSyncPayload(initiator, { n: 1 });
    const second = encryptSyncPayload(initiator, { n: 2 });
    expect(decryptSyncPayload(responder, second)).toEqual({ n: 2 });
    expect(() => decryptSyncPayload(responder, first)).toThrow(/Replayed or out-of-order/i);
  });

  it("篡改检测：密文/认证标签被改动后解密失败", () => {
    const { initiator, responder } = verifiedPair();
    const payload = encryptSyncPayload(initiator, { secret: "值" });
    const tamperedCiphertext = {
      ...payload,
      ciphertext: Buffer.from(
        Buffer.from(payload.ciphertext, "base64").map((byte, index) =>
          index === 0 ? byte ^ 0xff : byte,
        ),
      ).toString("base64"),
    };
    expect(() => decryptSyncPayload(responder, tamperedCiphertext)).toThrow();

    const { initiator: initiator2, responder: responder2 } = verifiedPair();
    const payload2 = encryptSyncPayload(initiator2, { secret: "值" });
    const tamperedTag = {
      ...payload2,
      authTag: Buffer.from(
        Buffer.from(payload2.authTag, "base64").map((byte, index) =>
          index === 0 ? byte ^ 0xff : byte,
        ),
      ).toString("base64"),
    };
    expect(() => decryptSyncPayload(responder2, tamperedTag)).toThrow();
  });

  it("版本门禁：不兼容载荷版本被拒绝", () => {
    const { initiator, responder } = verifiedPair();
    const payload = encryptSyncPayload(initiator, { a: 1 });
    expect(() => decryptSyncPayload(responder, { ...payload, version: "v99" })).toThrow(
      /Unsupported sync payload version/i,
    );
    expect(() => decryptSyncPayload(responder, { ...payload, sessionId: "other" })).toThrow(
      /Session ID mismatch/i,
    );
  });

  it("每条报文的 nonce 前缀相同但计数器不同（不重复使用 nonce）", () => {
    const { initiator } = verifiedPair();
    const first = encryptSyncPayload(initiator, { n: 1 });
    const second = encryptSyncPayload(initiator, { n: 2 });
    const nonceA = Buffer.from(first.iv, "base64");
    const nonceB = Buffer.from(second.iv, "base64");
    expect(nonceA.length).toBe(12);
    expect(nonceA.subarray(0, 4).equals(nonceB.subarray(0, 4))).toBe(true);
    expect(nonceA.equals(nonceB)).toBe(false);
    expect(first.sequence).toBe(0);
    expect(second.sequence).toBe(1);
  });
});

describe("ITER-028 遗留路径与设备身份落盘", () => {
  it("遗留两消息路径默认被拒绝加密，显式放行后仍可往返（兼容但标记不安全）", () => {
    const initiator = newIdentity("桌面端", "desktop");
    const responder = newIdentity("移动端", "mobile");
    const { invitation, ephemeralEcdh } = createPairingInvitation(initiator);
    const { confirmation, session: responderSession } = acceptPairingInvitation(
      responder,
      invitation,
    );
    const { session: initiatorSession } = completePairingAsInitiator(
      initiator,
      invitation,
      ephemeralEcdh,
      confirmation,
    );

    expect(initiatorSession.securityLevel).toBe("legacy_uncommitted");
    expect(() => encryptSyncPayload(initiatorSession, { a: 1 })).toThrow(/not MITM-safe/i);
    expect(() => markSessionVerified(initiatorSession)).toThrow(/commit-reveal/i);

    const payload = encryptSyncPayload(initiatorSession, { a: 1 }, {
      allowUncommittedSession: true,
    });
    expect(
      decryptSyncPayload(responderSession, payload, { allowUncommittedSession: true }),
    ).toEqual({ a: 1 });
  });

  it("设备身份落盘：目录 0700、文件 0600，且二次调用返回同一身份", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aervox-identity-"));
    const identityPath = path.join(dir, "nested", "p2p-device-identity.json");
    try {
      const created = await loadOrCreateDeviceIdentity({
        path: identityPath,
        deviceName: "测试设备",
        deviceIdPrefix: "test",
      });
      expect(created.deviceId).toMatch(/^test_/);
      expect(fs.existsSync(identityPath)).toBe(true);

      if (process.platform !== "win32") {
        expect(fs.statSync(identityPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.dirname(identityPath)).mode & 0o777).toBe(0o700);
      }

      const second = await loadOrCreateDeviceIdentity({ path: identityPath });
      expect(second.deviceId).toBe(created.deviceId);
      expect(second.publicKey).toBe(created.publicKey);

      const loaded = await loadDeviceIdentity(identityPath);
      expect(loaded?.privateKey).toBe(created.privateKey);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("复用已存在的目录时不改动其模式，但私钥文件仍为 0600", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aervox-identity-existing-"));
    try {
      if (process.platform !== "win32") fs.chmodSync(dir, 0o755);
      const identityPath = path.join(dir, "p2p-device-identity.json");
      await loadOrCreateDeviceIdentity({ path: identityPath, deviceName: "复用目录" });
      if (process.platform !== "win32") {
        // 既有目录（例如仓库 data/）不被静默改权
        expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
        // 私钥机密性由文件级 0600 保证
        expect(fs.statSync(identityPath).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadDeviceIdentity 对不存在路径返回 null，缺字段时报错", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aervox-identity-"));
    try {
      expect(await loadDeviceIdentity(path.join(dir, "missing.json"))).toBeNull();
      const malformed = path.join(dir, "bad.json");
      fs.writeFileSync(malformed, JSON.stringify({ deviceId: "x" }), "utf8");
      await expect(loadDeviceIdentity(malformed)).rejects.toThrow(/malformed/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
