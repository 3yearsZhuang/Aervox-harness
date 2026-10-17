import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  MEMORY_DELETION_VERIFIER,
  MemoryWriteUnavailableError,
  RepositoryNotFoundError,
  SqliteMemoryDeletionStore,
  SqliteMemoryRepository,
  SqliteProvenanceRepository,
  SqliteSkillLifecycleRepository,
} from "../src/index.js";

const local = { workspaceId: "local", subjectUserId: "local" };

describe("Memory provenance writes preserve deletion tombstones", () => {
  let database: Awaited<ReturnType<typeof createInMemoryDatabase>>;
  let memory: SqliteMemoryRepository;
  let provenance: SqliteProvenanceRepository;
  let deletion: SqliteMemoryDeletionStore;
  let skills: SqliteSkillLifecycleRepository;

  beforeEach(async () => {
    database = await createInMemoryDatabase();
    await initDatabaseSchema(database.client);
    memory = new SqliteMemoryRepository(database.db, database.client);
    provenance = new SqliteProvenanceRepository(database.db);
    deletion = new SqliteMemoryDeletionStore(database.db);
    skills = new SqliteSkillLifecycleRepository(database.db);
    for (const id of ["target", "keep"]) {
      await memory.createRecord(local, { id, layer: "long_term", type: "user_fact", content: `private ${id}` });
      await provenance.appendMemoryRevision(local, { id: `revision-${id}`, memoryId: id, content: `private revision ${id}` });
      await provenance.setMemoryCurrentRevision(local, id, `revision-${id}`);
      await provenance.createMemoryEvidence(local, {
        id: `evidence-${id}`, memoryRevisionId: `revision-${id}`,
        sourceArtifactId: "source", sourceRevisionId: "source-revision", sourceRange: `private range ${id}`,
      });
      await provenance.recordMemoryEvent(local, {
        id: `event-${id}`, memoryId: id, action: "revised", reason: `private reason ${id}`,
      });
    }
    await memory.createNode(local, { id: "node-a", label: "A" });
    await memory.createNode(local, { id: "node-b", label: "B" });
    await memory.createEdge(local, { id: "edge", fromNodeId: "node-a", toNodeId: "node-b", relationType: "related" });
  });

  afterEach(async () => { await database.cleanup(); });

  async function observe(id: string) {
    return Promise.all([
      database.db.all(sql`SELECT * FROM memory_records WHERE id = ${id}`),
      provenance.listMemoryRevisions(local, id),
      database.db.all(sql`SELECT * FROM memory_evidence WHERE memory_revision_id = ${`revision-${id}`}`),
      provenance.listMemoryEvents(local, id),
    ]);
  }

  it.each([false, true])("rejects fetched provenance writes after cleanup (already verified: %s)", async (verified) => {
    const [fetchedRevision] = await provenance.listMemoryRevisions(local, "target");
    const keepBefore = await observe("keep");
    await deletion.clean("target");
    if (verified) await deletion.verify("target");
    const cleared = await observe("target");

    await expect(provenance.appendMemoryRevision(local, {
      id: "late-revision", memoryId: "target", content: fetchedRevision!.content,
    })).rejects.toBeInstanceOf(MemoryWriteUnavailableError);
    await expect(provenance.createMemoryEvidence(local, {
      id: "late-evidence", memoryRevisionId: fetchedRevision!.id,
      sourceArtifactId: "source", sourceRevisionId: "source-revision", sourceRange: "late private range",
    })).rejects.toBeInstanceOf(MemoryWriteUnavailableError);
    await expect(provenance.recordMemoryEvent(local, {
      id: "late-event", memoryId: "target", action: "revised", reason: "late private reason",
    })).rejects.toBeInstanceOf(MemoryWriteUnavailableError);
    expect(await provenance.setMemoryCurrentRevision(local, "target", fetchedRevision!.id)).toBe(false);

    expect(await observe("target")).toEqual(cleared);
    expect(await observe("keep")).toEqual(keepBefore);
    expect(JSON.parse(await deletion.verify("target")).verifier).toBe(MEMORY_DELETION_VERIFIER);
    // An unrelated live source retains each write operation.
    await provenance.appendMemoryRevision(local, { id: "keep-next", memoryId: "keep", content: "retained revision" });
    await provenance.createMemoryEvidence(local, {
      id: "keep-next-evidence", memoryRevisionId: "keep-next", sourceArtifactId: "source", sourceRevisionId: "source-revision",
    });
    await provenance.recordMemoryEvent(local, { id: "keep-next-event", memoryId: "keep", action: "revised", reason: "retained reason" });
    expect(await provenance.setMemoryCurrentRevision(local, "keep", "keep-next")).toBe(true);
  });

  it("cleans provenance committed before deletion, including all revisions and evidence", async () => {
    await provenance.appendMemoryRevision(local, { id: "second", memoryId: "target", content: "another private revision" });
    await provenance.createMemoryEvidence(local, {
      id: "second-evidence", memoryRevisionId: "second", sourceArtifactId: "source", sourceRevisionId: "source-revision", sourceRange: "another range",
    });
    await deletion.clean("target");
    expect((await provenance.listMemoryRevisions(local, "target")).map(r => r.content)).toEqual(["", ""]);
    expect(await database.db.all(sql`SELECT status, source_range FROM memory_evidence WHERE memory_revision_id IN ('revision-target', 'second')`))
      .toEqual([{ status: "tombstoned", source_range: null }, { status: "tombstoned", source_range: null }]);
    expect((await provenance.listMemoryEvents(local, "target")).every(e => e.reason === null)).toBe(true);
    await expect(deletion.verify("target")).resolves.toContain(MEMORY_DELETION_VERIFIER);
  });

  it("rejects unknown provenance targets and prevents references to another memory's revision", async () => {
    await expect(provenance.appendMemoryRevision(local, { id: "missing-revision", memoryId: "missing", content: "private" }))
      .rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provenance.createMemoryEvidence(local, {
      id: "missing-evidence", memoryRevisionId: "missing", sourceArtifactId: "source", sourceRevisionId: "source-revision",
    })).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provenance.recordMemoryEvent(local, { id: "missing-event", memoryId: "missing", action: "revised" }))
      .rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(await provenance.setMemoryCurrentRevision(local, "missing", "revision-target")).toBe(false);
    expect(await provenance.setMemoryCurrentRevision(local, "target", "missing")).toBe(false);
    expect(await provenance.setMemoryCurrentRevision(local, "target", "revision-keep")).toBe(false);
    expect((await memory.getRecord(local, "target"))?.currentRevisionId).toBe("revision-target");
  });

  const projections = ["child", "edge", "skill"] as const;
  async function attachProjection(kind: typeof projections[number]) {
    if (kind === "child") return memory.createRecord(local, {
      id: "child", layer: "long_term", type: "user_fact", content: "child fact", canonicalParentId: "target",
    });
    if (kind === "edge") return memory.createEdgeEvidence({ id: "edge-evidence", edgeId: "edge", memoryRevisionId: "revision-target" });
    return skills.createCandidate({ candidateId: "candidate", skillKey: "test", sourceEvidence: { turnIds: [], memoryIds: ["target"], learningItemIds: [] } });
  }

  it.each(projections)("rejects a late %s projection without invalidating completed cleanup", async (kind) => {
    await deletion.clean("target");
    await deletion.verify("target");
    await expect(attachProjection(kind)).rejects.toBeInstanceOf(MemoryWriteUnavailableError);
    await expect(deletion.verify("target")).resolves.toContain(MEMORY_DELETION_VERIFIER);
  });

  it.each(projections)("preserves an existing %s projection and requires its owner cleanup", async (kind) => {
    await attachProjection(kind);
    await expect(deletion.clean("target")).rejects.toThrow("deletion_memory_projection_requires_owner_cleanup");
    expect((await memory.getRecord(local, "target"))?.content).toBe("private target");
  });

  it("keeps the identity tombstone so createRecord cannot recreate the same memory", async () => {
    await deletion.clean("target");
    await expect(memory.createRecord(local, { id: "target", layer: "long_term", type: "user_fact", content: "resurrected" })).rejects.toThrow();
    await expect(deletion.verify("target")).resolves.toContain(MEMORY_DELETION_VERIFIER);
  });
});
