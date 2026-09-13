/**
 * 激活租约幂等回归：宿主重复 authorize（重试/向导二次提交）会携带同一
 * (device_id, epoch)，createActivationLease 必须复用既有行而非撞唯一约束。
 */
import { describe, expect, it } from "vitest";
import { FULL_PROFILE_SOURCE_MANIFEST } from "@aervox/schema";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteProactiveProfileRepository,
  type LocalContext,
} from "@aervox/repositories";

const tenant: LocalContext = {workspaceId: "local", subjectUserId: "local"};

describe("proactive activation lease idempotency", () => {
  it("reactivates the same row when authorize retries with the same device and epoch", async () => {
    const {db, client, cleanup} = await createInMemoryDatabase();
    await initDatabaseSchema(client);
    const repository = new SqliteProactiveProfileRepository(db);
    try {
      const {revision} = await repository.confirmProfile(tenant, {
        id: "profile_lease_idem",
        deviceId: "device-idem",
        actorId: "usr_idem",
        sources: FULL_PROFILE_SOURCE_MANIFEST.map((source, index) => ({
          id: `source_lease_idem_${index}`,
          sourceKey: source.sourceKey,
          purpose: source.purpose,
          scope: "all",
          osCapability: source.osCapability,
          state: "granted" as const,
          mandatory: true,
        })),
      });

      const first = await repository.createActivationLease(tenant, {
        id: "lease_idem_1",
        revisionId: revision.id,
        deviceId: "device-idem",
        epoch: "epoch-idem",
        localReady: true,
        fullAccessSnapshot: true,
        actorId: "usr_idem",
      });
      expect(first.status).toBe("active");

      // 结束后同 epoch 重入（模拟宿主重启后向导二次提交）
      await repository.endActivationLease(tenant, first.id, "superseded_test", "usr_idem");
      const second = await repository.createActivationLease(tenant, {
        id: "lease_idem_2",
        revisionId: revision.id,
        deviceId: "device-idem",
        epoch: "epoch-idem",
        localReady: true,
        fullAccessSnapshot: true,
        actorId: "usr_idem",
      });
      expect(second.status).toBe("active");
      expect(second.id).toBe(first.id);

      // active 状态下重复创建同样复用（不重复发租约）
      const third = await repository.createActivationLease(tenant, {
        id: "lease_idem_3",
        revisionId: revision.id,
        deviceId: "device-idem",
        epoch: "epoch-idem",
        localReady: true,
        fullAccessSnapshot: true,
        actorId: "usr_idem",
      });
      expect(third.id).toBe(first.id);
      expect(third.status).toBe("active");
    } finally {
      await cleanup();
    }
  });
});
