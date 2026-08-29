import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createInMemoryDatabase,
  createProactiveVaultCipher,
  initDatabaseSchema,
  SqliteProactiveProfileRepository,
  type AervoxDatabase,
} from "@aervox/database";
import { ProactiveActionAuthorizer } from "../src/modules/proactive/action-authorizer.js";

const tenant = { workspaceId: "ws_action", subjectUserId: "usr_action" } as const;

describe("CAP-033 FullProfileActionGrant runtime gate", () => {
  let db: AervoxDatabase;
  let cleanup: () => Promise<void>;
  let repo: SqliteProactiveProfileRepository;

  beforeEach(async () => {
    const database = await createInMemoryDatabase();
    db = database.db;
    cleanup = database.cleanup;
    await initDatabaseSchema(database.client);
    repo = new SqliteProactiveProfileRepository(
      db,
      createProactiveVaultCipher(new Uint8Array(32).fill(4), "action-test"),
    );
    const sources = [
      "action.local",
      "action.external",
      "action.privileged",
      "action.irreversible",
    ].map((sourceKey, index) => ({
      id: `source_${index + 1}`,
      sourceKey,
      purpose: "action.authorize",
      scope: "all",
      osCapability: sourceKey,
      state: "granted" as const,
      mandatory: true,
      grantVersion: 3,
    }));
    const { revision } = await repo.confirmProfile(tenant, {
      id: "profile_action_1",
      deviceId: "device_action_1",
      actorId: tenant.subjectUserId,
      sources,
    });
    await repo.createActivationLease(tenant, {
      id: "lease_action_1",
      revisionId: revision.id,
      deviceId: revision.deviceId,
      epoch: "epoch_action_1",
      localReady: true,
      fullAccessSnapshot: true,
      actorId: tenant.subjectUserId,
    });
  });

  afterEach(async () => cleanup());

  it("authorizes and audits external privileged irreversible actions with the exact grant revision", async () => {
    const result = await new ProactiveActionAuthorizer(repo).authorize(tenant, {
      turnId: "turn_1",
      attemptId: "attempt_1",
      invocationId: "attempt_1:1:1",
      toolId: "system_reset",
      toolName: "system_reset",
      category: "external",
      safetyLevel: "privileged",
      requiredPermissions: ["action.irreversible"],
      arguments: { target: "device_2" },
    });
    expect(result.authorized).toBe(true);
    if (!result.authorized) return;
    expect(result.scopes).toEqual([
      "action.local",
      "action.external",
      "action.privileged",
      "action.irreversible",
    ]);
    expect(result.action).toMatchObject({
      state: "approved",
      external: true,
      reversible: false,
      actionGrantRevision:
        "action.local@3+action.external@3+action.privileged@3+action.irreversible@3",
    });
    expect(result.decidedBy).toContain("permission:proactive_action:profile_action_1");
  });

  it("fails closed immediately after an action scope is revoked", async () => {
    const privileged = (await repo.listSourceGrants(tenant)).find(
      (source) => source.sourceKey === "action.privileged",
    )!;
    await repo.updateSourceGrant(tenant, privileged.id, {
      state: "revoked",
      actorId: tenant.subjectUserId,
    });
    const result = await new ProactiveActionAuthorizer(repo).authorize(tenant, {
      turnId: "turn_2",
      attemptId: "attempt_2",
      invocationId: "attempt_2:1:1",
      toolId: "privileged_tool",
      toolName: "privileged_tool",
      safetyLevel: "privileged",
      arguments: {},
    });
    expect(result).toMatchObject({ authorized: false });
    expect((await repo.listActions(tenant)).length).toBe(0);
  });
});
