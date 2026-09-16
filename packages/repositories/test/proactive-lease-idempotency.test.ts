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

const ctx: LocalContext = {workspaceId: "local", subjectUserId: "local"};

describe("proactive activation lease idempotency", () => {
  it("reactivates the same row when authorize retries with the same device and epoch", async () => {
    const {db, client, cleanup} = await createInMemoryDatabase();
    await initDatabaseSchema(client);
    const repository = new SqliteProactiveProfileRepository(db);
    try {
      const {revision} = await repository.confirmProfile(ctx, {
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

      const first = await repository.createActivationLease(ctx, {
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
      await repository.endActivationLease(ctx, first.id, "superseded_test", "usr_idem");
      const second = await repository.createActivationLease(ctx, {
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
      const third = await repository.createActivationLease(ctx, {
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

      // 并发双发（桌面 authorize 竞态）：两请求同时通过前置检查时，后者捕获
      // UNIQUE 冲突并复用前者租约，双双成功且收敛到同一行。
      const [left, right] = await Promise.all([
        repository.createActivationLease(ctx, {
          id: "lease_idem_race_a",
          revisionId: revision.id,
          deviceId: "device-idem",
          epoch: "epoch-idem",
          localReady: true,
          fullAccessSnapshot: true,
          actorId: "usr_idem",
        }),
        repository.createActivationLease(ctx, {
          id: "lease_idem_race_b",
          revisionId: revision.id,
          deviceId: "device-idem",
          epoch: "epoch-idem",
          localReady: true,
          fullAccessSnapshot: true,
          actorId: "usr_idem",
        }),
      ]);
      expect(left.id).toBe(right.id);
      expect(left.status).toBe("active");
      expect(right.status).toBe("active");
    } finally {
      await cleanup();
    }
  });
});
