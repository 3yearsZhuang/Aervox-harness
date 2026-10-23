/** In-process exchange harness using the same encrypted payloads and persistence capability as TCP. */
import { encryptSyncPayload, decryptSyncPayload, type EstablishedP2PSession } from "./pairing.js";
import type { P2PSyncBundle, SyncChangesetPort, SyncMergeResult } from "./protocol.js";
export async function executeP2PBidirectionalSync(options: {
  nodeA: { changesets: SyncChangesetPort; deviceId: string };
  nodeB: { changesets: SyncChangesetPort; deviceId: string };
  sessions: { nodeA: EstablishedP2PSession; nodeB: EstablishedP2PSession };
  watermarks?: { aSince?: string; bSince?: string };
}): Promise<{ aToBResult: SyncMergeResult; bToAResult: SyncMergeResult; syncTimestamp: string }> {
  const syncTimestamp = new Date().toISOString();
  const bundleA = await options.nodeA.changesets.build({ sourceDeviceId: options.nodeA.deviceId,
    targetDeviceId: options.nodeB.deviceId, sinceWatermark: options.watermarks?.aSince });
  const aToB = decryptSyncPayload<P2PSyncBundle>(options.sessions.nodeB, encryptSyncPayload(options.sessions.nodeA, bundleA));
  const aToBResult = await options.nodeB.changesets.apply(aToB, options.nodeB.deviceId);
  const bundleB = await options.nodeB.changesets.build({ sourceDeviceId: options.nodeB.deviceId,
    targetDeviceId: options.nodeA.deviceId, sinceWatermark: options.watermarks?.bSince });
  const bToA = decryptSyncPayload<P2PSyncBundle>(options.sessions.nodeA, encryptSyncPayload(options.sessions.nodeB, bundleB));
  const bToAResult = await options.nodeA.changesets.apply(bToA, options.nodeA.deviceId);
  return { aToBResult, bToAResult, syncTimestamp };
}
