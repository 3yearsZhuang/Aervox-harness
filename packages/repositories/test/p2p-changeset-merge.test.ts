/**
 * Aervox｜思隅 @aervox/repositories — P2P Changeset 合并引擎缺陷回归测试（ITER-028 / PR #234 D1–D10）
 *
 * 覆盖目标（每条都对应一个曾经可复现的数据丢失缺陷）：
 * - D1  `turns` 误分类为 append_only → Completed 永不传播；
 * - D2  外键拓扑顺序错误 → 同包内 questions 先于 knowledge_items 会撞 FK；
 * - D3  非主键 UNIQUE 冲突中断整包；
 * - D4  合并端硬编码 updated_at，忽略 `timestampColumn`；
 * - D5  双向同步水位线反向（A 用 bSince、B 用 aSince）；
 * - D6  缺版本门禁，不兼容包被“尽力合并”；
 * - D7  白名单表缺失时静默 no-op；
 * - D8  无墓碑 → 删除不传播 / 复活；
 * - D9  LWW Tiebreaker 用中继设备 → 重复同步产生无意义 UPDATE；
 * - D10 整包单事务长持锁 / 分块与原子性 trade-off。
 *
 * 对抗性复审残余缺陷回归（F1–F7，见同名测试标题前缀）：
 * - F1 接收端不信任对端表身份与列元数据：白名单外/元数据不符整表拒绝，顺序按本地白名单重排；
 * - F2 schema 漂移行逐行隔离（不毒化同批正常行），分批中断时显式报告“部分应用”；
 * - F3 写入 vs 墓碑统一按 `(比较时钟, origin_device_id)` 元组裁决（四个方向）；
 * - F4 墓碑分支补齐设备 ID 决胜（与行路径同一 helper）；
 * - F5 `assertSyncTableOrder` 在接收端真实生效；
 * - F6 `uniqueConflicts` 不再重复计入 `skippedCount`、无效墓碑不计 `deletedCount`、设备 ID 参数化绑定；
 * - F7 级联删除的实测行为在文档中如实描述（见 exploration 文档，无需代码回归用例）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  createDatabase,
  initDatabaseSchema,
  buildP2PSyncBundle,
  applyP2PSyncBundle,
  executeP2PBidirectionalSync,
  extractTableChangeset,
  assertSyncTableOrder,
  assertSyncBundleVersionCompatible,
  installSyncTriggers,
  readSyncRowStates,
  triggerName,
  generateDeviceIdentity,
  DEFAULT_SYNC_TABLES,
  SYNC_CHANGESET_PROTOCOL_VERSION,
  SYNC_CHANGESET_SCHEMA_VERSION,
  SyncMetadataTableMissingError,
  SyncPartialMergeError,
  SyncVersionMismatchError,
  type AervoxDatabase,
  type P2PSyncBundle,
  type SyncTableDefinition,
  type TableChangeset,
} from "../src/index.js";
import { establishVerifiedPairing } from "./helpers/p2p-session.js";
import type { Client } from "@libsql/client";

const DEVICE_A = "dev_aaa";
const DEVICE_B = "dev_bbb";
const DEVICE_C = "dev_ccc";

const T0 = "2026-09-29T08:00:00.000Z";
const T1 = "2026-09-29T09:00:00.000Z";
const T2 = "2026-09-29T10:00:00.000Z";
const T3 = "2026-09-29T11:00:00.000Z";
const T4 = "2026-09-29T12:00:00.000Z";

interface Node {
  db: AervoxDatabase;
  client: Client;
  deviceId: string;
  file: string;
}

describe("ITER-028 合并引擎缺陷回归（D1–D10）", () => {
  const nodes: Node[] = [];

  async function createNode(prefix: string, deviceId: string): Promise<Node> {
    const file = path.join(
      os.tmpdir(),
      `aervox_p2p_merge_${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`,
    );
    const conn = await createDatabase({ url: `file:${file}` });
    await initDatabaseSchema(conn.client);
    const node: Node = { db: conn.db, client: conn.client, deviceId, file };
    nodes.push(node);
    return node;
  }

  async function createTriggeredNode(prefix: string, deviceId: string): Promise<Node> {
    const node = await createNode(prefix, deviceId);
    await installSyncTriggers(node.client, DEFAULT_SYNC_TABLES, deviceId);
    return node;
  }

  /**
   * 用真实**承诺-揭示**配对握手建立两端会话，并在用户确认 SAS 后标记为已验证。
   * 刻意不手搓 `EstablishedP2PSession`：加密层对未验证会话 fail-closed，
   * 手搓对象既会被拒绝，也无法覆盖真实的密钥派生路径。
   */
  function establishSessions() {
    const pairing = establishVerifiedPairing({
      initiatorName: "Node A",
      responderName: "Node B",
      initiatorPrefix: DEVICE_A,
      responderPrefix: DEVICE_B,
    });
    return { nodeA: pairing.initiatorSession, nodeB: pairing.responderSession };
  }

  /** 直接往返（不经加密），只测数据/合并引擎 */
  async function relay(from: Node, to: Node, sinceWatermark = T0) {
    const bundle = await buildP2PSyncBundle(from.client, {
      sourceDeviceId: from.deviceId,
      targetDeviceId: to.deviceId,
      sinceWatermark,
    });
    const result = await applyP2PSyncBundle(to.client, bundle, to.deviceId);
    return { bundle, result };
  }

  async function countRows(client: Client, sql: string, args: unknown[] = []): Promise<number> {
    const res = await client.execute({ sql, args: args as never });
    return res.rows.length;
  }

  /** 单表载荷的宽松描述：未给出的字段按本地默认定义补齐（用于投放“对端可能伪造/漂移”的载荷） */
  type CraftedTable = {
    tableName: string;
    primaryKey?: string;
    strategy?: TableChangeset["strategy"];
    timestampColumn?: string | null;
    records?: Array<Record<string, unknown>>;
    deleted?: TableChangeset["deleted"];
  };

  /** 构造手工同步包：只用于验证接收端的信任边界与 LWW 裁决 */
  function craftedBundle(
    tables: CraftedTable[],
    sourceDeviceId: string = DEVICE_A,
    targetDeviceId: string = DEVICE_B,
  ): P2PSyncBundle {
    return {
      bundleId: `bundle_crafted_${Math.random().toString(36).slice(2, 8)}`,
      protocolVersion: SYNC_CHANGESET_PROTOCOL_VERSION,
      changesetSchemaVersion: SYNC_CHANGESET_SCHEMA_VERSION,
      sourceDeviceId,
      targetDeviceId,
      sinceWatermark: T0,
      generatedAt: T0,
      tables: tables.map((t) => ({
        tableName: t.tableName,
        primaryKey: t.primaryKey ?? "id",
        strategy: t.strategy ?? "lww",
        timestampColumn: t.timestampColumn === null ? undefined : (t.timestampColumn ?? "updated_at"),
        records: t.records ?? [],
        deleted: t.deleted ?? [],
      })) as TableChangeset[],
    };
  }

  /** learning_goals 的完整行（含全部 NOT NULL 列），并显式携带权威哨兵列 */
  function craftedGoalRow(
    id: string,
    topic: string,
    timestamp: string,
    originDeviceId: string,
  ): Record<string, unknown> {
    return {
      id,
      topic,
      level: "beginner",
      available_minutes: 10,
      status: "active",
      created_at: timestamp,
      updated_at: timestamp,
      __aervox_ts: timestamp,
      __aervox_origin_device: originDeviceId,
    };
  }

  /**
   * 只让第 N 个写事务失败的外壳客户端：用于验证“前 N-1 批已提交”时的部分合并报告。
   * libsql 的事务方法内部持有私有字段，因此这里把方法绑定回真实客户端（绝不以代理作为 `this`）。
   */
  function createFailOnNthTransactionClient(real: Client, failAt: number): Client {
    let seen = 0;
    return new Proxy(real, {
      get(target, prop) {
        if (prop === "transaction") {
          return async (mode: "write" | "read" = "write") => {
            seen += 1;
            if (seen === failAt) {
              throw new Error("注入的写事务失败（模拟锁超时 / IO 中断）");
            }
            return target.transaction(mode);
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function"
          ? (value as (...args: unknown[]) => unknown).bind(target)
          : value;
      },
    }) as Client;
  }

  beforeEach(() => {
    nodes.length = 0;
  });

  afterEach(() => {
    for (const node of nodes) {
      try {
        node.client.close();
        for (const suffix of ["", "-wal", "-shm"]) {
          const f = `${node.file}${suffix}`;
          if (fs.existsSync(f)) fs.unlinkSync(f);
        }
      } catch {
        // ignore
      }
    }
  });

  it("D1: turns 使用 LWW，已完成状态必须传播（append_only 会永久卡住 Completed）", async () => {
    const nodeA = await createNode("d1a", DEVICE_A);
    const nodeB = await createNode("d1b", DEVICE_B);

    await nodeA.client.execute({
      sql: `INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      args: ["ses_1", "线性代数答疑", T0, T0],
    });
    await nodeA.client.execute({
      sql: `INSERT INTO turns (id, session_id, idempotency_key, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["turn_1", "ses_1", "idem_turn_1", "Created", T0, T0],
    });

    // 第一次同步：turn 以 Created 落到 B
    await relay(nodeA, nodeB);
    const createdOnB = await nodeB.client.execute("SELECT * FROM turns WHERE id = 'turn_1'");
    expect(createdOnB.rows[0]?.status).toBe("Created");

    // A 端标记完成（updated_at 前进）
    await nodeA.client.execute({
      sql: `UPDATE turns SET status = ?, completed_at = ?, last_sequence = ?, updated_at = ?
            WHERE id = ?`,
      args: ["Completed", T1, 7, T1, "turn_1"],
    });

    // 第二次同步：旧代码把 turns 当 append_only，主键已存在 → skipped，B 永远看不到 Completed。
    // （skippedCount 只可能来自未变化的 sessions 行，turn 必须被判为 updated。）
    const second = await relay(nodeA, nodeB);
    const completedOnB = await nodeB.client.execute("SELECT * FROM turns WHERE id = 'turn_1'");
    expect(second.result.updatedCount).toBe(1);
    expect(completedOnB.rows[0]?.status).toBe("Completed");
    expect(completedOnB.rows[0]?.last_sequence).toBe(7);
    expect(completedOnB.rows[0]?.completed_at).toBe(T1);
  });

  it("D2: 一个包内同时含 knowledge_item 与引用它的 question，外键不得报错", async () => {
    const nodeA = await createNode("d2a", DEVICE_A);

    await nodeA.client.execute({
      sql: `INSERT INTO knowledge_items (id, concept, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      args: ["kn_1", "特征值", T0, T0],
    });
    await nodeA.client.execute({
      sql: `INSERT INTO questions (id, knowledge_id, prompt, answer_spec, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["q_1", "kn_1", "什么是特征值？", JSON.stringify({ type: "text" }), T0, T0],
    });

    const bundle = await buildP2PSyncBundle(nodeA.client, {
      sourceDeviceId: DEVICE_A,
      targetDeviceId: DEVICE_B,
      sinceWatermark: T0,
    });

    // 白名单顺序必须满足 knowledge_items 先于 questions
    const order = bundle.tables.map((t) => t.tableName);
    expect(order.indexOf("knowledge_items")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("knowledge_items")).toBeLessThan(order.indexOf("questions"));

    // 用一个全新的库验证真实外键约束下不报错（旧代码会抛 SQLITE_CONSTRAINT_FOREIGNKEY 并整包回滚）
    const nodeB = await createNode("d2b", DEVICE_B);
    const result = await applyP2PSyncBundle(nodeB.client, bundle, DEVICE_B);
    expect(result.skippedTables).toEqual([]);
    expect(await countRows(nodeB.client, "SELECT 1 FROM knowledge_items WHERE id = 'kn_1'")).toBe(1);
    expect(
      await countRows(nodeB.client, "SELECT 1 FROM questions WHERE id = 'q_1' AND knowledge_id = 'kn_1'"),
    ).toBe(1);

    // 程序化看护：白名单顺序必须与真实外键拓扑一致
    await expect(assertSyncTableOrder(nodeB.client, DEFAULT_SYNC_TABLES)).resolves.toBeUndefined();
  });

  it("D2b: 故意颠倒父子顺序时 assertSyncTableOrder 必须报错（看护有效）", async () => {
    const node = await createNode("d2c", DEVICE_A);
    const reversed = [...DEFAULT_SYNC_TABLES].reverse();
    await expect(assertSyncTableOrder(node.client, reversed)).rejects.toThrow(
      /外键拓扑顺序/,
    );
  });

  it("D3: 非主键 UNIQUE 冲突只跳过该行，绝不中断整包（其他表照常落库）", async () => {
    const nodeA = await createNode("d3a", DEVICE_A);
    const nodeB = await createNode("d3b", DEVICE_B);

    for (const node of [nodeA, nodeB]) {
      await node.client.execute({
        sql: `INSERT INTO questions (id, prompt, answer_spec, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?)`,
        args: ["q_shared", "矩阵秩", JSON.stringify({ type: "text" }), T0, T0],
      });
    }

    // 两台设备各自离线为同一道题创建了错题处置（question_id UNIQUE，但主键不同）
    await nodeA.client.execute({
      sql: `INSERT INTO mistake_dispositions (id, question_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: ["mis_alpha", "q_shared", "active", T1, T1],
    });
    await nodeB.client.execute({
      sql: `INSERT INTO mistake_dispositions (id, question_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: ["mis_beta", "q_shared", "dismissed", T2, T2],
    });
    // 同一包内另有一个必须落库的无关表行（旧代码在 UNIQUE 冲突时整包事务回滚 → 该行也丢）
    await nodeA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_shared", "线性代数", "beginner", 30, "active", T1, T1],
    });

    const result = await applyP2PSyncBundle(
      nodeB.client,
      await buildP2PSyncBundle(nodeA.client, {
        sourceDeviceId: DEVICE_A,
        targetDeviceId: DEVICE_B,
        sinceWatermark: T0,
      }),
      DEVICE_B,
    );

    expect(result.uniqueConflicts).toBe(1);
    // 关键断言：包内其它表的数据必须照常落库（旧代码会因唯一冲突整包回滚）
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_shared'")).toBe(1);
    // B 本地自己的处置记录必须保留（不得被 A 的冲突行覆盖）
    const onB = await nodeB.client.execute("SELECT * FROM mistake_dispositions WHERE question_id = 'q_shared'");
    expect(onB.rows).toHaveLength(1);
    expect(onB.rows[0]?.id).toBe("mis_beta");
  });

  it("D4: 合并必须使用 TableChangeset 携带的 timestampColumn，而不是硬编码 updated_at", async () => {
    const nodeA = await createNode("d4a", DEVICE_A);
    const nodeB = await createNode("d4b", DEVICE_B);

    const customTables: SyncTableDefinition[] = [
      { tableName: "custom_notes", primaryKey: "id", timestampColumn: "touched_at", strategy: "lww" },
    ];

    for (const node of [nodeA, nodeB]) {
      await node.client.execute(`
        CREATE TABLE IF NOT EXISTS custom_notes (
          id TEXT PRIMARY KEY,
          body TEXT NOT NULL,
          touched_at TEXT NOT NULL
        );
      `);
    }

    async function customBundle() {
      return buildP2PSyncBundle(nodeA.client, {
        sourceDeviceId: DEVICE_A,
        targetDeviceId: DEVICE_B,
        tables: customTables,
      });
    }

    // 1) 本地没有该行 → 必须插入（旧代码硬编码 updated_at，SQL 会因列不存在直接抛错）
    await nodeA.client.execute({
      sql: `INSERT INTO custom_notes (id, body, touched_at) VALUES (?, ?, ?)`,
      args: ["note_1", "v1", T1],
    });
    const insertResult = await applyP2PSyncBundle(nodeB.client, await customBundle(), DEVICE_B, {
      tables: customTables,
    });
    expect(insertResult.insertedCount).toBe(1);
    expect(insertResult.skippedTables).toEqual([]);
    const inserted = await nodeB.client.execute("SELECT * FROM custom_notes WHERE id = 'note_1'");
    expect(inserted.rows[0]?.body).toBe("v1");
    expect(inserted.rows[0]?.touched_at).toBe(T1);

    // 2) 合并后提取端必须使用同一列判定增量（旧代码合并用 created_at，会重复回传/漏传）
    const extracted = await extractTableChangeset(nodeA.client, customTables[0], {
      sinceWatermark: T0,
    });
    expect(extracted.timestampColumn).toBe("touched_at");
    expect(extracted.records).toHaveLength(1);

    // 3) LWW 裁决必须比较 touched_at：A 的 T3 > B 本地的 T1 → 覆盖胜出
    await nodeA.client.execute({
      sql: `UPDATE custom_notes SET body = ?, touched_at = ? WHERE id = ?`,
      args: ["v2", T3, "note_1"],
    });
    const updateResult = await applyP2PSyncBundle(nodeB.client, await customBundle(), DEVICE_B, {
      tables: customTables,
    });
    expect(updateResult.updatedCount).toBe(1);
    const updated = await nodeB.client.execute("SELECT * FROM custom_notes WHERE id = 'note_1'");
    expect(updated.rows[0]?.body).toBe("v2");

    // 4) 相同数据重复合并必须零更新（旧代码用 created_at 兜底会不断重复回传）
    const again = await applyP2PSyncBundle(nodeB.client, await customBundle(), DEVICE_B, {
      tables: customTables,
    });
    expect(again.updatedCount).toBe(0);
    expect(again.insertedCount).toBe(0);
    expect(again.skippedCount).toBe(1);
  });

  it("D5: 双向同步各用自己一侧的水位线（A 用 aSince、B 用 bSince）", async () => {
    const nodeA = await createNode("d5a", DEVICE_A);
    const nodeB = await createNode("d5b", DEVICE_B);

    await nodeA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_a_old", "旧目标", "beginner", 10, "active", T1, T1],
    });
    await nodeB.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_b_old", "B 旧目标", "beginner", 10, "active", T2, T2],
    });
    // A 侧水位 T2：A 只应发送 T2 之后的数据
    await nodeA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_a_new", "A 新目标", "beginner", 10, "active", T3, T3],
    });
    // B 侧水位 T3：B 只应发送 T3 之后的数据
    await nodeB.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_b_new", "B 新目标", "beginner", 10, "active", T4, T4],
    });

    const syncRes = await executeP2PBidirectionalSync({
      nodeA: { client: nodeA.client, deviceId: DEVICE_A },
      nodeB: { client: nodeB.client, deviceId: DEVICE_B },
      sessions: establishSessions(),
      watermarks: { aSince: T2, bSince: T3 },
    });

    // 旧代码 A 用 bSince(T3) → 看不到 goal_a_new；B 用 aSince(T2) → 会把 goal_b_old 回传
    expect(syncRes.aToBResult.insertedCount).toBe(1);
    expect(syncRes.bToAResult.insertedCount).toBe(1);

    expect(
      await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_a_new'"),
    ).toBe(1);
    expect(
      await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_a_old'"),
    ).toBe(0);

    expect(
      await countRows(nodeA.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_b_new'"),
    ).toBe(1);
    expect(
      await countRows(nodeA.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_b_old'"),
    ).toBe(0);
  });

  it("D6: 不兼容版本必须在应用端 fail-closed 拒绝（构建端也带版本）", async () => {
    const nodeA = await createNode("d6a", DEVICE_A);
    const nodeB = await createNode("d6b", DEVICE_B);

    await nodeA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_v", "版本目标", "beginner", 10, "active", T1, T1],
    });

    const bundle = await buildP2PSyncBundle(nodeA.client, {
      sourceDeviceId: DEVICE_A,
      targetDeviceId: DEVICE_B,
      sinceWatermark: T0,
    });
    expect(bundle.protocolVersion).toBe(SYNC_CHANGESET_PROTOCOL_VERSION);
    expect(bundle.changesetSchemaVersion).toBe(SYNC_CHANGESET_SCHEMA_VERSION);
    expect(bundle.tables[0]?.timestampColumn).toBeDefined();
    expect(bundle.tables[0]?.deleted).toBeDefined();

    // 1) 协议版本不支持
    const badProtocol: P2PSyncBundle = { ...bundle, protocolVersion: "v99" };
    await expect(applyP2PSyncBundle(nodeB.client, badProtocol, DEVICE_B)).rejects.toThrow(
      SyncVersionMismatchError,
    );
    // fail-closed：被拒绝的包不得留下任何数据
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals")).toBe(0);

    // 2) 结构版本不支持
    const badSchema: P2PSyncBundle = { ...bundle, changesetSchemaVersion: "v99" };
    await expect(applyP2PSyncBundle(nodeB.client, badSchema, DEVICE_B)).rejects.toThrow(
      /changeset 结构版本/,
    );

    // 3) 版本字段整体缺失（旧包）也拒绝
    const noVersion = { ...bundle } as Partial<P2PSyncBundle>;
    delete noVersion.protocolVersion;
    await expect(
      applyP2PSyncBundle(nodeB.client, noVersion as P2PSyncBundle, DEVICE_B),
    ).rejects.toThrow(SyncVersionMismatchError);

    // 4) 显式版本守卫本身可独立调用
    expect(() =>
      assertSyncBundleVersionCompatible({ protocolVersion: "v1", changesetSchemaVersion: "v99" }),
    ).toThrow(SyncVersionMismatchError);

    // 5) 合法包正常应用
    const ok = await applyP2PSyncBundle(nodeB.client, bundle, DEVICE_B);
    expect(ok.insertedCount).toBe(1);

    // 6) 元数据表缺失时 fail-closed（schema 漂移不得悄悄降级）
    const nodeC = await createNode("d6c", DEVICE_C);
    await nodeC.client.execute("DROP TABLE sync_row_state");
    await expect(applyP2PSyncBundle(nodeC.client, bundle, DEVICE_C)).rejects.toThrow(
      SyncMetadataTableMissingError,
    );
  });

  it("D7: 白名单表缺失必须显式上报 skippedTables，不得静默 no-op", async () => {
    const nodeA = await createNode("d7a", DEVICE_A);
    const nodeB = await createNode("d7b", DEVICE_B);

    await nodeA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_drift", "漂移目标", "beginner", 10, "active", T1, T1],
    });

    const bundle = await buildP2PSyncBundle(nodeA.client, {
      sourceDeviceId: DEVICE_A,
      targetDeviceId: DEVICE_B,
      sinceWatermark: T0,
    });
    expect(bundle.tables.some((t) => t.tableName === "learning_goals")).toBe(true);

    // 模拟目标端 schema 漂移：表被删除
    await nodeB.client.execute("DROP TABLE learning_goals");

    const result = await applyP2PSyncBundle(nodeB.client, bundle, DEVICE_B);
    // 旧代码 `continue` 静默跳过 → skippedTables 为 undefined，调用方无从得知数据丢失
    expect(result.skippedTables).toContain("learning_goals");
    expect(result.insertedCount).toBe(0);
  });

  it("D8a: 删除必须传播为墓碑，且目标端行消失、墓碑落地", async () => {
    const nodeA = await createTriggeredNode("d8a", DEVICE_A);
    const nodeB = await createTriggeredNode("d8b", DEVICE_B);

    await nodeA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_del", "待删除", "beginner", 10, "active", T1, T1],
    });
    await relay(nodeA, nodeB, T0);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_del'")).toBe(1);

    await nodeA.client.execute({ sql: `DELETE FROM learning_goals WHERE id = ?`, args: ["goal_del"] });

    const statesOnA = await readSyncRowStates(nodeA.client, "learning_goals");
    expect(statesOnA).toHaveLength(1);
    expect(statesOnA[0]?.deletedAt).not.toBeNull();

    const { bundle, result } = await relay(nodeA, nodeB, T0);
    const goalTable = bundle.tables.find((t) => t.tableName === "learning_goals");
    expect(goalTable?.deleted.map((d) => d.primaryKeyValue)).toContain("goal_del");
    expect(result.deletedCount).toBe(1);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_del'")).toBe(0);

    const statesOnB = await readSyncRowStates(nodeB.client, "learning_goals");
    expect(statesOnB[0]?.deletedAt).not.toBeNull();
  });

  it("D8b: 重复同步（含水位线回退）不得让已删除的行复活", async () => {
    const nodeA = await createTriggeredNode("d8c", DEVICE_A);
    const nodeB = await createTriggeredNode("d8d", DEVICE_B);

    await nodeA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_x", "会被删", "beginner", 10, "active", T1, T1],
    });
    await relay(nodeA, nodeB, T0);
    await nodeA.client.execute({ sql: `DELETE FROM learning_goals WHERE id = ?`, args: ["goal_x"] });
    await relay(nodeA, nodeB, T0);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_x'")).toBe(0);

    // 再次同步（旧代码：无墓碑，A 端行已删 → 包为空，B 端行还在；再插入即可复活）
    const { bundle, result } = await relay(nodeA, nodeB, T0);
    const goalTable = bundle.tables.find((t) => t.tableName === "learning_goals");
    expect(goalTable?.records ?? []).toHaveLength(0);
    expect(result.deletedCount + result.skippedCount).toBeGreaterThanOrEqual(1);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_x'")).toBe(0);

    // 双向同步也必须保持删除状态（A 端不得因 B 的回传而复活该行）
    await executeP2PBidirectionalSync({
      nodeA: { client: nodeA.client, deviceId: DEVICE_A },
      nodeB: { client: nodeB.client, deviceId: DEVICE_B },
      sessions: establishSessions(),
      watermarks: { aSince: T0, bSince: T0 },
    });
    expect(await countRows(nodeA.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_x'")).toBe(0);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_x'")).toBe(0);
  });

  it("D8c: 删除之后有更新的写入时，后来的写入胜出并复活该行", async () => {
    const nodeA = await createTriggeredNode("d8e", DEVICE_A);
    const nodeB = await createTriggeredNode("d8f", DEVICE_B);

    await nodeA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_revive", "先建", "beginner", 10, "active", T1, T1],
    });
    await relay(nodeA, nodeB, T0);

    // A 先删除
    await nodeA.client.execute({
      sql: `DELETE FROM learning_goals WHERE id = ?`,
      args: ["goal_revive"],
    });
    const deleteBundle = await buildP2PSyncBundle(nodeA.client, {
      sourceDeviceId: DEVICE_A,
      targetDeviceId: DEVICE_B,
      sinceWatermark: T0,
    });
    const deleteApplied = await applyP2PSyncBundle(nodeB.client, deleteBundle, DEVICE_B);
    expect(deleteApplied.deletedCount).toBe(1);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_revive'")).toBe(0);

    // A 之后再以更晚时间戳重建（触发器盖章为 deleted_at = NULL 的新写入）。
    // 注意：删除时刻由 AFTER DELETE 触发器写入 `strftime('now')`，与测试常量 T0–T4 无关；
    // 统一元组裁决（F3）后只有**严格晚于删除时刻**的写入才能复活墓碑，
    // 因此这里按实际墓碑时刻派生新的时间戳，避免依赖测试文件里的固定日期早于/晚于真实时钟。
    const deletedStateOnA = (await readSyncRowStates(nodeA.client, "learning_goals"))[0];
    expect(deletedStateOnA?.deletedAt).not.toBeNull();
    const reviveAt = new Date(
      Date.parse(String(deletedStateOnA?.deletedAt ?? "")) + 1000,
    ).toISOString();

    await nodeA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_revive", "删除后重建", "advanced", 99, "completed", reviveAt, reviveAt],
    });
    const reviveStates = await readSyncRowStates(nodeA.client, "learning_goals");
    expect(reviveStates[0]?.deletedAt).toBeNull();

    const reviveBundle = await buildP2PSyncBundle(nodeA.client, {
      sourceDeviceId: DEVICE_A,
      targetDeviceId: DEVICE_B,
      sinceWatermark: T0,
    });
    const reviveApplied = await applyP2PSyncBundle(nodeB.client, reviveBundle, DEVICE_B);
    // B 端已存在墓碑（行物理已删），因此这是一次“复活覆盖”而不是全新插入
    expect(reviveApplied.updatedCount).toBe(1);
    expect(reviveApplied.deletedCount).toBe(0);
    const revived = await nodeB.client.execute("SELECT * FROM learning_goals WHERE id = 'goal_revive'");
    expect(revived.rows).toHaveLength(1);
    expect(revived.rows[0]?.topic).toBe("删除后重建");
    expect(revived.rows[0]?.available_minutes).toBe(99);
  });

  it("D8d: 更晚的本地写入必须击败更旧的远端墓碑（墓碑不删除较新的行）", async () => {
    const nodeB = await createTriggeredNode("d8g", DEVICE_B);

    // B 本地较新的写入
    await nodeB.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_local", "本地较新", "beginner", 10, "active", T4, T4],
    });

    // 伪造一个更旧的远端墓碑包
    const staleBundle: P2PSyncBundle = {
      bundleId: "bundle_stale",
      protocolVersion: SYNC_CHANGESET_PROTOCOL_VERSION,
      changesetSchemaVersion: SYNC_CHANGESET_SCHEMA_VERSION,
      sourceDeviceId: DEVICE_A,
      targetDeviceId: DEVICE_B,
      sinceWatermark: T0,
      generatedAt: T0,
      tables: [
        {
          tableName: "learning_goals",
          primaryKey: "id",
          strategy: "lww",
          timestampColumn: "updated_at",
          records: [],
          deleted: [
            {
              primaryKeyValue: "goal_local",
              originDeviceId: DEVICE_A,
              originTimestamp: T1,
              deletedAt: T1,
            },
          ],
        },
      ],
    };

    const result = await applyP2PSyncBundle(nodeB.client, staleBundle, DEVICE_B);
    expect(result.deletedCount).toBe(0);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_local'")).toBe(1);
  });

  it("D9: 相同数据重复同步产生零更新；经第三方设备中继也不会震荡", async () => {
    const nodeA = await createTriggeredNode("d9a", DEVICE_A);
    const nodeB = await createTriggeredNode("d9b", DEVICE_B);
    const nodeC = await createTriggeredNode("d9c", DEVICE_C);

    await nodeA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_idem", "幂等目标", "beginner", 10, "active", T2, T2],
    });

    const first = await relay(nodeA, nodeB, T0);
    expect(first.result.insertedCount).toBe(1);
    expect(first.result.updatedCount).toBe(0);

    // 第二次完全相同的同步：旧代码用 `bundle.sourceDeviceId > localDeviceId` 做 Tiebreak，
    // 时间戳相等时会把 A 的数据再“更新”一次（updatedCount = 1）。
    const second = await relay(nodeA, nodeB, T0);
    expect(second.result.updatedCount).toBe(0);
    expect(second.result.insertedCount).toBe(0);
    expect(second.result.skippedCount).toBe(1);

    // 第三次仍为零更新（无震荡）
    const third = await relay(nodeA, nodeB, T0);
    expect(third.result.updatedCount).toBe(0);

    // 经第三方设备 C 中继：C 的合并结果记录权威来源为 A，不允许用 C 的身份覆盖
    const toC = await relay(nodeA, nodeC, T0);
    expect(toC.result.insertedCount).toBe(1);
    const statesOnC = await readSyncRowStates(nodeC.client, "learning_goals");
    expect(statesOnC[0]?.originDeviceId).toBe(DEVICE_A);
    expect(statesOnC[0]?.originTimestamp).toBe(T2);

    // C → B：两边元组完全一致 → 零更新（旧代码可能因设备字典序产生“回弹”更新）
    const cToB = await relay(nodeC, nodeB, T0);
    expect(cToB.result.updatedCount).toBe(0);

    // B → A：A 仍是权威来源 → 零更新
    const bToA = await relay(nodeB, nodeA, T0);
    expect(bToA.result.updatedCount).toBe(0);
    expect(bToA.result.insertedCount).toBe(0);
  });

  it("D10: 合并按 chunkSize 分块执行，所有分块的数据都必须落库", async () => {
    const nodeA = await createNode("d10a", DEVICE_A);
    const nodeB = await createNode("d10b", DEVICE_B);

    for (let i = 0; i < 5; i++) {
      await nodeA.client.execute({
        sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [`goal_chunk_${i}`, `分块目标 ${i}`, "beginner", 10, "active", T1, T1],
      });
    }

    const bundle = await buildP2PSyncBundle(nodeA.client, {
      sourceDeviceId: DEVICE_A,
      targetDeviceId: DEVICE_B,
      sinceWatermark: T0,
    });
    const result = await applyP2PSyncBundle(nodeB.client, bundle, DEVICE_B, { chunkSize: 1 });
    expect(result.insertedCount).toBe(5);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals")).toBe(5);

    // 分块的原子性 trade-off（chunked, not whole-bundle atomic）：
    // 目标端缺表只会被显式记录为 schema 漂移，而不是静默丢数据；
    // 每个分块各自提交，因此部分成功的合并必须按批重放 —— 幂等写入保证重放安全。
    const nodeC = await createNode("d10c", DEVICE_C);
    await nodeC.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_partial", "部分成功", "beginner", 10, "active", T1, T1],
    });
    await nodeC.client.execute({
      sql: `INSERT INTO questions (id, prompt, answer_spec, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: ["q_drift", "漂移题", JSON.stringify({ type: "text" }), T1, T1],
    });
    const partialBundle = await buildP2PSyncBundle(nodeC.client, {
      sourceDeviceId: DEVICE_C,
      targetDeviceId: DEVICE_B,
      sinceWatermark: T0,
    });
    await nodeB.client.execute("DROP TABLE questions");
    const partial = await applyP2PSyncBundle(nodeB.client, partialBundle, DEVICE_B, { chunkSize: 1 });
    expect(partial.skippedTables).toContain("questions");
    expect(partial.insertedCount).toBe(1);
    expect(
      await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_partial'"),
    ).toBe(1);

    // 重放同一包：已落地的分块必须零写入（幂等），漂移表仍被显式上报
    const replay = await applyP2PSyncBundle(nodeB.client, partialBundle, DEVICE_B, { chunkSize: 1 });
    expect(replay.insertedCount).toBe(0);
    expect(replay.updatedCount).toBe(0);
    expect(replay.skippedTables).toContain("questions");
  });

  it("触发器看护：安装/卸载同步触发器是幂等的，且只为已安装的表盖章", async () => {
    const node = await createNode("trg", DEVICE_A);
    expect((await readSyncRowStates(node.client)).length).toBe(0);

    await installSyncTriggers(node.client, [DEFAULT_SYNC_TABLES[0]], DEVICE_A);
    await installSyncTriggers(node.client, [DEFAULT_SYNC_TABLES[0]], DEVICE_A);

    await node.client.execute({
      sql: `INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      args: ["ses_trg", "触发器会话", T1, T1],
    });
    await node.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_trg", "未装触发器", "beginner", 10, "active", T1, T1],
    });

    const states = await readSyncRowStates(node.client);
    expect(states).toHaveLength(1);
    expect(states[0]?.tableName).toBe("sessions");
    expect(states[0]?.originDeviceId).toBe(DEVICE_A);
    expect(states[0]?.originTimestamp).toBe(T1);

    const triggerNames = await node.client.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?",
      args: [triggerName("sessions", "ai")],
    });
    expect(triggerNames.rows).toHaveLength(1);
  });

  it("合并写入的权威元数据必须覆盖本地触发器盖章（真正的来源设备胜出）", async () => {
    const nodeA = await createTriggeredNode("meta_a", DEVICE_A);
    const nodeB = await createTriggeredNode("meta_b", DEVICE_B);

    await nodeA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_origin", "来源归属", "beginner", 10, "active", T2, T2],
    });

    // B 本地先存在同主键的行（触发器会盖 DEVICE_B 的章）
    await nodeB.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_origin", "B 的旧版本", "beginner", 5, "active", T1, T1],
    });
    const beforeStates = await readSyncRowStates(nodeB.client, "learning_goals");
    expect(beforeStates[0]?.originDeviceId).toBe(DEVICE_B);

    const { result } = await relay(nodeA, nodeB, T0);
    expect(result.updatedCount).toBe(1);

    // 触发器在写入瞬间盖的是 DEVICE_B，合并必须随后覆盖为 DEVICE_A + T2
    const afterStates = await readSyncRowStates(nodeB.client, "learning_goals");
    expect(afterStates[0]?.originDeviceId).toBe(DEVICE_A);
    expect(afterStates[0]?.originTimestamp).toBe(T2);
    expect(afterStates[0]?.deletedAt).toBeNull();
  });

  it("F1a: 白名单外的表整表拒绝，绝不写入也绝不执行对端伪造的删除", async () => {
    const nodeB = await createNode("f1a", DEVICE_B);
    await nodeB.client.execute({
      sql: `INSERT INTO audit_logs (id, event_type, actor_id, action, scope, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["audit_real", "sync", "local_user", "read", "global", T0],
    });

    const forged = craftedBundle([
      {
        tableName: "audit_logs",
        // audit_logs 既不在默认白名单里，也不在显式传入的空白名单里
        records: [
          {
            id: "audit_forged",
            event_type: "sync",
            actor_id: "attacker",
            action: "write",
            scope: "global",
            created_at: T1,
          },
        ],
        deleted: [
          {
            primaryKeyValue: "audit_real",
            originDeviceId: DEVICE_A,
            originTimestamp: T2,
            deletedAt: T2,
          },
        ],
      },
    ]);

    const result = await applyP2PSyncBundle(nodeB.client, forged, DEVICE_B, { tables: [] });

    // 旧代码只检查 tableExists 就对 audit_logs 执行了 INSERT 与 DELETE
    expect(result.rejectedTables.map((r) => r.tableName)).toEqual(["audit_logs"]);
    expect(result.rejectedTables[0]?.reason).toBe("not_in_whitelist");
    expect(result.insertedCount).toBe(0);
    expect(result.deletedCount).toBe(0);
    expect(result.tombstonesApplied).toBe(0);
    expect(result.partial).toBe(true);

    expect(await countRows(nodeB.client, "SELECT 1 FROM audit_logs WHERE id = 'audit_forged'")).toBe(0);
    expect(await countRows(nodeB.client, "SELECT 1 FROM audit_logs WHERE id = 'audit_real'")).toBe(1);
    expect(await readSyncRowStates(nodeB.client, "audit_logs")).toHaveLength(0);
  });

  it("F1b: 对端声明的主键/策略/时间列与本地定义不符时整表拒绝且零写入", async () => {
    const nodeB = await createNode("f1b", DEVICE_B);
    await nodeB.client.execute({
      sql: `INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      args: ["ses_keep", "保留会话", T0, T0],
    });
    await nodeB.client.execute({
      sql: `INSERT INTO turns (id, session_id, idempotency_key, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["turn_keep", "ses_keep", "idem_turn_keep", "Created", T0, T0],
    });

    const forged = craftedBundle([
      {
        // 对端声称 sessions 的主键是 title：旧代码会 `DELETE FROM sessions WHERE "title" = ?` 删掉真实会话
        tableName: "sessions",
        primaryKey: "title",
        records: [{ id: "ses_forged", title: "伪造会话", created_at: T1, updated_at: T1 }],
        deleted: [
          {
            primaryKeyValue: "保留会话",
            originDeviceId: DEVICE_A,
            originTimestamp: T2,
            deletedAt: T2,
          },
        ],
      },
      {
        // 对端声称 turns 是 append_only：本地定义是 lww，必须拒绝而不是按对端策略处理
        tableName: "turns",
        strategy: "append_only",
        records: [
          {
            id: "turn_forged",
            session_id: "ses_keep",
            idempotency_key: "idem_forged",
            status: "Completed",
            created_at: T1,
            updated_at: T1,
          },
        ],
      },
      {
        // 对端声称 learning_goals 的时间列是 created_at：本地解析为 updated_at，必须拒绝
        tableName: "learning_goals",
        timestampColumn: "created_at",
        records: [craftedGoalRow("goal_forged", "伪造目标", T1, DEVICE_A)],
      },
    ]);

    const result = await applyP2PSyncBundle(nodeB.client, forged, DEVICE_B);

    expect(result.rejectedTables.map((r) => [r.tableName, r.reason])).toEqual([
      ["sessions", "primary_key_mismatch"],
      ["turns", "strategy_mismatch"],
      ["learning_goals", "timestamp_column_mismatch"],
    ]);
    // 零写入：对端提供的列元数据一律不进入 SQL
    expect(result.insertedCount).toBe(0);
    expect(result.updatedCount).toBe(0);
    expect(result.deletedCount).toBe(0);
    expect(await countRows(nodeB.client, "SELECT 1 FROM sessions WHERE id = 'ses_keep'")).toBe(1);
    expect(await countRows(nodeB.client, "SELECT 1 FROM sessions WHERE id = 'ses_forged'")).toBe(0);
    expect(await countRows(nodeB.client, "SELECT 1 FROM turns WHERE id = 'turn_forged'")).toBe(0);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals")).toBe(0);
  });

  it("F1c: 包内表顺序被颠倒时接收端仍按本地白名单顺序合并（父表先行，不撞 FK）", async () => {
    const nodeA = await createNode("f1c_a", DEVICE_A);
    await nodeA.client.execute({
      sql: `INSERT INTO knowledge_items (id, concept, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      args: ["kn_order", "顺序看护", T1, T1],
    });
    await nodeA.client.execute({
      sql: `INSERT INTO questions (id, knowledge_id, prompt, answer_spec, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["q_order", "kn_order", "顺序问题", JSON.stringify({ type: "text" }), T1, T1],
    });

    const bundle = await buildP2PSyncBundle(nodeA.client, {
      sourceDeviceId: DEVICE_A,
      targetDeviceId: DEVICE_B,
      sinceWatermark: T0,
    });
    // 恶意/异常对端：故意把子表 questions 排在父表 knowledge_items 之前
    const reversed: P2PSyncBundle = { ...bundle, tables: [...bundle.tables].reverse() };
    expect(reversed.tables[0]?.tableName).toBe("questions");

    const nodeB = await createNode("f1c_b", DEVICE_B);
    // 旧代码按对端顺序落库 → questions 先插 → SQLITE_CONSTRAINT_FOREIGNKEY → 整批回滚 → 两行全丢
    const result = await applyP2PSyncBundle(nodeB.client, reversed, DEVICE_B);

    expect(result.rejectedTables).toEqual([]);
    expect(result.insertedCount).toBe(2);
    expect(await countRows(nodeB.client, "SELECT 1 FROM knowledge_items WHERE id = 'kn_order'")).toBe(1);
    expect(await countRows(nodeB.client, "SELECT 1 FROM questions WHERE id = 'q_order'")).toBe(1);
    // F5：接收端自己也按本地外键拓扑看护
    await expect(assertSyncTableOrder(nodeB.client, DEFAULT_SYNC_TABLES)).resolves.toBeUndefined();
  });

  it("F2a: 含未知列的行被逐行隔离，同批正常行照常落库（不再整批回滚）", async () => {
    const nodeA = await createNode("f2a_a", DEVICE_A);
    const nodeB = await createNode("f2a_b", DEVICE_B);

    for (const [id, topic] of [
      ["goal_ok_1", "正常一"],
      ["goal_drift", "漂移行"],
      ["goal_ok_2", "正常二"],
    ] as const) {
      await nodeA.client.execute({
        sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [id, topic, "beginner", 10, "active", T1, T1],
      });
    }

    const bundle = await buildP2PSyncBundle(nodeA.client, {
      sourceDeviceId: DEVICE_A,
      targetDeviceId: DEVICE_B,
      sinceWatermark: T0,
    });
    // 目标端 schema 漂移：对端那一行多携带了一个本地不存在的列
    const forged: P2PSyncBundle = {
      ...bundle,
      tables: bundle.tables.map((t) =>
        t.tableName !== "learning_goals"
          ? t
          : {
              ...t,
              records: t.records.map((row) =>
                row.id === "goal_drift" ? { ...row, legacy_note_column: "来自旧版本" } : row,
              ),
            },
      ),
    };

    const result = await applyP2PSyncBundle(nodeB.client, forged, DEVICE_B);

    // 旧代码：`table learning_goals has no column named legacy_note_column` 不是 UNIQUE 冲突，
    // 逃出逐行处理 → 整批（含两行正常数据）一起回滚。
    expect(result.schemaDriftRows).toBe(1);
    expect(result.constraintViolations).toBe(0);
    expect(result.uniqueConflicts).toBe(0);
    expect(result.insertedCount).toBe(2);
    expect(result.partial).toBe(true);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id LIKE 'goal_ok_%'")).toBe(2);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_drift'")).toBe(0);
  });

  it("F2b: 分批中途失败时显式抛出部分合并错误并携带已提交批次的报告", async () => {
    const nodeA = await createNode("f2b_a", DEVICE_A);
    const nodeB = await createNode("f2b_b", DEVICE_B);

    await nodeA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_partial_0", "第一批", "beginner", 10, "active", T1, T1],
    });
    await nodeA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_partial_1", "第二批", "beginner", 10, "active", T2, T2],
    });

    const bundle = await buildP2PSyncBundle(nodeA.client, {
      sourceDeviceId: DEVICE_A,
      targetDeviceId: DEVICE_B,
      sinceWatermark: T0,
    });
    expect(bundle.tables.flatMap((t) => t.records.map((r) => r.id))).toEqual([
      "goal_partial_0",
      "goal_partial_1",
    ]);

    // 注入基础设施级失败：第二个写事务抛错（模拟锁超时/IO 中断）
    const flaky = createFailOnNthTransactionClient(nodeB.client, 2);
    let caught: unknown;
    try {
      await applyP2PSyncBundle(flaky, bundle, DEVICE_B, { chunkSize: 1 });
    } catch (err) {
      caught = err;
    }

    // 旧代码直接抛裸错误且没有任何“部分应用”信号，调用方无从知道第一批已经落库
    expect(caught).toBeInstanceOf(SyncPartialMergeError);
    const partial = caught as SyncPartialMergeError;
    expect(partial.code).toBe("SYNC_PARTIAL_MERGE");
    expect(partial.partialResult.partial).toBe(true);
    expect(partial.partialResult.appliedChunks).toBe(1);
    expect(partial.partialResult.totalChunks).toBe(2);
    expect(partial.partialResult.insertedCount).toBe(1);
    // 已提交的第一批确实无法回滚：必须能被调用方观测到并据此重放
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_partial_0'")).toBe(1);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_partial_1'")).toBe(0);
  });

  it("F3: 写入 vs 墓碑一律按 (比较时钟, 来源设备) 元组裁决（四个方向）", async () => {
    async function writeVersusTombstone(options: {
      prefix: string;
      tombstone: { timestamp: string; deviceId: string };
      write: { timestamp: string; deviceId: string };
    }) {
      const local = await createNode(options.prefix, DEVICE_C);

      // 1) 本地先落一个指定权威元组的墓碑（由远端包写入权威元数据）
      const tombstoneResult = await applyP2PSyncBundle(
        local.client,
        craftedBundle(
          [
            {
              tableName: "learning_goals",
              deleted: [
                {
                  primaryKeyValue: "goal_lww",
                  originDeviceId: options.tombstone.deviceId,
                  originTimestamp: options.tombstone.timestamp,
                  deletedAt: options.tombstone.timestamp,
                },
              ],
            },
          ],
          options.tombstone.deviceId,
        ),
        DEVICE_C,
      );
      expect(tombstoneResult.deletedCount).toBe(0);
      expect(tombstoneResult.tombstonesApplied).toBe(1);

      // 2) 再投放一个指定权威元组的远端写入
      const result = await applyP2PSyncBundle(
        local.client,
        craftedBundle(
          [
            {
              tableName: "learning_goals",
              records: [
                craftedGoalRow(
                  "goal_lww",
                  `写入 ${options.write.timestamp}`,
                  options.write.timestamp,
                  options.write.deviceId,
                ),
              ],
            },
          ],
          options.write.deviceId,
        ),
        DEVICE_C,
      );
      const rows = await countRows(local.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_lww'");
      const states = await readSyncRowStates(local.client, "learning_goals");
      return { result, rows, states };
    }

    // (1) 更新的写入击败更旧的墓碑 → 复活
    const newer = await writeVersusTombstone({
      prefix: "f3_newer",
      tombstone: { timestamp: T2, deviceId: DEVICE_A },
      write: { timestamp: T3, deviceId: DEVICE_A },
    });
    expect(newer.rows).toBe(1);
    expect(newer.result.updatedCount).toBe(1);
    expect(newer.states[0]?.deletedAt).toBeNull();

    // (2) 更旧的写入输给更新的墓碑 → 必须保持删除（旧代码无条件复活，行会回来）
    const older = await writeVersusTombstone({
      prefix: "f3_older",
      tombstone: { timestamp: T3, deviceId: DEVICE_A },
      write: { timestamp: T2, deviceId: DEVICE_A },
    });
    expect(older.rows).toBe(0);
    expect(older.result.insertedCount).toBe(0);
    expect(older.result.updatedCount).toBe(0);
    expect(older.result.skippedCount).toBe(1);
    expect(older.states[0]?.deletedAt).toBe(T3);

    // (3) 时间戳相同、写入设备 ID 更大 → 写入胜出（确定性 tiebreak）
    const tieWinner = await writeVersusTombstone({
      prefix: "f3_tie_win",
      tombstone: { timestamp: T2, deviceId: DEVICE_A },
      write: { timestamp: T2, deviceId: DEVICE_B },
    });
    expect(tieWinner.rows).toBe(1);
    expect(tieWinner.result.updatedCount).toBe(1);
    expect(tieWinner.result.conflictsResolvedCount).toBe(1);

    // (4) 时间戳相同、写入设备 ID 更小 → 墓碑胜出，必须保持删除
    const tieLoser = await writeVersusTombstone({
      prefix: "f3_tie_lose",
      tombstone: { timestamp: T2, deviceId: DEVICE_B },
      write: { timestamp: T2, deviceId: DEVICE_A },
    });
    expect(tieLoser.rows).toBe(0);
    expect(tieLoser.result.skippedCount).toBe(1);
    expect(tieLoser.states[0]?.deletedAt).toBe(T2);
  });

  it("F4: 墓碑分支同样使用来源设备 ID 决胜（与行路径同一元组规则）", async () => {
    // 本地行由 DEVICE_A 写入（触发器盖章 origin_device_id = DEVICE_A，时间戳 T2）
    const localA = await createTriggeredNode("f4_a", DEVICE_A);
    await localA.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_tie", "本地 A 写入", "beginner", 10, "active", T2, T2],
    });

    // 时间戳相同的远端墓碑，来源设备 DEVICE_B > DEVICE_A → 必须删掉（旧代码只比时间戳：T2 <= T2 → 跳过）
    const wins = await applyP2PSyncBundle(
      localA.client,
      craftedBundle(
        [
          {
            tableName: "learning_goals",
            deleted: [
              {
                primaryKeyValue: "goal_tie",
                originDeviceId: DEVICE_B,
                originTimestamp: T2,
                deletedAt: T2,
              },
            ],
          },
        ],
        DEVICE_B,
      ),
      DEVICE_A,
    );
    expect(wins.deletedCount).toBe(1);
    expect(wins.conflictsResolvedCount).toBe(1);
    expect(await countRows(localA.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_tie'")).toBe(0);

    // 反向：本地行由 DEVICE_B 写入，时间戳相同的远端墓碑来源设备 DEVICE_A < DEVICE_B → 墓碑落败
    const localB = await createTriggeredNode("f4_b", DEVICE_B);
    await localB.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_tie", "本地 B 写入", "beginner", 10, "active", T2, T2],
    });
    const loses = await applyP2PSyncBundle(
      localB.client,
      craftedBundle(
        [
          {
            tableName: "learning_goals",
            deleted: [
              {
                primaryKeyValue: "goal_tie",
                originDeviceId: DEVICE_A,
                originTimestamp: T2,
                deletedAt: T2,
              },
            ],
          },
        ],
        DEVICE_A,
      ),
      DEVICE_B,
    );
    expect(loses.deletedCount).toBe(0);
    expect(loses.skippedCount).toBe(1);
    expect(await countRows(localB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_tie'")).toBe(1);
  });

  it("F6a: UNIQUE 冲突只计入 uniqueConflicts，不再重复计入 skippedCount", async () => {
    const nodeB = await createNode("f6a", DEVICE_B);
    await nodeB.client.execute({
      sql: `INSERT INTO questions (id, prompt, answer_spec, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: ["q_dup", "重复题", JSON.stringify({ type: "text" }), T0, T0],
    });
    await nodeB.client.execute({
      sql: `INSERT INTO mistake_dispositions (id, question_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)`,
      args: ["mis_local", "q_dup", "dismissed", T2, T2],
    });

    // 同一道题的另一个处置记录（question_id UNIQUE 冲突）：包内只有这一行
    const forged = craftedBundle([
      {
        tableName: "mistake_dispositions",
        records: [
          {
            id: "mis_remote",
            question_id: "q_dup",
            status: "active",
            created_at: T1,
            updated_at: T1,
          },
        ],
      },
    ]);

    const result = await applyP2PSyncBundle(nodeB.client, forged, DEVICE_B);

    // 旧代码：uniqueConflicts 与 skippedCount 同时自增 → 调用方看到 1 个冲突却有 2 个“跳过”
    expect(result.uniqueConflicts).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.insertedCount).toBe(0);
    // 冲突隔离是预期裁决结果，不算“部分应用”
    expect(result.partial).toBe(false);
    const onB = await nodeB.client.execute(
      "SELECT * FROM mistake_dispositions WHERE question_id = 'q_dup'",
    );
    expect(onB.rows).toHaveLength(1);
    expect(onB.rows[0]?.id).toBe("mis_local");
  });

  it("F6b: 本地本就不存在的行只登记墓碑，不计入 deletedCount，且能挡住更旧的写入", async () => {
    const nodeB = await createNode("f6b", DEVICE_B);

    const result = await applyP2PSyncBundle(
      nodeB.client,
      craftedBundle([
        {
          tableName: "learning_goals",
          deleted: [
            {
              primaryKeyValue: "goal_ghost",
              originDeviceId: DEVICE_A,
              originTimestamp: T2,
              deletedAt: T2,
            },
          ],
        },
      ]),
      DEVICE_B,
    );

    // 旧代码：无行可删也把 deletedCount 记成 1，调用方无法区分“真删了行”与“只登记墓碑”
    expect(result.deletedCount).toBe(0);
    expect(result.tombstonesApplied).toBe(1);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_ghost'")).toBe(0);

    // 墓碑必须真实落地：否则更旧的远端写入会把这个“幽灵行”复活
    const states = await readSyncRowStates(nodeB.client, "learning_goals");
    expect(states).toHaveLength(1);
    expect(states[0]?.deletedAt).toBe(T2);
    expect(states[0]?.originDeviceId).toBe(DEVICE_A);

    const stale = await applyP2PSyncBundle(
      nodeB.client,
      craftedBundle([
        {
          tableName: "learning_goals",
          records: [craftedGoalRow("goal_ghost", "幽灵复活", T1, DEVICE_A)],
        },
      ]),
      DEVICE_B,
    );
    expect(stale.insertedCount).toBe(0);
    expect(await countRows(nodeB.client, "SELECT 1 FROM learning_goals WHERE id = 'goal_ghost'")).toBe(0);
  });

  it("F7（文档实测证据）: 外键级联删除会被子表的 AFTER DELETE 触发器记为墓碑", async () => {
    const node = await createTriggeredNode("f7", DEVICE_A);
    await node.client.execute({
      sql: `INSERT INTO sessions (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      args: ["ses_cascade", "级联会话", T1, T1],
    });
    await node.client.execute({
      sql: `INSERT INTO turns (id, session_id, idempotency_key, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["turn_cascade", "ses_cascade", "idem_cascade", "Created", T1, T1],
    });

    await node.client.execute({ sql: `DELETE FROM sessions WHERE id = ?`, args: ["ses_cascade"] });

    // 实测行为（exploration 文档 §3.2.4 据此改写）：ON DELETE CASCADE 会触发 turns 的
    // AFTER DELETE 触发器，因此级联删除**会**留下墓碑——不是“父行删除不会自动删子行”。
    expect(await countRows(node.client, "SELECT 1 FROM turns WHERE id = 'turn_cascade'")).toBe(0);
    const sessionStates = await readSyncRowStates(node.client, "sessions");
    const turnStates = await readSyncRowStates(node.client, "turns");
    expect(sessionStates[0]?.deletedAt).not.toBeNull();
    expect(turnStates[0]?.deletedAt).not.toBeNull();
    // 注意：级联顺序与“未装触发器子表”的覆盖不在本模块承诺范围内。
  });

  it("F6c: 提取时设备 ID 一律参数绑定（含引号的 deviceId 不再破坏 SQL）", async () => {
    const node = await createNode("f6c", DEVICE_A);
    await node.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_quote", "引号看护", "beginner", 10, "active", T1, T1],
    });

    const goalDef = DEFAULT_SYNC_TABLES.find((t) => t.tableName === "learning_goals");
    if (!goalDef) throw new Error("测试前置失败：白名单缺少 learning_goals");

    const weirdDeviceId = "dev_o'brien; DROP TABLE learning_goals; --";
    // 旧代码把设备 ID 直接拼进 SQL：单引号会破坏语句（语法错误/注入面）
    const changeset = await extractTableChangeset(node.client, goalDef, {
      deviceId: weirdDeviceId,
      sinceWatermark: T0,
    });

    expect(changeset.records).toHaveLength(1);
    expect(changeset.records[0]?.__aervox_origin_device).toBe(weirdDeviceId);
    expect(await countRows(node.client, "SELECT 1 FROM learning_goals")).toBe(1);
  });
});
