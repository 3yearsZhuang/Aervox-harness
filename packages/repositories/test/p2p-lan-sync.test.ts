/**
 * Aervox｜思隅 @aervox/repositories — P2P 局域网同步端到端测试：**真实环回 socket**（ITER-028）
 *
 * 覆盖目标（全部跑在 127.0.0.1 的真实 `node:net` server/client 上，不是同进程函数调用）：
 * 1. 静态对端发现 → 承诺-揭示握手 → 双向加密 Changeset 交换：新增行、修改行、删除墓碑传播，
 *    两端最终收敛；
 * 2. 两端展示同一 6 位 SAS；未经 `markSessionVerified` 的会话**无法加密**（fail-closed，负例）；
 * 3. 分帧负例：超长帧、坏 JSON、连接中途截断、传输协议版本不符、未知报文类型，全部被明确拒绝
 *    且**不悬挂**（短超时 + 耗时断言）；
 * 4. `SyncPartialMergeError` 原样上抛并携带 `partialResult`（部分合并必须被调用方看见）；
 * 5. 单个服务端实例在被坏帧攻击后仍能正常完成后续交换。
 *
 * 说明：测试是**单进程内**起真 socket（两台 SQLite 文件库 + 两个身份），
 * 这不等于"真实双机验收"——跨机型/跨 Wi-Fi/移动端后台挂起仍未验证（见模块头注释的诚实边界）。
 */
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  DEFAULT_SYNC_TABLES,
  P2PDiscovery,
  P2PFrameDecoder,
  P2PFrameError,
  P2PSyncClient,
  P2PSyncServer,
  P2PTransportError,
  P2P_TRANSPORT_PROTOCOL_VERSION,
  SyncPartialMergeError,
  beginPairing,
  completePairingAsInitiatorV2,
  computePublicKeyFingerprint,
  createDatabase,
  encodeFrame,
  encryptSyncPayload,
  finalizePairingAsResponder,
  generateDeviceIdentity,
  initDatabaseSchema,
  installSyncTriggers,
  markSessionVerified,
  parseP2PTransportMessage,
  readSyncRowStates,
  respondToPairing,
  type AervoxDatabase,
  type P2PDeviceIdentity,
  type P2PExchangeResult,
  type P2PSessionReadyContext,
  type SyncMergeResult,
} from "../src/index.js";
import type { Client } from "@libsql/client";

/** 时间戳固定在过去，保证删除墓碑（deleted_at = 真实 now）一定「更新」于业务行 */
const T0 = "2020-01-01T00:00:00.000Z";
const T1 = "2020-01-02T00:00:00.000Z";

interface Endpoint {
  identity: P2PDeviceIdentity;
  deviceId: string;
  client: Client;
  db: AervoxDatabase;
  dir: string;
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup();
    } catch {
      // 清理失败不影响断言结果
    }
  }
});

async function createEndpoint(name: string, prefix: string): Promise<Endpoint> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aervox-p2p-lan-"));
  const dbPath = path.join(dir, `${prefix}.db`);
  const conn = await createDatabase({ url: `file:${dbPath}` });
  await initDatabaseSchema(conn.client);
  const identity = generateDeviceIdentity(name, prefix);
  await installSyncTriggers(conn.client, DEFAULT_SYNC_TABLES, identity.deviceId);
  cleanups.push(() => {
    try {
      conn.client.close();
    } catch {
      // 已关闭
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { identity, deviceId: identity.deviceId, client: conn.client, db: conn.db, dir };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 错误收集器：服务端错误一律经 onError 上报，测试据此做确定性断言（而非 sleep 猜测） */
class ErrorCollector {
  readonly errors: Error[] = [];
  collect = (error: Error): void => {
    this.errors.push(error);
  };

  async waitForCode(code: string, timeoutMs = 4_000): Promise<P2PTransportError> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.errors.find(
        (error) => error instanceof P2PTransportError && error.code === code,
      );
      if (found) return found as P2PTransportError;
      await sleep(10);
    }
    throw new Error(
      `未在 ${timeoutMs}ms 内观察到错误码 ${code}；已见：${
        this.errors.map((error) => `${(error as P2PTransportError).code ?? "?"}:${error.message}`).join(" | ") ||
        "(无)"
      }`,
    );
  }
}

/** 模拟用户在两端看到 SAS 后确认一致：显式 markSessionVerified（传输层绝不代为验证） */
function verifyingHook(sasSink: string[]) {
  return async (context: P2PSessionReadyContext): Promise<boolean> => {
    sasSink.push(context.sasCode);
    markSessionVerified(context.session);
    return true;
  };
}

async function readGoalRows(client: Client): Promise<Array<{ id: string; topic: string }>> {
  const res = await client.execute(
    "SELECT id, topic FROM learning_goals ORDER BY id ASC",
  );
  return res.rows.map((row) => ({ id: String(row.id), topic: String(row.topic) }));
}

async function insertGoal(client: Client, id: string, topic: string, timestamp: string): Promise<void> {
  await client.execute({
    sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, updated_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)`,
    args: [id, topic, "beginner", 30, "active", timestamp, timestamp],
  });
}

async function cleanupServer(server: P2PSyncServer): Promise<void> {
  await server.stop();
}

/** 连接一个裸 socket（用于手工构造畸形帧） */
async function connectRaw(port: number): Promise<net.Socket> {
  const socket = await new Promise<net.Socket>((resolve, reject) => {
    const client = net.connect({ host: "127.0.0.1", port });
    client.once("connect", () => resolve(client));
    client.once("error", reject);
  });
  socket.on("error", () => undefined); // 服务端断开时的 ECONNRESET 属预期，不放大成未处理错误
  cleanups.push(() => socket.destroy());
  return socket;
}

/** 从裸 socket 读一帧（用于直接观察服务端回包，例如 server_busy 错误帧） */
function readRawFrame(socket: net.Socket, timeoutMs = 3_000): Promise<unknown> {
  const decoder = new P2PFrameDecoder();
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("error", onError);
    };
    const finish = (value: unknown, error?: Error) => {
      if (done) return;
      done = true;
      cleanup();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(null, new Error("readRawFrame 超时")), timeoutMs);
    timer.unref?.();
    const onData = (chunk: Buffer) => {
      try {
        const frames = decoder.push(chunk);
        if (frames.length > 0) finish(frames[0]);
      } catch (error) {
        finish(null, error as Error);
      }
    };
    const onError = (error: Error) => finish(null, error);
    socket.on("data", onData);
    socket.on("error", onError);
  });
}

function writeRaw(socket: net.Socket, buffer: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(buffer, (error) => (error ? reject(error) : resolve()));
  });
}

describe("ITER-028: P2P 局域网同步（真实环回 socket）", () => {
  it("静态发现 + 承诺-揭示握手 + 双向增量同步：新增/修改/删除墓碑传播后两端收敛", async () => {
    const desktop = await createEndpoint("MacBook Pro (桌面端)", "desktop");
    const mobile = await createEndpoint("iPhone 16 Pro (移动端)", "mobile");

    // 1. 真实 TCP 服务端（端口 0 由系统分配）
    const serverSas: string[] = [];
    const serverErrors = new ErrorCollector();
    const serverResults: P2PExchangeResult[] = [];
    const server = new P2PSyncServer({
      identity: mobile.identity,
      client: mobile.client,
      host: "127.0.0.1",
      port: 0,
      onSessionReady: verifyingHook(serverSas),
      onExchange: (result) => serverResults.push(result),
      onError: serverErrors.collect,
    });
    cleanups.push(() => cleanupServer(server));
    const { port } = await server.start();
    expect(port).toBeGreaterThan(0);
    expect(server.isRunning()).toBe(true);

    // 2. 静态对端发现（不使用多播：CI/受限网络下确定性可用）——传输地址由发现结果驱动
    const clientDiscovery = new P2PDiscovery({
      identity: desktop.identity,
      host: "127.0.0.1",
      port: 0,
      multicast: false,
      staticPeers: [
        {
          host: "127.0.0.1",
          port,
          deviceId: mobile.identity.deviceId,
          deviceName: mobile.identity.deviceName,
          fingerprint: computePublicKeyFingerprint(mobile.identity.publicKey),
        },
      ],
    });
    cleanups.push(() => clientDiscovery.stop());
    await clientDiscovery.start();
    const discovered = clientDiscovery.listPeers();
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.source).toBe("static");
    expect(discovered[0]?.device.fingerprint).toBe(
      computePublicKeyFingerprint(mobile.identity.publicKey),
    );
    const peerAddress = { host: discovered[0]!.device.host, port: discovered[0]!.device.port };

    const clientSas: string[] = [];
    const runClient = (): Promise<P2PExchangeResult> =>
      new P2PSyncClient({
        identity: desktop.identity,
        client: desktop.client,
        peer: peerAddress,
        onSessionReady: verifyingHook(clientSas),
      }).run();

    // 3. 第一轮：桌面端写入共享行与保留行，同步到移动端
    await insertGoal(desktop.client, "goal_shared", "线性代数", T0);
    await insertGoal(desktop.client, "goal_keep", "概率论", T0);

    const round1 = await runClient();
    expect(round1.role).toBe("initiator");
    expect(round1.peerDeviceId).toBe(mobile.identity.deviceId);
    expect(round1.localMergeResult.partial).toBe(false);
    expect(await readGoalRows(mobile.client)).toEqual([
      { id: "goal_keep", topic: "概率论" },
      { id: "goal_shared", topic: "线性代数" },
    ]);
    // 两端展示同一 SAS（发起方与响应方独立计算）
    expect(clientSas).toHaveLength(1);
    expect(serverSas).toEqual(clientSas);
    expect(round1.sasCode).toBe(serverSas[0]);
    expect(round1.sasCode).toMatch(/^\d{6}$/);

    // 4. 第二轮：桌面端修改一行 + 新增一行；移动端删除一行 + 新增一行
    await desktop.client.execute({
      sql: "UPDATE learning_goals SET topic = ?, updated_at = ? WHERE id = ?",
      args: ["概率论（进阶）", T1, "goal_keep"],
    });
    await insertGoal(desktop.client, "goal_a_new", "桌面端新增", T1);
    await mobile.client.execute({ sql: "DELETE FROM learning_goals WHERE id = ?", args: ["goal_shared"] });
    await insertGoal(mobile.client, "goal_b_new", "移动端新增", T1);

    const round2 = await runClient();
    const round2Server = serverResults.at(-1);
    expect(round2Server).toBeDefined();

    // 5. 两端收敛：同一组行、同一内容，删除不会被更旧的远端写入复活
    const expected = [
      { id: "goal_a_new", topic: "桌面端新增" },
      { id: "goal_b_new", topic: "移动端新增" },
      { id: "goal_keep", topic: "概率论（进阶）" },
    ];
    expect(await readGoalRows(desktop.client)).toEqual(expected);
    expect(await readGoalRows(mobile.client)).toEqual(expected);

    // 6. 删除墓碑确实传播到桌面端并被登记（deleted_at 非空）
    const desktopStates = await readSyncRowStates(desktop.client, "learning_goals");
    const sharedTombstone = desktopStates.find((state) => state.primaryKey === "goal_shared");
    expect(sharedTombstone?.deletedAt).not.toBeNull();
    // DELETE 触发器保留原始写入时间戳、不篡改来源设备：墓碑的权威来源仍是该行最初的作者（桌面端），
    // 但比较时钟取 max(origin_timestamp, deleted_at) = 删除时刻，因此删除必然"更新"并胜出。
    expect(sharedTombstone?.originTimestamp).toBe(T0);
    expect(sharedTombstone?.originDeviceId).toBe(desktop.identity.deviceId);

    // 7. 合并报告如实反映"新增一行 + 应用一个墓碑 + 一条落败跳过"
    expect(round2.localMergeResult.insertedCount).toBe(1); // goal_b_new
    expect(round2.localMergeResult.deletedCount).toBe(1); // goal_shared 被物理删除
    expect(round2.localMergeResult.tombstonesApplied).toBe(1);
    expect(round2.localMergeResult.skippedCount).toBeGreaterThanOrEqual(1); // 对端的旧 goal_keep 落败
    expect(round2.peerResultMissing).toBe(false);
    expect(round2Server!.localMergeResult.updatedCount).toBe(1); // goal_keep 被覆盖
    expect(round2Server!.localMergeResult.insertedCount).toBe(1); // goal_a_new
    expect(round2Server!.localMergeResult.skippedCount).toBeGreaterThanOrEqual(1); // goal_shared 行不敌墓碑
    expect(round2Server!.partial).toBe(false);

    // 8. 同一服务端连续处理两个对端（顺序确定性），无错误上报
    expect(serverResults).toHaveLength(2);
    expect(serverErrors.errors).toEqual([]);
    await clientDiscovery.stop();
    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it("未 markSessionVerified 的会话无法加密；传输层在有界等待后 fail-closed 中止", async () => {
    const desktop = await createEndpoint("MacBook Pro (桌面端)", "desktop");
    const mobile = await createEndpoint("iPhone 16 Pro (移动端)", "mobile");

    // 负例 A（纯密码学层）：committed 会话未确认前禁止加密
    const pending = beginPairing(desktop.identity);
    const { response, pending: responderPending } = respondToPairing(mobile.identity, pending.invitation);
    const completed = completePairingAsInitiatorV2(desktop.identity, pending, response);
    const finalized = finalizePairingAsResponder(
      mobile.identity,
      responderPending,
      pending.invitation,
      completed.reveal,
    );
    expect(completed.session.verified).toBe(false);
    expect(() => encryptSyncPayload(completed.session, { hello: 1 })).toThrow(
      /markSessionVerified/,
    );
    expect(completed.sasCode).toBe(finalized.sasCode); // 两端 SAS 一致，但"一致"必须由人确认

    // 负例 B（传输层）：回调返回 true 却**没有**调用 markSessionVerified → 有界等待后明确失败
    const serverErrors = new ErrorCollector();
    const server = new P2PSyncServer({
      identity: mobile.identity,
      client: mobile.client,
      host: "127.0.0.1",
      port: 0,
      onSessionReady: async () => true, // 故意不验证
      onError: serverErrors.collect,
      verificationTimeoutMs: 150,
    });
    cleanups.push(() => server.stop());
    const { port } = await server.start();

    const startedAt = Date.now();
    const failure = await new P2PSyncClient({
      identity: desktop.identity,
      client: desktop.client,
      peer: { host: "127.0.0.1", port },
      onSessionReady: async () => true, // 故意不验证
      verificationTimeoutMs: 150,
    })
      .run()
      .then(() => null)
      .catch((error: unknown) => error as P2PTransportError);
    expect(failure).toBeInstanceOf(P2PTransportError);
    expect(failure?.code).toBe("session_not_verified");
    expect(Date.now() - startedAt).toBeLessThan(3_000); // 有界等待，绝不悬挂
    // 对端（响应方）同样 fail-closed 中止（它不会代为验证，也不会无限等待）
    await serverErrors.waitForCode("session_not_verified");
    await server.stop();

    // 负例 C（用户拒绝）：回调返回 false 立即中止，无需等待验证超时
    const server2Errors = new ErrorCollector();
    const server2 = new P2PSyncServer({
      identity: mobile.identity,
      client: mobile.client,
      host: "127.0.0.1",
      port: 0,
      onSessionReady: async () => true,
      onError: server2Errors.collect,
      verificationTimeoutMs: 10_000,
    });
    cleanups.push(() => server2.stop());
    const { port: port2 } = await server2.start();
    const rejectedAt = Date.now();
    const rejection = await new P2PSyncClient({
      identity: desktop.identity,
      client: desktop.client,
      peer: { host: "127.0.0.1", port: port2 },
      onSessionReady: async () => false, // 用户判定 SAS 不一致
      verificationTimeoutMs: 10_000,
    })
      .run()
      .then(() => null)
      .catch((error: unknown) => error as P2PTransportError);
    expect(rejection?.code).toBe("session_not_verified");
    expect(rejection?.message).toMatch(/拒绝了本次配对/);
    expect(Date.now() - rejectedAt).toBeLessThan(3_000);
    await server2.stop();
  });

  it("分帧负例：超长帧 / 坏 JSON / 中途截断 / 版本不符 / 未知类型都被明确拒绝且服务端保持可用", async () => {
    const mobile = await createEndpoint("iPhone 16 Pro (移动端)", "mobile");
    const desktop = await createEndpoint("MacBook Pro (桌面端)", "desktop");
    const serverErrors = new ErrorCollector();
    const server = new P2PSyncServer({
      identity: mobile.identity,
      client: mobile.client,
      host: "127.0.0.1",
      port: 0,
      // 收紧到 16 KiB：既让"超长帧"用例可控，也仍能装下一次真实 Changeset 交换
      maxFrameBytes: 16 * 1_024,
      onSessionReady: verifyingHook([]),
      onError: serverErrors.collect,
    });
    cleanups.push(() => server.stop());
    const { port } = await server.start();

    // 1. 超长帧：长度前缀声明 16385 > maxFrameBytes(16384)，服务端必须立即拒绝且不缓冲
    const oversizeSocket = await connectRaw(port);
    const oversizeHeader = Buffer.alloc(4);
    oversizeHeader.writeUInt32BE(16 * 1_024 + 1, 0);
    await writeRaw(oversizeSocket, oversizeHeader);
    const oversizeError = await serverErrors.waitForCode("frame_too_large");
    expect(oversizeError.message).toMatch(/超长帧声明/);

    // 2. 坏 JSON：长度前缀合法但帧体不是 JSON
    const badJsonSocket = await connectRaw(port);
    const badBody = Buffer.from("{oops!!", "utf8");
    const badHeader = Buffer.alloc(4);
    badHeader.writeUInt32BE(badBody.byteLength, 0);
    await writeRaw(badJsonSocket, Buffer.concat([badHeader, badBody]));
    const malformedError = await serverErrors.waitForCode("malformed_frame");
    expect(malformedError.message).toMatch(/不是合法 JSON/);

    // 3. 中途截断：只写 2 字节长度前缀就断链，必须报"残留半帧"而不是当作正常结束
    const truncatedSocket = await connectRaw(port);
    await writeRaw(truncatedSocket, Buffer.from([0x00, 0x00]));
    truncatedSocket.destroy();
    const truncatedError = await serverErrors.waitForCode("truncated_frame");
    expect(truncatedError.message).toMatch(/残留 2 字节/);

    // 4. 传输协议版本不符
    const versionSocket = await connectRaw(port);
    await writeRaw(
      versionSocket,
      encodeFrame({ transportVersion: "v999", kind: "pairing_invitation" }),
    );
    const versionError = await serverErrors.waitForCode("unsupported_transport_version");
    expect(versionError.message).toMatch(/不支持的传输协议版本/);

    // 5. 未知报文类型
    const unknownKindSocket = await connectRaw(port);
    await writeRaw(
      unknownKindSocket,
      encodeFrame({ transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION, kind: "definitely_not_a_kind" }),
    );
    const unknownKindError = await serverErrors.waitForCode("unknown_message_kind");
    expect(unknownKindError.message).toMatch(/未知报文类型/);

    // 6. 被连续攻击之后，服务端仍能完成一次完整交换（错误不破坏服务）
    await insertGoal(desktop.client, "goal_after_attacks", "攻击后仍可用", T0);
    const result = await new P2PSyncClient({
      identity: desktop.identity,
      client: desktop.client,
      peer: { host: "127.0.0.1", port },
      onSessionReady: verifyingHook([]),
    }).run();
    expect(result.localMergeResult.partial).toBe(false);
    expect(await readGoalRows(mobile.client)).toEqual([
      { id: "goal_after_attacks", topic: "攻击后仍可用" },
    ]);
    expect(server.isRunning()).toBe(true);
    await server.stop();

    // 7. 客户端读取超时：对端只接受连接却永不回包 → 有界失败，绝不悬挂
    const silentSockets: net.Socket[] = [];
    const silentServer = net.createServer((socket) => {
      silentSockets.push(socket);
      socket.on("error", () => undefined);
    });
    await new Promise<void>((resolve) =>
      silentServer.listen({ host: "127.0.0.1", port: 0 }, () => resolve()),
    );
    cleanups.push(async () => {
      for (const socket of silentSockets) socket.destroy();
      await new Promise<void>((resolve) => silentServer.close(() => resolve()));
    });
    const silentPort = (silentServer.address() as net.AddressInfo).port;
    const clientStartedAt = Date.now();
    const timeoutError = await new P2PSyncClient({
      identity: desktop.identity,
      client: desktop.client,
      peer: { host: "127.0.0.1", port: silentPort },
      onSessionReady: verifyingHook([]),
      handshakeTimeoutMs: 150,
      readTimeoutMs: 150,
      writeTimeoutMs: 500,
    })
      .run()
      .then(() => null)
      .catch((error: unknown) => error as P2PTransportError);
    expect(timeoutError?.code).toBe("read_timeout");
    expect(Date.now() - clientStartedAt).toBeLessThan(3_000);
  });

  it("服务端一次只处理一个对端：繁忙时新连接收到 server_busy 错误帧（确定性拒绝，不排队）", async () => {
    const mobile = await createEndpoint("iPhone 16 Pro (移动端)", "mobile");
    const desktop = await createEndpoint("MacBook Pro (桌面端)", "desktop");
    const serverErrors = new ErrorCollector();
    const server = new P2PSyncServer({
      identity: mobile.identity,
      client: mobile.client,
      host: "127.0.0.1",
      port: 0,
      onSessionReady: async () => false,
      onError: serverErrors.collect,
    });
    cleanups.push(() => server.stop());
    const { port } = await server.start();

    // 第一个对端发起握手（服务端随即进入 busy）
    const first = await connectRaw(port);
    const pendingFirst = beginPairing(desktop.identity);
    await writeRaw(
      first,
      encodeFrame({
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "pairing_invitation",
        invitation: pendingFirst.invitation,
      }),
    );
    const firstReply = parseP2PTransportMessage(await readRawFrame(first));
    expect(firstReply.kind).toBe("pairing_response");

    // 第二个对端必须被确定性拒绝（而不是排队或被静默丢弃）
    const second = await connectRaw(port);
    const pendingSecond = beginPairing(desktop.identity);
    await writeRaw(
      second,
      encodeFrame({
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "pairing_invitation",
        invitation: pendingSecond.invitation,
      }),
    );
    const secondReply = parseP2PTransportMessage(await readRawFrame(second));
    expect(secondReply.kind).toBe("error");
    if (secondReply.kind === "error") {
      expect(secondReply.errorCode).toBe("server_busy");
      expect(secondReply.message).toMatch(/一次只处理一个对端/);
    }

    first.destroy();
    await server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it("SyncPartialMergeError 原样上抛并携带 partialResult（部分合并绝不被吞掉）", async () => {
    const desktop = await createEndpoint("MacBook Pro (桌面端)", "desktop");
    const mobile = await createEndpoint("iPhone 16 Pro (移动端)", "mobile");

    // 移动端准备 2 条变更；桌面端以 mergeChunkSize: 1 应用 → 第 1 批提交后第 2 批失败
    await insertGoal(mobile.client, "goal_b1", "移动端行一", T0);
    await insertGoal(mobile.client, "goal_b2", "移动端行二", T0);

    const serverErrors = new ErrorCollector();
    const server = new P2PSyncServer({
      identity: mobile.identity,
      client: mobile.client,
      host: "127.0.0.1",
      port: 0,
      onSessionReady: verifyingHook([]),
      onError: serverErrors.collect,
    });
    cleanups.push(() => server.stop());
    const { port } = await server.start();

    // 注入"第 2 个写事务必定失败"的客户端：模拟基础设施级错误导致分批中断
    let transactionCalls = 0;
    const failingClient = new Proxy(desktop.client, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return async (...args: unknown[]) => {
            transactionCalls += 1;
            if (transactionCalls === 2) {
              throw new Error("SQLITE_IOERR: 注入的基础设施级失败（测试用）");
            }
            return (target.transaction as unknown as (...a: unknown[]) => unknown)(...args);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    }) as Client;

    const failure = await new P2PSyncClient({
      identity: desktop.identity,
      client: failingClient,
      peer: { host: "127.0.0.1", port },
      onSessionReady: verifyingHook([]),
      mergeChunkSize: 1,
      maxFrameBytes: 8 * 1024 * 1024,
    })
      .run()
      .then(() => null)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SyncPartialMergeError);
    const partial = failure as SyncPartialMergeError;
    expect(partial.partialResult.appliedChunks).toBe(1);
    expect(partial.partialResult.partial).toBe(true);
    expect(partial.partialResult.insertedCount).toBe(1);
    expect(partial.message).toMatch(/无法回滚/);

    // 第 1 批已提交且无法回滚：桌面端确实只有一行落库（部分应用的可见后果）
    expect(await readGoalRows(desktop.client)).toEqual([{ id: "goal_b1", topic: "移动端行一" }]);
    expect(transactionCalls).toBe(2);

    // 对端通过错误帧拿到 partial_merge 报告，而不是静默地认为同步成功
    const peerError = await serverErrors.waitForCode("peer_error");
    expect(peerError.details?.remoteCode).toBe("partial_merge");
    const remotePartial = peerError.details?.remotePartialResult as SyncMergeResult | undefined;
    expect(remotePartial?.appliedChunks).toBe(1);
    await server.stop();
  });

  it("分帧编解码与报文校验单元：往返、超长、坏 JSON、截断半帧、未知类型/字段非法", () => {
    // 1. 往返（含逐字节喂入：分帧必须能处理任意切分）
    const frame = encodeFrame({
      transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
      kind: "pairing_key_confirmation",
      keyConfirmation: "aGVsbG8=",
    });
    const decoder = new P2PFrameDecoder();
    const decoded: unknown[] = [];
    for (const byte of frame) {
      decoded.push(...decoder.push(Buffer.from([byte])));
    }
    expect(decoded).toHaveLength(1);
    const message = parseP2PTransportMessage(decoded[0]);
    expect(message.kind).toBe("pairing_key_confirmation");
    expect(decoder.pendingBytes).toBe(0);

    // 2. 发送侧超长：编码即拒绝（本切片不做 bundle 分片）
    expect(() =>
      encodeFrame({ blob: "x".repeat(64) }, { maxFrameBytes: 32 }),
    ).toThrowError(P2PFrameError);
    try {
      encodeFrame({ blob: "x".repeat(64) }, { maxFrameBytes: 32 });
    } catch (error) {
      expect((error as P2PFrameError).code).toBe("frame_too_large");
    }

    // 3. 接收侧超长：长度前缀一读出来就失败，不缓冲、不预分配
    const oversizeDecoder = new P2PFrameDecoder({ maxFrameBytes: 16 });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(1_024 * 1_024, 0);
    expect(() => oversizeDecoder.push(header)).toThrowError(P2PFrameError);
    expect(oversizeDecoder.pendingBytes).toBe(4); // 失败的帧头保留原文，不做二次解析

    // 4. 坏 JSON
    const malformedBody = Buffer.from("not-json!", "utf8");
    const malformedHeader = Buffer.alloc(4);
    malformedHeader.writeUInt32BE(malformedBody.byteLength, 0);
    expect(() =>
      new P2PFrameDecoder().push(Buffer.concat([malformedHeader, malformedBody])),
    ).toThrow(/不是合法 JSON/);

    // 5. 截断半帧：连接关闭时必须显式报错
    const truncatedDecoder = new P2PFrameDecoder();
    truncatedDecoder.push(Buffer.from([0x00, 0x01, 0x02]));
    expect(() => truncatedDecoder.assertDrained()).toThrow(/连接在帧中途断开/);
    try {
      truncatedDecoder.assertDrained();
    } catch (error) {
      expect((error as P2PFrameError).code).toBe("truncated_frame");
    }

    // 6. 报文校验：未知类型 / 版本不符 / 字段缺失 / 报告字段非法
    expect(() =>
      parseP2PTransportMessage({
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "nope",
      }),
    ).toThrow(/未知报文类型/);
    expect(() => parseP2PTransportMessage({ transportVersion: "v2", kind: "error" })).toThrow(
      /不支持的传输协议版本/,
    );
    expect(() =>
      parseP2PTransportMessage({
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "sync_bundle",
        payload: { version: "v2", sequence: "not-a-number" },
      }),
    ).toThrow(/sequence 非法/);
    expect(() =>
      parseP2PTransportMessage({
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "sync_bundle",
        payload: { sequence: 0 },
      }),
    ).toThrow(/version 缺失或不是字符串/);
    const validResult: SyncMergeResult = {
      insertedCount: 0,
      updatedCount: 0,
      skippedCount: 0,
      conflictsResolvedCount: 0,
      deletedCount: 0,
      tombstonesApplied: 0,
      uniqueConflicts: 0,
      schemaDriftRows: 0,
      constraintViolations: 0,
      skippedTables: [],
      rejectedTables: [],
      appliedChunks: 0,
      totalChunks: 0,
      partial: false,
    };
    expect(
      parseP2PTransportMessage({
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "sync_result",
        mergeResult: validResult,
      }).kind,
    ).toBe("sync_result");
    expect(() =>
      parseP2PTransportMessage({
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "sync_result",
        mergeResult: { ...validResult, insertedCount: -1 },
      }),
    ).toThrow(/必须是非负整数/);
    expect(() =>
      parseP2PTransportMessage({
        transportVersion: P2P_TRANSPORT_PROTOCOL_VERSION,
        kind: "sync_result",
        mergeResult: {
          ...validResult,
          rejectedTables: [{ tableName: "t", reason: "made_up_reason", detail: "" }],
        },
      }),
    ).toThrow(/拒绝原因未知/);
  });
});
