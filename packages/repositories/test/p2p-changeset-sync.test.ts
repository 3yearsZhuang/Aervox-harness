/**
 * Aervox｜思隅 @aervox/repositories — 纯本地多端 P2P 加密同步探索测试（ITER-028）
 *
 * 验证目标：
 * 1. 局域网同网设备发现描述符与 6 位 SAS 短身份验证码零信任配对握手；
 * 2. 端到端 AES-256-GCM 会话密钥派生与密文传输；
 * 3. 基于 SQLite Session Extension 思想的增量 Changeset 提取；
 * 4. 学习事实（不可变 Append-Only）与学习进度/错题本（LWW 状态覆盖）冲突自愈；
 * 5. 桌面端（Electron）与移动端（Capacitor）双向增量同步收敛。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  createDatabase,
  initDatabaseSchema,
  createDeviceDescriptor,
  generateDeviceIdentity,
  encryptSyncPayload,
  decryptSyncPayload,
  buildP2PSyncBundle,
  applyP2PSyncBundle,
  executeP2PBidirectionalSync,
  DEFAULT_SYNC_TABLES,
  type AervoxDatabase,
} from "../src/index.js";
import { establishVerifiedPairing } from "./helpers/p2p-session.js";
import type { Client } from "@libsql/client";

describe("ITER-028: 纯本地多端点对点加密同步与 SQLite Changeset 对齐测试", () => {
  let tempDbDesktop: string;
  let tempDbMobile: string;
  let desktopConn: { db: AervoxDatabase; client: Client };
  let mobileConn: { db: AervoxDatabase; client: Client };

  beforeEach(async () => {
    tempDbDesktop = path.join(
      os.tmpdir(),
      `aervox_p2p_desktop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`,
    );
    tempDbMobile = path.join(
      os.tmpdir(),
      `aervox_p2p_mobile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.db`,
    );

    desktopConn = await createDatabase({ url: `file:${tempDbDesktop}` });
    mobileConn = await createDatabase({ url: `file:${tempDbMobile}` });

    await initDatabaseSchema(desktopConn.client);
    await initDatabaseSchema(mobileConn.client);
  });

  afterEach(async () => {
    try {
      desktopConn.client.close();
      mobileConn.client.close();
      for (const f of [tempDbDesktop, tempDbMobile]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
        if (fs.existsSync(`${f}-wal`)) fs.unlinkSync(`${f}-wal`);
        if (fs.existsSync(`${f}-shm`)) fs.unlinkSync(`${f}-shm`);
      }
    } catch {
      // ignore
    }
  });

  it("局域网发现描述符与 6 位 SAS 安全配对握手（端到端 AES-256-GCM 会话建立）", () => {
    // 1. 双端生成 Ed25519 永久设备身份与广播描述符
    const desktopIdentity = generateDeviceIdentity("MacBook Pro (桌面端)", "desktop");
    const mobileIdentity = generateDeviceIdentity("iPhone 16 Pro (移动端)", "mobile");

    expect(desktopIdentity.deviceId).toMatch(/^desktop_/);
    expect(mobileIdentity.deviceId).toMatch(/^mobile_/);
    expect(desktopIdentity.publicKey).toContain("BEGIN PUBLIC KEY");

    const desktopDescriptor = createDeviceDescriptor(desktopIdentity, {
      host: "192.168.1.100",
      port: 48201,
    });
    expect(desktopDescriptor.protocolVersion).toBe("v1");
    expect(desktopDescriptor.fingerprint).toHaveLength(12);

    // 2. 走承诺-揭示安全配对路径，并在用户确认 SAS 后启用会话
    const pairing = establishVerifiedPairing({
      initiatorName: "MacBook Pro (桌面端)",
      responderName: "iPhone 16 Pro (移动端)",
      initiatorPrefix: "desktop",
      responderPrefix: "mobile",
    });
    const { invitation } = pairing;
    expect(invitation.initiatorDevice.deviceId).toBe(pairing.initiatorIdentity.deviceId);
    expect(invitation.nonce).toBeDefined();
    // 承诺-揭示路径的消息 1 绝不携带临时公钥（否则承诺形同虚设）
    expect(invitation.ephemeralPublicKey).toBeUndefined();
    expect(invitation.commitment).toBeDefined();
    expect(pairing.sasCode).toMatch(/^\d{6}$/); // 6 位数字验证码，供用户界面比对核验

    const desktopSession = pairing.initiatorSession;
    const mobileSession = pairing.responderSession;

    // 5. 验证端到端 AES-256-GCM 加密与解密通道
    const samplePayload = {
      action: "sync_request",
      watermark: "2026-09-29T12:00:00.000Z",
      clientVersion: "0.4.2",
    };

    const encrypted = encryptSyncPayload(desktopSession, samplePayload);
    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.authTag).toBeDefined();

    // 响应端解密必须得到完全一致的对象（密钥不匹配会抛错或解密出脏数据）
    const decrypted = decryptSyncPayload<typeof samplePayload>(mobileSession, encrypted);
    expect(decrypted).toEqual(samplePayload);

    // 反向通道同样成立，证明双方派生出的是同一把可用会话密钥
    const reverseEncrypted = encryptSyncPayload(mobileSession, samplePayload);
    const reverseDecrypted = decryptSyncPayload<typeof samplePayload>(desktopSession, reverseEncrypted);
    expect(reverseDecrypted).toEqual(samplePayload);
  });

  it("单向 SQLite 增量 Changeset 提取与应用（支持不可变事实与状态覆盖）", async () => {
    const desktopId = "desktop_01";
    const mobileId = "mobile_01";

    // 1. 在桌面端写入学习目标、题目、作答事实和错题处置记录
    await desktopConn.client.execute({
      sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, updated_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["goal_algebra", "线性代数", "intermediate", 60, "active", "2026-09-29T10:00:00.000Z", "2026-09-29T10:00:00.000Z"],
    });

    await desktopConn.client.execute({
      sql: `INSERT INTO questions (id, prompt, answer_spec, status, updated_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["q_eigen", "什么是特征向量？", JSON.stringify({ type: "text" }), "active", "2026-09-29T10:00:00.000Z", "2026-09-29T10:00:00.000Z"],
    });

    await desktopConn.client.execute({
      sql: `INSERT INTO question_attempts (id, session_id, question_id, answer, judgement, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["att_01", "ses_math", "q_eigen", "满足 Av = λv 的非零向量", "correct", "2026-09-29T10:05:00.000Z"],
    });

    await desktopConn.client.execute({
      sql: `INSERT INTO mistake_dispositions (id, question_id, status, reason, note, updated_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["mis_01", "q_eigen", "active", "概念不清晰", "容易遗漏非零条件", "2026-09-29T10:06:00.000Z", "2026-09-29T10:06:00.000Z"],
    });

    // 2. 从桌面端构建 Changeset 同步包
    const bundle = await buildP2PSyncBundle(desktopConn.client, {
      sourceDeviceId: desktopId,
      targetDeviceId: mobileId,
    });

    expect(bundle.tables.length).toBeGreaterThanOrEqual(4);
    const goalTable = bundle.tables.find((t) => t.tableName === "learning_goals");
    expect(goalTable?.records).toHaveLength(1);
    expect(goalTable?.records[0]?.topic).toBe("线性代数");

    // 3. 应用至移动端 SQLite 数据库
    const result = await applyP2PSyncBundle(mobileConn.client, bundle, mobileId);
    expect(result.insertedCount).toBe(4);

    // 4. 验证移动端数据落库正确性
    const mobileGoalRes = await mobileConn.client.execute({
      sql: "SELECT * FROM learning_goals WHERE id = ?",
      args: ["goal_algebra"],
    });
    expect(mobileGoalRes.rows).toHaveLength(1);
    expect(mobileGoalRes.rows[0]?.topic).toBe("线性代数");

    const mobileAttemptRes = await mobileConn.client.execute({
      sql: "SELECT * FROM question_attempts WHERE id = ?",
      args: ["att_01"],
    });
    expect(mobileAttemptRes.rows).toHaveLength(1);
    expect(mobileAttemptRes.rows[0]?.answer).toBe("满足 Av = λv 的非零向量");

    const mobileMistakeRes = await mobileConn.client.execute({
      sql: "SELECT * FROM mistake_dispositions WHERE id = ?",
      args: ["mis_01"],
    });
    expect(mobileMistakeRes.rows).toHaveLength(1);
    expect(mobileMistakeRes.rows[0]?.note).toBe("容易遗漏非零条件");
  });

  it("桌面端与移动端双向离线变更增量同步与 LWW 冲突自愈收敛", async () => {
    // 配对并建立加密会话（承诺-揭示路径 + 用户 SAS 确认）
    const pairing = establishVerifiedPairing({
      initiatorName: "MacBook Pro",
      responderName: "iPhone 16 Pro",
    });
    const desktopSession = pairing.initiatorSession;
    const mobileSession = pairing.responderSession;

    // 初始基线：两端拥有相同题目与目标
    const baselineTime = "2026-09-29T08:00:00.000Z";
    for (const client of [desktopConn.client, mobileConn.client]) {
      await client.execute({
        sql: `INSERT INTO questions (id, prompt, answer_spec, status, updated_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args: ["q_matrix", "矩阵秩的定义", JSON.stringify({ type: "text" }), "active", baselineTime, baselineTime],
      });
      await client.execute({
        sql: `INSERT INTO learning_goals (id, topic, level, available_minutes, status, updated_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: ["goal_matrix", "矩阵论", "beginner", 30, "active", baselineTime, baselineTime],
      });
      await client.execute({
        sql: `INSERT INTO mistake_dispositions (id, question_id, status, reason, note, updated_at, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: ["mis_matrix", "q_matrix", "active", "初学标记", "待温习", baselineTime, baselineTime],
      });
    }

    // 场景模拟：双端离线产生并发修改
    // 1. 桌面端在 09:00 修改错题状态为 dismissed 并记录笔记
    await desktopConn.client.execute({
      sql: `UPDATE mistake_dispositions
            SET status = ?, note = ?, updated_at = ?
            WHERE id = ?`,
      args: ["dismissed", "桌面端已攻克矩阵初等行变换求秩法", "2026-09-29T09:00:00.000Z", "mis_matrix"],
    });

    // 2. 桌面端在 09:05 更新学习目标可用时长为 45 分钟
    await desktopConn.client.execute({
      sql: `UPDATE learning_goals
            SET available_minutes = ?, updated_at = ?
            WHERE id = ?`,
      args: [45, "2026-09-29T09:05:00.000Z", "goal_matrix"],
    });

    // 3. 移动端在 09:30（更晚的时间戳）更新学习目标为 completed，且可用时长调整为 60 分钟
    await mobileConn.client.execute({
      sql: `UPDATE learning_goals
            SET status = ?, available_minutes = ?, updated_at = ?
            WHERE id = ?`,
      args: ["completed", 60, "2026-09-29T09:30:00.000Z", "goal_matrix"],
    });

    // 4. 移动端在 09:35 产生一条新的移动端答题记录（不可变事实）
    await mobileConn.client.execute({
      sql: `INSERT INTO question_attempts (id, session_id, question_id, answer, judgement, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["att_mobile_01", "ses_mobile", "q_matrix", "极大线性无关组向量数", "correct", "2026-09-29T09:35:00.000Z"],
    });

    // 执行双向 P2P 加密增量对齐（两端各自持有方向感知会话）
    const syncRes = await executeP2PBidirectionalSync({
      nodeA: { client: desktopConn.client, deviceId: pairing.initiatorIdentity.deviceId },
      nodeB: { client: mobileConn.client, deviceId: pairing.responderIdentity.deviceId },
      sessions: { nodeA: desktopSession, nodeB: mobileSession },
      watermarks: {
        aSince: baselineTime,
        bSince: baselineTime,
      },
    });

    expect(syncRes.aToBResult).toBeDefined();
    expect(syncRes.bToAResult).toBeDefined();

    // 验证收敛状态：
    // A. 学习目标：移动端 09:30 > 桌面端 09:05，LWW 胜出，两端均为 completed + 60 分钟
    const desktopGoal = (await desktopConn.client.execute("SELECT * FROM learning_goals WHERE id = 'goal_matrix'")).rows[0];
    const mobileGoal = (await mobileConn.client.execute("SELECT * FROM learning_goals WHERE id = 'goal_matrix'")).rows[0];

    expect(desktopGoal?.status).toBe("completed");
    expect(desktopGoal?.available_minutes).toBe(60);
    expect(mobileGoal?.status).toBe("completed");
    expect(mobileGoal?.available_minutes).toBe(60);

    // B. 错题处置：桌面端 09:00 更新，移动端未修改（仍为 08:00 基线），桌面端胜出，两端均为 dismissed
    const desktopMistake = (await desktopConn.client.execute("SELECT * FROM mistake_dispositions WHERE id = 'mis_matrix'")).rows[0];
    const mobileMistake = (await mobileConn.client.execute("SELECT * FROM mistake_dispositions WHERE id = 'mis_matrix'")).rows[0];

    expect(desktopMistake?.status).toBe("dismissed");
    expect(desktopMistake?.note).toBe("桌面端已攻克矩阵初等行变换求秩法");
    expect(mobileMistake?.status).toBe("dismissed");
    expect(mobileMistake?.note).toBe("桌面端已攻克矩阵初等行变换求秩法");

    // C. 答题历史（不可变事实）：双端完整保留，移动端答题同步至桌面端，零数据丢失
    const desktopAttempts = await desktopConn.client.execute("SELECT * FROM question_attempts WHERE id = 'att_mobile_01'");
    const mobileAttempts = await mobileConn.client.execute("SELECT * FROM question_attempts WHERE id = 'att_mobile_01'");

    expect(desktopAttempts.rows).toHaveLength(1);
    expect(mobileAttempts.rows).toHaveLength(1);
    expect(desktopAttempts.rows[0]?.answer).toBe("极大线性无关组向量数");
  });
});
