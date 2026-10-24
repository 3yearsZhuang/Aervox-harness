import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryDatabase, createProactiveVaultCipher, SqliteProactiveProfileRepository,
  type CaptureDistillationInput } from "../src/index.js";

const ctx = { workspaceId: "local", subjectUserId: "local" };
describe("atomic capture distillation publication", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let repo: SqliteProactiveProfileRepository;
  let input: CaptureDistillationInput;
  beforeEach(async () => {
    database = await createInMemoryDatabase();
    repo = new SqliteProactiveProfileRepository(database.db, createProactiveVaultCipher(new Uint8Array(32).fill(7), "test"));
    await repo.confirmProfile(ctx, { id: "profile", deviceId: "device", actorId: "local", sources: [{ id: "source",
      sourceKey: "device.browser_activity", purpose: "profile.observe", scope: "all", osCapability: "os.browser_history", state: "granted", mandatory: true }] });
    await repo.createCapture(ctx, { id: "capture", revisionId: "profile", sourceGrantId: "source", sourceKey: "device.browser_activity",
      contentType: "text/plain", payloadText: "original private source", checksum: "capture-checksum" });
    input = { captureId: "capture", revisionId: "profile", sourceGrantId: "source", sourceKey: "device.browser_activity",
      checksum: "capture-checksum", processorId: "multi-output-v2", outputs: [1, 2].map(index => ({
        claimType: "habit", subjectKey: `subject-${index}`, content: `private output-${index}`, confidence: 80,
        evidenceRefs: [{ sourceKey: "device.browser_activity", checksum: "capture-checksum" }],
      })) };
  });
  afterEach(async () => { await database.cleanup(); });
  const state = async () => Promise.all(["proactive_captures", "proactive_observations", "proactive_profile_claims", "proactive_audit_events"].map(async table =>
    (await database.client.execute(`SELECT * FROM ${table} ORDER BY id`)).rows));

  it.each([
    "BEFORE INSERT ON proactive_observations",
    "BEFORE INSERT ON proactive_profile_claims WHEN new.id='pclaim_capture_2'",
    "BEFORE UPDATE ON proactive_captures WHEN new.distillation_status='distilled'",
    "BEFORE INSERT ON proactive_audit_events WHEN new.event_type='capture.distilled'",
  ])("rolls back outputs, marker and audits together for %s", async clause => {
    const before = await state();
    await database.client.execute(`CREATE TRIGGER fail_publish ${clause} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    await expect(repo.publishCaptureDistillation(ctx, input)).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it("publishes all outputs, preserves processor identity and replays one durable receipt under concurrency", async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => repo.publishCaptureDistillation(ctx, input)));
    expect(results.filter(result => result.created)).toHaveLength(1);
    expect(results[0]).toMatchObject({ outputCount: 2, memoryIds: ["pclaim_capture_1", "pclaim_capture_2"] });
    expect(await repo.listCaptureClaims(ctx, "capture")).toEqual([
      expect.objectContaining({ algorithmVersion: "multi-output-v2", content: "private output-1" }),
      expect.objectContaining({ algorithmVersion: "multi-output-v2", content: "private output-2" }),
    ]);
    expect(await repo.listObservations(ctx)).toHaveLength(2);
    expect((await repo.listCaptures(ctx))[0]).toMatchObject({ distillationStatus: "distilled", distilledMemoryIds: results[0]!.memoryIds });
    const raw = await database.client.execute("SELECT payload_json FROM proactive_audit_events WHERE event_type='capture.distilled'");
    expect(String(raw.rows[0]!.payload_json)).not.toContain("private output");
    const before = await state();
    await expect(repo.publishCaptureDistillation(ctx, { ...input, processorId: "other-version" })).rejects.toThrow("capture_distillation_intent_mismatch");
    await expect(repo.publishCaptureDistillation(ctx, { ...input, outputs: input.outputs.slice(0, 1) })).rejects.toThrow("capture_distillation_intent_mismatch");
    expect(await state()).toEqual(before);
  });

  it("commits observation-only results in the same receipt without inventing a claim", async () => {
    input.outputs[1] = { ...input.outputs[1]!, observationOnly: true, structured: { idleSeconds: 12, captureId: "forged" } };
    expect(await repo.publishCaptureDistillation(ctx, input)).toMatchObject({ memoryIds: ["pclaim_capture_1", "pobs_capture_2"] });
    expect(await repo.listCaptureClaims(ctx, "capture")).toHaveLength(1);
    expect((await repo.listObservations(ctx)).find(item => item.id === "pobs_capture_2")?.payload).toMatchObject({ idleSeconds: 12, captureId: "capture" });
  });

  it.each(["revoke", "delete"] as const)("revalidates %s under the writer transaction after the submitted draft was prepared", async change => {
    const transaction = database.db.transaction.bind(database.db);
    database.db.transaction = async (...args) => {
      database.db.transaction = transaction;
      if (change === "revoke") await repo.updateSourceGrant(ctx, "source", { state: "revoked", actorId: "local" });
      else await repo.deleteSourceData(ctx, "source", "local");
      return transaction(...args);
    };
    await expect(repo.publishCaptureDistillation(ctx, input)).rejects.toThrow("capture_distillation_source_unavailable");
    expect(await repo.listCaptureClaims(ctx, "capture")).toHaveLength(0);
    expect(await repo.listObservations(ctx)).toHaveLength(0);
  });

  it("does not refill legacy partial observations without a complete publication receipt", async () => {
    await repo.createObservation(ctx, { id: "pobs_capture_1", revisionId: "profile", sourceGrantId: "source", sourceKey: "device.browser_activity",
      observationType: "habit", subjectKey: "subject-1", payload: { captureId: "capture" }, checksum: "capture-checksum" });
    const before = await state();
    await expect(repo.publishCaptureDistillation(ctx, input)).rejects.toThrow("capture_distillation_receipt_unavailable");
    expect(await state()).toEqual(before);
  });

  it("does not confuse another capture's deterministic observation prefix with this capture", async () => {
    await repo.createObservation(ctx, { id: "pobs_capture_other_1", revisionId: "profile", sourceGrantId: "source", sourceKey: "device.browser_activity",
      observationType: "habit", subjectKey: "other", checksum: "other" });
    expect(await repo.publishCaptureDistillation(ctx, input)).toMatchObject({ created: true });
  });

  it.each(["empty", "count", "bytes", "non-finite"] as const)("rejects %s drafts before any publication writes", async kind => {
    if (kind === "empty") input.outputs = [];
    if (kind === "count") input.outputs = Array.from({ length: 101 }, () => input.outputs[0]!);
    if (kind === "bytes") input.outputs[0]!.content = "a".repeat(1024 * 1024);
    if (kind === "non-finite") input.outputs[0]!.confidence = NaN;
    const before = await state();
    await expect(repo.publishCaptureDistillation(ctx, input)).rejects.toThrow("capture_distillation_invalid_draft");
    expect(await state()).toEqual(before);
  });

  it.each(["{}", "null", "[]", '"invalid"'])("rejects a missing or damaged committed receipt (%s) rather than guessing a complete batch", async payload => {
    await repo.publishCaptureDistillation(ctx, input);
    await database.client.execute({ sql: "UPDATE proactive_audit_events SET payload_json=? WHERE event_type='capture.distilled'", args: [payload] });
    const before = await state();
    await expect(repo.publishCaptureDistillation(ctx, input)).rejects.toThrow("capture_distillation_receipt_unavailable");
    expect(await state()).toEqual(before);
    await expect(repo.markCaptureDistilled(ctx, "capture", ["pclaim_capture_1", "pclaim_capture_2"]))
      .rejects.toThrow("capture_distillation_receipt_unavailable");
    await database.client.execute("DELETE FROM proactive_audit_events WHERE event_type='capture.distilled'");
    await expect(repo.publishCaptureDistillation(ctx, input)).rejects.toThrow("capture_distillation_receipt_unavailable");
  });

  const manualClaim = () => repo.createClaim(ctx, { id: "manual-claim", revisionId: "profile", claimType: "habit",
    subjectKey: "manual", content: "manually distilled private output", evidenceCaptureIds: ["capture"], sourceGrantIds: ["source"] });

  describe("legacy claim writer source qualification", () => {
    const applyControl = async (change: string) => {
      if (change === "delete") await repo.deleteSourceData(ctx, "source", "local");
      else if (change === "pause") await repo.setDesiredState(ctx, "paused", "local", "profile");
      else if (change === "deleted-capture") await database.client.execute("UPDATE proactive_captures SET deleted_at = '2026-10-24T00:00:00Z' WHERE id = 'capture'");
      else if (change === "capture-boundary") await database.client.execute("UPDATE proactive_captures SET processing_boundary = 'cloud' WHERE id = 'capture'");
      else if (change === "profile-boundary") await database.client.execute("UPDATE proactive_profile_revisions SET processing_boundary = 'cloud' WHERE id = 'profile'");
      else if (change === "source-boundary") await database.client.execute("UPDATE proactive_source_grants SET processing_boundary = 'cloud' WHERE id = 'source'");
      else await repo.updateSourceGrant(ctx, "source", { state: change as "revoked" | "expired" | "denied" | "requested", actorId: "local" });
    };

    it.each(["delete", "pause", "revoked", "expired", "denied", "requested", "deleted-capture", "capture-boundary", "profile-boundary", "source-boundary"])(
      "rejects source-derived claim after %s without inserting private content", async change => {
        await applyControl(change);
        const before = await state();
        await expect(manualClaim()).rejects.toThrow("claim_source_unavailable");
        expect(await state()).toEqual(before);
        expect((await database.client.execute("SELECT id FROM proactive_profile_claims WHERE id='manual-claim'")).rows).toEqual([]);
      },
    );

    it.each(["delete", "pause", "revoked", "expired"])(
      "rechecks %s when it wins the race before the claim writer transaction", async change => {
        const transaction = database.db.transaction.bind(database.db);
        let before: Awaited<ReturnType<typeof state>>;
        database.db.transaction = async (...args) => {
          database.db.transaction = transaction;
          await applyControl(change);
          before = await state();
          return transaction(...args);
        };
        await expect(manualClaim()).rejects.toThrow("claim_source_unavailable");
        expect(await state()).toEqual(before!);
        expect((await database.client.execute("SELECT id FROM proactive_profile_claims WHERE id='manual-claim'")).rows).toEqual([]);
      },
    );

    it.each(["omitted", "unrelated", "missing", "foreign"])("rejects %s capture source provenance instead of inventing a linkage", async kind => {
      await database.client.execute("INSERT INTO proactive_source_grants SELECT 'unrelated-source', revision_id, 'device.app_activity', purpose, scope, os_capability, state, mandatory, processing_boundary, grant_version, metadata_json, granted_at, revoked_at, last_verified_at, created_at, updated_at FROM proactive_source_grants WHERE id='source'");
      if (kind === "foreign") {
        await repo.confirmProfile(ctx, { id: "other-profile", deviceId: "other", actorId: "local", sources: [{ id: "other-source",
          sourceKey: "device.browser_activity", purpose: "profile.observe", scope: "all", osCapability: "os.browser_history", state: "granted", mandatory: true }] });
        // Keep this assertion about foreign provenance, independently of the
        // profile supersession performed when confirming the other fixture.
        await database.client.execute("UPDATE proactive_profile_revisions SET status='active', desired_state='enabled' WHERE id='profile'");
      }
      const before = await state();
      await expect(repo.createClaim(ctx, { id: "bad-provenance", revisionId: "profile", claimType: "habit", subjectKey: "manual",
        content: "private derived output", evidenceCaptureIds: ["capture"],
        sourceGrantIds: kind === "omitted" ? undefined : [kind === "unrelated" ? "unrelated-source" : kind === "foreign" ? "other-source" : "missing-source"],
      })).rejects.toThrow("claim_source_unavailable");
      expect(await state()).toEqual(before);
    });

    it("checks source-only claims but preserves unlinked manual claims while paused", async () => {
      await repo.updateSourceGrant(ctx, "source", { state: "revoked", actorId: "local" });
      const before = await state();
      await expect(repo.createClaim(ctx, { id: "source-only", revisionId: "profile", claimType: "habit", subjectKey: "manual",
        content: "private source-derived output", sourceGrantIds: ["source"] })).rejects.toThrow("claim_source_unavailable");
      expect(await state()).toEqual(before);
      await repo.setDesiredState(ctx, "paused", "local", "profile");
      expect(await repo.createClaim(ctx, { id: "manual-unlinked", revisionId: "profile", claimType: "habit", subjectKey: "manual",
        state: "user_asserted", content: "explicit user-authored claim" })).toMatchObject({ id: "manual-unlinked", content: "explicit user-authored claim", evidenceCaptureIds: [], sourceGrantIds: [] });
    });

    it("accepts a currently authorized derived claim without altering its declared provenance", async () => {
      const claim = await manualClaim();
      expect(claim).toMatchObject({ id: "manual-claim", content: "manually distilled private output", evidenceCaptureIds: ["capture"], sourceGrantIds: ["source"] });
    });

    it.each(["missing-capture", "wrong-source-key"])("rejects %s evidence without retaining claim content", async kind => {
      if (kind === "wrong-source-key") await database.client.execute("UPDATE proactive_captures SET source_key='device.screen_capture' WHERE id='capture'");
      const before = await state();
      await expect(repo.createClaim(ctx, { id: "bad-evidence", revisionId: "profile", claimType: "habit", subjectKey: "manual", content: "private derived output",
        evidenceCaptureIds: [kind === "missing-capture" ? "missing-capture" : "capture"], sourceGrantIds: ["source"] })).rejects.toThrow("claim_source_unavailable");
      expect(await state()).toEqual(before);
    });

    it("snapshots the declared evidence and text before waiting for the writer", async () => {
      const submitted = { id: "captured-intent", revisionId: "profile", claimType: "habit", subjectKey: "manual", content: "captured private output",
        evidenceCaptureIds: ["capture"], sourceGrantIds: ["source"], evidenceRefs: [{ source: "original" }] };
      const transaction = database.db.transaction.bind(database.db);
      database.db.transaction = async (...args) => {
        database.db.transaction = transaction;
        submitted.id = "mutated-id";
        submitted.content = "mutated private output";
        submitted.evidenceCaptureIds.splice(0);
        submitted.sourceGrantIds.splice(0);
        submitted.evidenceRefs[0]!.source = "mutated";
        return transaction(...args);
      };
      expect(await repo.createClaim(ctx, submitted)).toMatchObject({ id: "captured-intent", content: "captured private output",
        evidenceCaptureIds: ["capture"], sourceGrantIds: ["source"], evidenceRefs: [{ source: "original" }] });
      expect((await database.client.execute("SELECT id FROM proactive_profile_claims WHERE id='mutated-id'")).rows).toEqual([]);
    });
  });

  it("accepts verified manual claim and observation results and replays without changing their receipt", async () => {
    await manualClaim();
    await repo.createObservation(ctx, { id: "manual-observation", revisionId: "profile", sourceGrantId: "source",
      sourceKey: input.sourceKey, observationType: "habit", subjectKey: "manual", checksum: input.checksum,
      payload: { captureId: "capture", content: "manual observation" } });
    const ids = ["manual-claim", "manual-observation"];
    expect(await repo.markCaptureDistilled(ctx, "capture", ids)).toMatchObject({ distillationStatus: "distilled", distilledMemoryIds: ids });
    const before = await state();
    expect(await repo.markCaptureDistilled(ctx, "capture", ids)).toMatchObject({ distilledMemoryIds: ids });
    await expect(repo.markCaptureDistilled(ctx, "capture", ["manual-claim"])).rejects.toThrow("capture_distillation_intent_mismatch");
    expect(await state()).toEqual(before);
  });

  it.each(["missing", "unlinked-claim", "unlinked-observation", "wrong-source"] as const)("rejects %s manual results without unlocking raw deletion", async kind => {
    let id = "missing";
    if (kind === "unlinked-claim") {
      id = "unlinked";
      await repo.createClaim(ctx, { id, revisionId: "profile", claimType: "habit", subjectKey: "other", content: "other capture",
        sourceGrantIds: ["source"] });
    }
    if (kind === "unlinked-observation") {
      id = "unlinked";
      await repo.createObservation(ctx, { id, revisionId: "profile", sourceGrantId: "source", sourceKey: input.sourceKey,
        observationType: "habit", subjectKey: "other", checksum: input.checksum, payload: { captureId: "other" } });
    }
    if (kind === "wrong-source") {
      id = "unlinked";
      // A malformed historical row must not become a valid distillation receipt.
      await repo.createClaim(ctx, { id, revisionId: "profile", claimType: "habit", subjectKey: "other", content: "missing source",
      });
      await database.client.execute({ sql: "UPDATE proactive_profile_claims SET evidence_capture_ids_json=? WHERE id=?", args: [JSON.stringify(["capture"]), id] });
    }
    const before = await state();
    await expect(repo.markCaptureDistilled(ctx, "capture", [id])).rejects.toThrow("capture_distillation_result_unavailable");
    expect(await state()).toEqual(before);
    expect(await repo.purgeEligibleCaptures(ctx, "2100-01-01T00:00:00.000Z")).toBe(0);
    expect((await repo.listCaptures(ctx))[0]!.payloadText).toBe("original private source");
  });

  it("protects an atomic publication from manual marker replacement and late failure", async () => {
    const receipt = await repo.publishCaptureDistillation(ctx, input);
    const before = await state();
    expect(await repo.markCaptureDistilled(ctx, "capture", receipt.memoryIds)).toMatchObject({ distilledMemoryIds: receipt.memoryIds });
    await expect(repo.markCaptureDistilled(ctx, "capture", receipt.memoryIds.slice(0, 1))).rejects.toThrow("capture_distillation_intent_mismatch");
    expect(await repo.markCaptureDistillationFailed(ctx, "capture", "private late processor error")).toBeNull();
    expect(await state()).toEqual(before);
    expect(await repo.publishCaptureDistillation(ctx, input)).toMatchObject({ created: false });
  });

  it("rolls back a manual completion marker when its audit fails", async () => {
    await manualClaim();
    const before = await state();
    await database.client.execute("CREATE TRIGGER fail_manual BEFORE INSERT ON proactive_audit_events WHEN new.event_type='capture.distilled' BEGIN SELECT RAISE(ABORT, 'injected'); END");
    await expect(repo.markCaptureDistilled(ctx, "capture", ["manual-claim"])).rejects.toThrow();
    expect(await state()).toEqual(before);
  });

  it.each(["revoke", "delete", "pause"] as const)("revalidates %s inside both manual completion and failure transactions", async change => {
    await manualClaim();
    const applyControl = async () => {
      if (change === "revoke") await repo.updateSourceGrant(ctx, "source", { state: "revoked", actorId: "local" });
      else if (change === "delete") await repo.deleteSourceData(ctx, "source", "local");
      else await repo.setDesiredState(ctx, "paused", "local", "profile");
    };
    const transaction = database.db.transaction.bind(database.db);
    database.db.transaction = async (...args) => {
      database.db.transaction = transaction;
      await applyControl();
      return transaction(...args);
    };
    expect(await repo.markCaptureDistilled(ctx, "capture", ["manual-claim"])).toBeNull();
    const before = await state();
    expect(await repo.markCaptureDistillationFailed(ctx, "capture", "private after control change")).toBeNull();
    expect(await state()).toEqual(before);
  });

  it("stores only fixed failure metadata, including when historical failures survive source deletion", async () => {
    const privateError = "private source password=top-secret; original private source";
    expect(await repo.markCaptureDistillationFailed(ctx, "capture", privateError)).toMatchObject({
      distillationStatus: "failed", lastDistillationError: "capture_distillation_failed", distillationAttemptCount: 1 });
    expect(await repo.markCaptureDistillationFailed(ctx, "capture", "capture_distillation_receipt_unavailable")).toMatchObject({
      lastDistillationError: "capture_distillation_receipt_unavailable", distillationAttemptCount: 2 });
    const failures = (await database.client.execute("SELECT payload_json FROM proactive_audit_events WHERE event_type='capture.distillation_failed'")).rows;
    expect(failures.map(row => JSON.parse(String(row.payload_json)).reason)).toEqual([
      "capture_distillation_failed", "capture_distillation_receipt_unavailable" ]);
    await repo.deleteSourceData(ctx, "source", "local");
    const before = await state();
    expect(await repo.markCaptureDistillationFailed(ctx, "capture", privateError)).toBeNull();
    expect(await state()).toEqual(before);
    expect(JSON.stringify(await state())).not.toContain("top-secret");
    expect(JSON.stringify(await state())).not.toContain("original private source");
  });

  it.each(["marker", "audit"] as const)("rolls back failure status, retry count and audit when the %s write fails", async kind => {
    const before = await state();
    const clause = kind === "marker" ? "BEFORE UPDATE ON proactive_captures WHEN new.distillation_status='failed'"
      : "BEFORE INSERT ON proactive_audit_events WHEN new.event_type='capture.distillation_failed'";
    await database.client.execute(`CREATE TRIGGER fail_failure ${clause} BEGIN SELECT RAISE(ABORT, 'injected'); END`);
    await expect(repo.markCaptureDistillationFailed(ctx, "capture", "private processor exception")).rejects.toThrow();
    expect(await state()).toEqual(before);
  });
});
