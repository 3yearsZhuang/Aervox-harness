/**
 * ITER-028 测试夹具：通过**承诺-揭示**配对路径建立一对已验证的会话。
 *
 * 加密层对未验证的 committed 会话与 legacy 未承诺会话一律 fail-closed
 * （见 p2p-pairing.ts 的 assertSessionUsable），因此测试必须走安全路径，
 * 而不是绕过它。
 */
import {
  beginPairing,
  completePairingAsInitiatorV2,
  finalizePairingAsResponder,
  generateDeviceIdentity,
  markSessionVerified,
  respondToPairing,
  verifyResponderKeyConfirmation,
  type EstablishedP2PSession,
  type P2PDeviceIdentity,
  type PairingInvitation,
  type PairingResponse,
  type PairingReveal,
} from "../../src/index.js";

export interface VerifiedPairingFixture {
  initiatorIdentity: P2PDeviceIdentity;
  responderIdentity: P2PDeviceIdentity;
  initiatorSession: EstablishedP2PSession;
  responderSession: EstablishedP2PSession;
  invitation: PairingInvitation;
  response: PairingResponse;
  reveal: PairingReveal;
  sasCode: string;
}

/**
 * 执行完整承诺-揭示握手（含双向密钥确认），并在"用户确认 SAS 一致"后把两端会话
 * 标记为已验证，使其可用于加密同步。
 */
export function establishVerifiedPairing(options: {
  initiatorName?: string;
  responderName?: string;
  initiatorPrefix?: string;
  responderPrefix?: string;
} = {}): VerifiedPairingFixture {
  const initiatorIdentity = generateDeviceIdentity(
    options.initiatorName ?? "MacBook Pro (桌面端)",
    options.initiatorPrefix ?? "desktop",
  );
  const responderIdentity = generateDeviceIdentity(
    options.responderName ?? "iPhone 16 Pro (移动端)",
    options.responderPrefix ?? "mobile",
  );

  const pendingInitiator = beginPairing(initiatorIdentity);
  const { response, pending: pendingResponder } = respondToPairing(
    responderIdentity,
    pendingInitiator.invitation,
  );
  const {
    reveal,
    session: initiatorSession,
    sasCode,
  } = completePairingAsInitiatorV2(initiatorIdentity, pendingInitiator, response);
  const finalized = finalizePairingAsResponder(
    responderIdentity,
    pendingResponder,
    pendingInitiator.invitation,
    reveal,
  );

  if (finalized.sasCode !== sasCode) {
    throw new Error(`fixture SAS mismatch: ${finalized.sasCode} != ${sasCode}`);
  }
  const responderConfirmed = verifyResponderKeyConfirmation({
    session: initiatorSession,
    invitation: pendingInitiator.invitation,
    response,
    initiatorEphemeralPublicKey: pendingInitiator.ephemeralEcdh.getPublicKey().toString("base64"),
    keyConfirmation: finalized.keyConfirmation,
  });
  if (!responderConfirmed) {
    throw new Error("fixture failed responder key confirmation");
  }

  // 模拟用户在两端比对 SAS 一致后的确认动作
  markSessionVerified(initiatorSession);
  markSessionVerified(finalized.session);

  return {
    initiatorIdentity,
    responderIdentity,
    initiatorSession,
    responderSession: finalized.session,
    invitation: pendingInitiator.invitation,
    response,
    reveal,
    sasCode,
  };
}
