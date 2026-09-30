/**
 * Aervox｜思隅 @aervox/repositories — P2P 局域网发现（UDP 多播信标 + 静态对端）单元测试（ITER-028）
 *
 * 全部用例使用**注入的假 socket**，不依赖真实多播：
 * 多播在 CI/容器/开启 AP 隔离的网络里不可靠，测试绝不能因为网络环境而变红。
 * 真实环回 socket 的端到端证据见 `p2p-lan-sync.test.ts`。
 */
import { describe, it, expect } from "vitest";
import {
  P2PDiscovery,
  P2PDiscoveryError,
  P2P_DISCOVERY_BEACON_MAGIC,
  P2P_DISCOVERY_BEACON_VERSION,
  P2P_DISCOVERY_DEFAULT_GROUP,
  P2P_DISCOVERY_MAX_BEACON_BYTES,
  P2P_SERVICE_TYPE,
  createP2PBeacon,
  computePublicKeyFingerprint,
  decodeP2PBeacon,
  encodeP2PBeacon,
  generateDeviceIdentity,
  type P2PDiscoveryRemoteInfo,
  type P2PDiscoverySocket,
} from "../src/index.js";

/** 可注入的假 UDP socket：记录发送/组播成员变更，支持测试手动投递报文 */
class FakeDiscoverySocket {
  readonly handlers = new Map<string, Array<(...args: never[]) => void>>();
  readonly sent: Array<{ payload: Buffer; port: number; address: string }> = [];
  readonly memberships: string[] = [];
  readonly droppedMemberships: string[] = [];
  boundPort: number | null = null;
  multicastTtl: number | null = null;
  closed = false;
  closeCalls = 0;
  failMembership = false;
  /** 模拟 bind 同步抛错（如 EADDRINUSE） */
  failBind = false;
  /** 模拟 bind 永不回调（用于验证绑定超时兜底） */
  silentBind = false;

  on(event: string, listener: (...args: never[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }

  removeAllListeners(event?: string): this {
    if (event === undefined) this.handlers.clear();
    else this.handlers.delete(event);
    return this;
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.length ?? 0;
  }

  bind(port: number, callback?: () => void): this {
    this.boundPort = port;
    if (this.failBind) throw new Error("EADDRINUSE: 端口被占用");
    if (this.silentBind) return this;
    callback?.();
    return this;
  }

  addMembership(group: string, interfaceAddress?: string): void {
    if (this.failMembership) throw new Error("ENODEV: multicast not available");
    this.memberships.push(interfaceAddress ? `${group}@${interfaceAddress}` : group);
  }

  dropMembership(group: string, interfaceAddress?: string): void {
    this.droppedMemberships.push(interfaceAddress ? `${group}@${interfaceAddress}` : group);
  }

  setMulticastTTL(ttl: number): number {
    this.multicastTtl = ttl;
    return ttl;
  }

  send(payload: Buffer, port: number, address: string, callback?: (error: Error | null) => void): void {
    this.sent.push({ payload, port, address });
    callback?.(null);
  }

  close(callback?: () => void): void {
    this.closed = true;
    this.closeCalls += 1;
    callback?.();
  }

  unref(): void {
    // 假 socket 无需 unref
  }

  /** 测试专用：投递一个入站报文 */
  deliver(payload: Buffer, rinfo: P2PDiscoveryRemoteInfo): void {
    for (const listener of [...(this.handlers.get("message") ?? [])]) {
      (listener as unknown as (msg: Buffer, info: P2PDiscoveryRemoteInfo) => void)(payload, rinfo);
    }
  }

  /** 测试专用：触发事件（error 等） */
  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.handlers.get(event) ?? [])]) {
      (listener as unknown as (...a: unknown[]) => void)(...args);
    }
  }
}

const localIdentity = generateDeviceIdentity("本机 (desktop)", "local");
const peerIdentity = generateDeviceIdentity("对端 (mobile)", "peer");

function buildPeerBeacon(options: { ttlMs?: number; port?: number; host?: string } = {}): Buffer {
  return encodeP2PBeacon(
    createP2PBeacon({
      identity: peerIdentity,
      host: options.host ?? "1.2.3.4",
      port: options.port ?? 48201,
      ttlMs: options.ttlMs ?? 2_000,
    }),
  );
}

/** 构造发现实例并返回其假 socket（多播开启） */
function createDiscoveryWithFakeSocket(options: {
  overrides?: Partial<ConstructorParameters<typeof P2PDiscovery>[0]>;
  fake?: FakeDiscoverySocket;
} = {}): { discovery: P2PDiscovery; fake: FakeDiscoverySocket } {
  const fake = options.fake ?? new FakeDiscoverySocket();
  const discovery = new P2PDiscovery({
    identity: localIdentity,
    host: "127.0.0.1",
    port: 49001,
    socketFactory: () => fake as unknown as P2PDiscoverySocket,
    ...options.overrides,
  });
  return { discovery, fake };
}

describe("ITER-028: P2P 局域网发现（UDP 多播信标 + 静态对端）", () => {
  it("信标编解码往返：字段完整保留（含服务类型与设备指纹）", () => {
    const beacon = createP2PBeacon({
      identity: peerIdentity,
      host: "192.168.1.23",
      port: 48210,
      ttlMs: 3_000,
    });
    expect(beacon.magic).toBe(P2P_DISCOVERY_BEACON_MAGIC);
    expect(beacon.beaconVersion).toBe(P2P_DISCOVERY_BEACON_VERSION);
    expect(beacon.serviceType).toBe(P2P_SERVICE_TYPE);

    const decoded = decodeP2PBeacon(encodeP2PBeacon(beacon));
    expect(decoded.device).toEqual(beacon.device);
    expect(decoded.device.port).toBe(48210);
    expect(decoded.device.protocolVersion).toBe("v1");
    expect(decoded.device.fingerprint).toBe(beacon.device.fingerprint);
    expect(decoded.ttlMs).toBe(3_000);
    // 明说不做 mDNS：服务类型只是字符串常量，没有任何 DNS 记录语义
    expect(P2P_SERVICE_TYPE).toBe("_aervox-sync._tcp");
  });

  it("畸形信标一律拒绝（坏 JSON / 魔数 / 服务类型 / 版本 / 字段非法）", () => {
    expect(() => decodeP2PBeacon("not-json")).toThrowError(P2PDiscoveryError);
    expect(() => decodeP2PBeacon("not-json")).toThrow(/不是合法 JSON/);
    expect(() => decodeP2PBeacon("[1,2,3]")).toThrow(/JSON 对象/);
    expect(() => decodeP2PBeacon(JSON.stringify({ magic: "evil" }))).toThrow(/魔数不匹配/);

    const beacon = createP2PBeacon({
      identity: peerIdentity,
      host: "192.168.1.23",
      port: 48210,
      ttlMs: 3_000,
    });
    const tamper = (patch: Record<string, unknown>) =>
      Buffer.from(JSON.stringify({ ...beacon, ...patch }), "utf8");

    expect(() => decodeP2PBeacon(tamper({ serviceType: "_other._tcp" }))).toThrow(/服务类型不匹配/);
    expect(() => decodeP2PBeacon(tamper({ beaconVersion: 99 }))).toThrow(/格式版本不兼容/);
    expect(() => decodeP2PBeacon(tamper({ ttlMs: -1 }))).toThrow(/ttlMs 非法/);
    expect(() => decodeP2PBeacon(tamper({ device: { ...beacon.device, port: 70_000 } }))).toThrow(
      /端口非法/,
    );
    expect(() =>
      decodeP2PBeacon(tamper({ device: { ...beacon.device, protocolVersion: "v99" } })),
    ).toThrow(/协议版本不兼容/);
    expect(() => decodeP2PBeacon(tamper({ device: { ...beacon.device, deviceId: 42 } }))).toThrow(
      /必须是字符串/,
    );
    const oversizedName = tamper({
      device: { ...beacon.device, deviceName: "x".repeat(500) },
    });
    expect(() => decodeP2PBeacon(oversizedName)).toThrow(/超长/);
  });

  it("超长信标在编码与解码两侧都被拒绝（长度受限，永不写出超长报文）", () => {
    const beacon = createP2PBeacon({
      identity: peerIdentity,
      host: "192.168.1.23",
      port: 48210,
      ttlMs: 3_000,
    });
    // 解码侧：超过硬上限直接拒绝，不做任何解析
    const huge = Buffer.alloc(P2P_DISCOVERY_MAX_BEACON_BYTES + 16, 0x61);
    expect(() => decodeP2PBeacon(huge)).toThrow(/超长信标/);
    // 编码侧：超过调用方收紧的上限直接拒绝
    expect(() => encodeP2PBeacon(beacon, { maxBytes: 16 })).toThrow(/超长/);
    // 默认上限下正常信标仍可编码，且长度受控
    const encoded = encodeP2PBeacon(beacon);
    expect(encoded.byteLength).toBeLessThan(P2P_DISCOVERY_MAX_BEACON_BYTES);
    expect(decodeP2PBeacon(encoded).device.deviceId).toBe(peerIdentity.deviceId);
  });

  it("发现对端：地址取报文源地址（绝不采信自报 host）、TTL 只能被缩短、onPeer 去重", async () => {
    const seen: string[] = [];
    const errors: Error[] = [];
    const { discovery, fake } = createDiscoveryWithFakeSocket({
      overrides: {
        peerTtlMs: 500,
        onPeer: (peer) => seen.push(`${peer.device.deviceId}:${peer.device.host}:${peer.device.port}`),
        onError: (error) => errors.push(error),
      },
    });
    await discovery.start();
    expect(fake.boundPort).toBe(48201);
    expect(fake.memberships).toEqual([P2P_DISCOVERY_DEFAULT_GROUP]);
    expect(fake.multicastTtl).toBe(1);
    expect(fake.sent.length).toBeGreaterThanOrEqual(1); // start() 立即广播一次

    // 对端自称 host=1.2.3.4 且 TTL 超长（9_999_999ms），源地址是 10.0.0.9
    fake.deliver(buildPeerBeacon({ ttlMs: 9_999_999, port: 48201, host: "1.2.3.4" }), {
      address: "10.0.0.9",
      port: 55555,
    });
    const peers = discovery.listPeers();
    expect(peers).toHaveLength(1);
    expect(peers[0]?.source).toBe("beacon");
    expect(peers[0]?.device.deviceId).toBe(peerIdentity.deviceId);
    expect(peers[0]?.device.host).toBe("10.0.0.9"); // 源地址覆盖自报 host
    expect(peers[0]?.device.fingerprint).toBe(computePublicKeyFingerprint(peerIdentity.publicKey));
    expect(peers[0]?.ttlMs).toBe(500); // 对端自报 TTL 不能超过本地上限
    expect(seen).toHaveLength(1);

    // 同一描述符重复广播：不重复回调
    fake.deliver(buildPeerBeacon({ ttlMs: 2_000, port: 48201, host: "1.2.3.4" }), {
      address: "10.0.0.9",
      port: 55555,
    });
    expect(seen).toHaveLength(1);

    // 端口变化：视为描述符变化，重新回调
    fake.deliver(buildPeerBeacon({ port: 48299 }), { address: "10.0.0.9", port: 55555 });
    expect(seen).toHaveLength(2);
    expect(discovery.listPeers()[0]?.device.port).toBe(48299);

    // 自己的信标（多播回环）不登记
    const ownBeacon = encodeP2PBeacon(
      createP2PBeacon({ identity: localIdentity, host: "127.0.0.1", port: 49002, ttlMs: 2_000 }),
    );
    fake.deliver(ownBeacon, { address: "127.0.0.1", port: 48201 });
    expect(discovery.listPeers()).toHaveLength(1);

    // 坏包只上报，绝不影响已有对端，也不抛出
    fake.deliver(Buffer.from("garbage"), { address: "10.0.0.9", port: 55555 });
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(discovery.listPeers()).toHaveLength(1);

    await discovery.stop();
  });

  it("对端在 TTL 之后过期（注入时钟），并触发 onPeerExpired", async () => {
    let nowMs = 1_000_000;
    const expired: string[] = [];
    const { discovery, fake } = createDiscoveryWithFakeSocket({
      overrides: {
        peerTtlMs: 1_000,
        now: () => nowMs,
        onPeerExpired: (peer) => expired.push(peer.device.deviceId),
      },
    });
    await discovery.start();

    fake.deliver(buildPeerBeacon({ ttlMs: 1_000 }), { address: "10.0.0.9", port: 55555 });
    expect(discovery.listPeers()).toHaveLength(1);

    nowMs += 999;
    expect(discovery.listPeers()).toHaveLength(1); // 未到期

    nowMs += 2;
    expect(discovery.listPeers()).toHaveLength(0); // 已过期
    expect(expired).toEqual([peerIdentity.deviceId]);

    // 过期后再次广播即恢复
    fake.deliver(buildPeerBeacon({ ttlMs: 1_000 }), { address: "10.0.0.9", port: 55555 });
    expect(discovery.listPeers()).toHaveLength(1);

    await discovery.stop();
  });

  it("过期清理定时器独立生效（无需调用 listPeers 也会清理）", async () => {
    let resolveExpired: (deviceId: string) => void = () => undefined;
    const expiredPromise = new Promise<string>((resolve) => {
      resolveExpired = resolve;
    });
    const { discovery, fake } = createDiscoveryWithFakeSocket({
      overrides: {
        peerTtlMs: 150,
        onPeerExpired: (peer) => resolveExpired(peer.device.deviceId),
      },
    });
    await discovery.start();
    fake.deliver(buildPeerBeacon({ ttlMs: 150 }), { address: "10.0.0.9", port: 55555 });
    expect(discovery.listPeers()).toHaveLength(1);

    await expect(expiredPromise).resolves.toBe(peerIdentity.deviceId);
    expect(discovery.listPeers()).toHaveLength(0);
    await discovery.stop();
  });

  it("stop() 幂等、摘除全部监听器、关闭 socket 且不再广播", async () => {
    const { discovery, fake } = createDiscoveryWithFakeSocket({
      overrides: { beaconIntervalMs: 20 },
    });
    await discovery.start();
    expect(discovery.isRunning()).toBe(true);
    const sentBeforeStop = fake.sent.length;

    await discovery.stop();
    expect(discovery.isRunning()).toBe(false);
    expect(fake.closed).toBe(true);
    expect(fake.closeCalls).toBe(1);
    for (const event of ["message", "error", "listening", "close"]) {
      expect(fake.listenerCount(event)).toBe(0);
    }
    expect(fake.droppedMemberships).toEqual([P2P_DISCOVERY_DEFAULT_GROUP]);

    await discovery.stop(); // 幂等
    expect(fake.closeCalls).toBe(1);

    await discovery.sendBeaconNow(); // 已停止：静默 no-op，不抛错
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(fake.sent.length).toBe(sentBeforeStop);
  });

  it("静态对端模式（不使用多播）：不创建 socket、地址恒在、身份待握手确认", async () => {
    let socketCreated = 0;
    const discovery = new P2PDiscovery({
      identity: localIdentity,
      host: "127.0.0.1",
      port: 49003,
      multicast: false,
      staticPeers: [
        { host: "192.168.1.50", port: 48201, deviceId: "mobile_abc", deviceName: "iPhone" },
        { host: "192.168.1.51", port: 48202 },
        { host: "192.168.1.52", port: -1 }, // 非法端口：静默忽略
      ],
      socketFactory: () => {
        socketCreated += 1;
        return new FakeDiscoverySocket() as unknown as P2PDiscoverySocket;
      },
    });
    await discovery.start();
    expect(socketCreated).toBe(0); // 静态模式绝不依赖真实多播

    const peers = discovery.listPeers();
    expect(peers).toHaveLength(2);
    expect(peers.every((peer) => peer.source === "static")).toBe(true);
    expect(peers[0]?.expiresAtMs).toBe(Number.POSITIVE_INFINITY); // 静态对端不过期
    const mobile = peers.find((peer) => peer.device.deviceId === "mobile_abc");
    expect(mobile?.device.host).toBe("192.168.1.50");
    expect(mobile?.device.port).toBe(48201);
    expect(mobile?.device.publicKey).toBe(""); // 未经验证：绝不为静态对端伪造凭据

    await discovery.stop();
    expect(discovery.listPeers()).toHaveLength(0);
  });

  it("多播不可用时降级：start() 不抛错、错误上报、静态对端仍可用", async () => {
    const fake = new FakeDiscoverySocket();
    fake.failMembership = true;
    const errors: Error[] = [];
    const { discovery } = createDiscoveryWithFakeSocket({
      fake,
      overrides: {
        onError: (error) => errors.push(error),
        staticPeers: [{ host: "192.168.1.50", port: 48201, deviceId: "mobile_abc" }],
      },
    });
    await discovery.start();
    expect(discovery.isRunning()).toBe(true);
    expect(errors.some((error) => /加入多播组/.test(error.message))).toBe(true);
    expect(fake.sent.length).toBeGreaterThanOrEqual(1); // 仍尝试广播
    expect(discovery.listPeers().map((peer) => peer.device.deviceId)).toContain("mobile_abc");
    await discovery.stop();
  });

  it("绑定失败/超时一律 fail-closed 并复位运行状态（清理 socket，可重试）", async () => {
    // (a) bind 同步抛错（如 EADDRINUSE）
    const failingFake = new FakeDiscoverySocket();
    failingFake.failBind = true;
    const { discovery: failing } = createDiscoveryWithFakeSocket({ fake: failingFake });
    await expect(failing.start()).rejects.toThrow(/绑定失败/);
    expect(failing.isRunning()).toBe(false);
    expect(failingFake.closed).toBe(true); // 不留下半开 socket

    // (b) bind 永不回调 → 有界超时
    const silentFake = new FakeDiscoverySocket();
    silentFake.silentBind = true;
    const { discovery: timingOut } = createDiscoveryWithFakeSocket({
      fake: silentFake,
      overrides: { bindTimeoutMs: 50 },
    });
    await expect(timingOut.start()).rejects.toThrow(/未绑定成功/);
    expect(timingOut.isRunning()).toBe(false);
    expect(silentFake.closed).toBe(true);

    // (c) bind 落地前收到 socket error 事件 → 立即失败（不白等超时）
    const errorFake = new FakeDiscoverySocket();
    errorFake.silentBind = true;
    const { discovery: erroring } = createDiscoveryWithFakeSocket({
      fake: errorFake,
      overrides: { bindTimeoutMs: 5_000 },
    });
    const started = erroring.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const startedAt = Date.now();
    errorFake.emit("error", new Error("EADDRINUSE: 端口被占用"));
    await expect(started).rejects.toThrow(/socket 错误/);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(erroring.isRunning()).toBe(false);

    // (d) 失败后状态已复位：修复环境即可重试成功
    const retryFake = new FakeDiscoverySocket();
    retryFake.failBind = true;
    const { discovery: retry } = createDiscoveryWithFakeSocket({ fake: retryFake });
    await expect(retry.start()).rejects.toThrow(/绑定失败/);
    retryFake.failBind = false;
    retryFake.closed = false;
    await retry.start();
    expect(retry.isRunning()).toBe(true);
    expect(retryFake.memberships).toEqual([P2P_DISCOVERY_DEFAULT_GROUP]);
    await retry.stop();
  });

  it("构造参数非法时 fail-closed（设备身份缺失 / TTL 过小 / 端口非法）", () => {
    expect(
      () =>
        new P2PDiscovery({
          identity: { ...localIdentity, deviceId: "" },
          host: "127.0.0.1",
          port: 1,
        }),
    ).toThrow(/设备身份/);
    expect(
      () => new P2PDiscovery({ identity: localIdentity, host: "127.0.0.1", port: 1, peerTtlMs: 1 }),
    ).toThrow(/peerTtlMs/);
    expect(
      () =>
        new P2PDiscovery({ identity: localIdentity, host: "127.0.0.1", port: 1, discoveryPort: 0 }),
    ).toThrow(/discoveryPort/);
  });

  /**
   * 真实多播往返（同一台机器上的两个实例，使用非默认多播组/端口避免干扰其他测试）。
   *
   * 多播在 CI/容器/开启 AP 隔离的网络里**可能完全不可用**，因此本用例在超时后
   * 以 `ctx.skip()` 优雅跳过（不失败），并在控制台说明原因——这与模块头注释的
   * "多播是尽力而为的优化，静态对端列表是兜底"一致。
   */
  it("真实多播信标往返（不可用时优雅跳过，不判失败）", async (ctx) => {
    const group = "239.255.77.31";
    const discoveryPort = 48_000 + ((process.pid + 7) % 900);
    const errors: Error[] = [];
    const localA = generateDeviceIdentity("多播自测 A", "mc_a");
    const localB = generateDeviceIdentity("多播自测 B", "mc_b");
    const a = new P2PDiscovery({
      identity: localA,
      host: "127.0.0.1",
      port: 49_101,
      group,
      discoveryPort,
      beaconIntervalMs: 200,
      peerTtlMs: 3_000,
      onError: (error) => errors.push(error),
    });
    const b = new P2PDiscovery({
      identity: localB,
      host: "127.0.0.1",
      port: 49_102,
      group,
      discoveryPort,
      beaconIntervalMs: 200,
      peerTtlMs: 3_000,
      onError: (error) => errors.push(error),
    });
    try {
      await a.start();
      await b.start();
      const deadline = Date.now() + 4_000;
      while (Date.now() < deadline && b.listPeers().length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const peers = b.listPeers();
      if (peers.length === 0) {
        console.warn(
          `[skip] 本机多播不可用或不可靠（端口 ${discoveryPort}，错误：${
            errors.map((error) => error.message).join(" | ") || "超时未收到信标"
          }）；静态对端列表仍可正常驱动传输层。`,
        );
        ctx.skip();
        return;
      }
      expect(peers[0]?.device.deviceId).toBe(localA.deviceId);
      expect(peers[0]?.device.port).toBe(49_101);
    } finally {
      await a.stop();
      await b.stop();
    }
  });
});
