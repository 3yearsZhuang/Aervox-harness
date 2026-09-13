/**
 * CR-033 E1 SituationModel 投影快照 Port 测试。
 *
 * 覆盖：save/getLatest/watermark 过滤/rebuild 标记/删除传播/回填幂等。
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Client } from "@libsql/client";
import {
  createInMemoryDatabase,
  createProactiveVaultCipher,
  initDatabaseSchema,
  SqliteProactiveSituationRepository,
  type AervoxDatabase,
} from "../src/index.js";

const tenant = { workspaceId: "ws_sit", subjectUserId: "usr_sit" } as const;

describe("proactive situation snapshot repository (CR-033 E1)", () => {
  let db: AervoxDatabase;
  let client: Client;
  let repo: SqliteProactiveSituationRepository;

  beforeEach(async () => {
    const database = await createInMemoryDatabase();
    db = database.db;
    client = database.client;
    await initDatabaseSchema(client);
    repo = new SqliteProactiveSituationRepository(
      db,
      createProactiveVaultCipher(new Uint8Array(32).fill(7), "situation-test"),
    );
  });

  const input = (overrides: Partial<Parameters<typeof repo.saveSnapshot>[1]> = {}) => ({
    id: "snap_1",
    revisionId: "profile_1",
    schemaVersion: "situation_model_v1",
    snapshot: { version: "situation_model_v1", presence: { state: "active", since: "2026-09-14T04:00:00.000Z" } },
    checksum: "checksum-1",
    origin: "incremental" as const,
    lastEventSequence: 1,
    sourceEpochs: { "device.clipboard": "epoch-1" },
    rebuiltAt: null,
    localOnly: true,
    ...overrides,
  });

  it("写投影快照并按 watermark 读回", async () => {
    const saved = await repo.saveSnapshot(tenant, input());
    expect(saved.snapshot).toMatchObject({ version: "situation_model_v1" });
    expect(saved.origin).toBe("incremental");
    expect(saved.localOnly).toBe(true);

    const latest = await repo.getLatestSnapshot(tenant, "profile_1");
    expect(latest?.id).toBe("snap_1");
    expect(latest?.lastEventSequence).toBe(1);
  });

  it("deny watermark 过滤：低于水印的快照不可读", async () => {
    await repo.saveSnapshot(tenant, input());
    const denied = await repo.getLatestSnapshot(tenant, "profile_1", 99);
    expect(denied).toBeNull();
  });

  it("local_only 之外拒绝：false 的快照不可作为最新读取", async () => {
    await repo.saveSnapshot(tenant, input({ localOnly: false }));
    const latest = await repo.getLatestSnapshot(tenant, "profile_1");
    expect(latest).toBeNull();
  });

  it("同 (revisionId, lastEventSequence) 幂等：不重复插入", async () => {
    await repo.saveSnapshot(tenant, input());
    const second = await repo.saveSnapshot(tenant, input({ checksum: "checksum-2" }));
    expect(second.lastEventSequence).toBe(1);
    const latest = await repo.getLatestSnapshot(tenant, "profile_1");
    expect(latest?.checksum).toBe("checksum-2");
  });

  it("markRebuild 仅提升 watermark（不静默合并）", async () => {
    await repo.saveSnapshot(tenant, input({ lastEventSequence: 5 }));
    await repo.markRebuild(tenant, "profile_1", 10);
    const latest = await repo.getLatestSnapshot(tenant, "profile_1");
    expect(latest?.lastEventSequence).toBe(10);
    expect(latest?.origin).toBe("rebuild");
  });

  it("deleteByRevision 撤权/删除传播：投影随删除零召回", async () => {
    await repo.saveSnapshot(tenant, input());
    const n = await repo.deleteByRevision(tenant, "profile_1");
    expect(n).toBe(1);
    expect(await repo.getLatestSnapshot(tenant, "profile_1")).toBeNull();
  });

  it("revisionId 隔离：不同 revision 的快照不可交叉读取", async () => {
    await repo.saveSnapshot(tenant, input({ revisionId: "profile_1" }));
    await repo.saveSnapshot(tenant, input({ id: "snap_other", revisionId: "profile_2" }));
    const latest = await repo.getLatestSnapshot(tenant, "profile_2");
    expect(latest?.id).toBe("snap_other");
    expect(await repo.getLatestSnapshot(tenant, "profile_1")).not.toBeNull();
  });
});