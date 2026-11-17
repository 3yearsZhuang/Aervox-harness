import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRequest } from "@aervox/core";
import { createInMemoryDatabase, createPostgresqlDatabase, databaseStoragePolicyFor, SqliteProactiveProfileRepository } from "@aervox/repositories";
import { buildApp } from "./app-fixture.js";

const captured = vi.hoisted(() => ({ requests: [] as ModelRequest[] }));
vi.mock("@aervox/core", async importOriginal => {
  const actual = await importOriginal<typeof import("@aervox/core")>();
  return { ...actual, createReplayProvider: () => ({ id: "storage-policy-replay", async *stream(request: ModelRequest) {
    captured.requests.push(structuredClone(request)); yield { text: "Ordinary conversation remains available.", isFinal: true };
  } }) };
});
const databaseUrl = process.env.AERVOX_PG_TEST_URL ?? process.env.AERVOX_TEST_POSTGRES_URL;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const token = "local-only-storage-test-token";
const headers = { authorization: `Bearer ${token}` };
describe.skipIf(!databaseUrl)("unverified PostgreSQL local_only runtime policy", () => {
  let root: string, schema: string, admin: Pool;
  let database: Awaited<ReturnType<typeof createPostgresqlDatabase>> | undefined;
  let vault: Awaited<ReturnType<typeof createInMemoryDatabase>> | undefined;
  let built: Awaited<ReturnType<typeof buildApp>> | undefined;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-pg-local-only-"));
    schema = `aervox_policy_${randomUUID().replaceAll("-", "")}`;
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE SCHEMA ${quote(schema)}`);
    // Keep the existing isolated server untouched. A symlinked socket connects
    // to the real fixture but cannot satisfy the private local-storage proof,
    // exercising the same fail-closed policy as a remote or forwarded target.
    const unverified = new URL(databaseUrl!);
    const socket = unverified.searchParams.get("host");
    if (socket?.startsWith("/")) {
      const linked = path.join(root, "socket-link"); await fs.symlink(socket, linked);
      unverified.searchParams.set("host", linked);
    }
    database = await createPostgresqlDatabase({ connectionString: unverified.toString(), schema, instanceId: "policy-owner", initializeEmpty: true });
    expect(databaseStoragePolicyFor(database.db).localOnlyAllowed).toBe(false);
    vault = await createInMemoryDatabase();
    vi.stubEnv("AERVOX_LOOP_PROVIDER", "replay"); vi.stubEnv("AERVOX_TURN_EXECUTION", "inline"); vi.stubEnv("AERVOX_LOOP_RESUME", "off");
    captured.requests.length = 0;
    built = await buildApp({ db: database.db, client: database.client, initSchema: false,
      proactiveDb: vault.db, proactiveClient: vault.client, proactiveAccessToken: null,
      skillsRoot: path.join(root, "skills"), pluginsRoot: path.join(root, "plugins"),
      attachmentsRoot: path.join(root, "attachments"), migrationStatePath: path.join(root, "migration.json"),
      pluginRegistryOptions: null, embeddingProvider: null,
      auth: { mode: "token", token, actorId: "policy-test" } });
    await built.app.ready();
  });
  afterEach(async () => {
    try { await built?.app.close(); }
    finally {
      built = undefined; await database?.closeAsync(); database = undefined;
      await vault?.cleanup(); vault = undefined;
      if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${quote(schema)} CASCADE`); await admin.end(); }
      if (root) await fs.rm(root, { recursive: true, force: true });
      vi.restoreAllMocks(); vi.unstubAllEnvs();
    }
  });
  it("rejects protected routes and writes despite a separate local vault", async () => {
    const requests = [
      { method: "GET" as const, url: "/v1/proactive/status" },
      { method: "POST" as const, url: "/v1/proactive/drafts", payload: { deviceId: "device", manifest: {} } },
      { method: "POST" as const, url: "/v1/proactive/intelligence/timeline", payload: { sourceKey: "private", eventType: "private", subjectKey: "private", title: "PRIVATE_CAPTURE_SECRET" } },
      { method: "POST" as const, url: "/v1/proactive/captures", payload: { content: "PRIVATE_CAPTURE_SECRET" } },
    ];
    for (const request of requests) {
      const response = await built!.app.inject({ ...request, headers });
      expect(response.statusCode, response.body).toBe(503);
      expect(response.json().error).toBe("local_only_storage_required");
    }
    for (const table of ["proactive_profile_revisions", "proactive_captures", "proactive_timeline_events", "notifications"]) {
      expect(Number((await database!.client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]?.n)).toBe(0);
      expect(Number((await vault!.client.execute(`SELECT COUNT(*) AS n FROM ${table}`)).rows[0]?.n)).toBe(0);
    }
  });
  it("completes ordinary conversation without querying or injecting the protected profile", async () => {
    const profileRead = vi.spyOn(SqliteProactiveProfileRepository.prototype, "getEffectiveStatus").mockRejectedValue(new Error("protected vault must not be read"));
    const session = await built!.app.inject({ method: "POST", url: "/v1/sessions", headers, payload: { id: "ordinary-session", title: "Ordinary" } });
    expect(session.statusCode, session.body).toBe(201);
    const turn = await built!.app.inject({ method: "POST", url: "/v1/sessions/ordinary-session/turns",
      headers: { ...headers, "idempotency-key": "ordinary-turn" },
      payload: { message: { content: "Hello ordinary database", contentType: "text" }, references: [], clientVersion: "policy-test" } });
    expect(turn.statusCode, turn.body).toBe(201);
    expect(profileRead).not.toHaveBeenCalled();
    expect(captured.requests).toHaveLength(1);
    expect(JSON.stringify(captured.requests)).not.toContain("Local User Profile Context");
    const history = await built!.app.inject({ method: "GET", url: "/v1/sessions/ordinary-session/history", headers });
    expect(history.statusCode, history.body).toBe(200);
    expect(history.body).toContain("Ordinary conversation remains available.");
    expect(Number((await database!.client.execute("SELECT COUNT(*) AS n FROM notifications")).rows[0]?.n)).toBe(0);
  });
});
