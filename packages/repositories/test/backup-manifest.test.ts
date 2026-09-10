import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertVerifiedBackup, createVerifiedBackup, verifyBackupManifest } from "../src/migration/backup-manifest.js";

describe("CR-030 backup manifest", () => {
  it("copies artifacts and verifies size plus SHA-256", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-cr030-backup-"));
    try {
      const source = path.join(directory, "source.db");
      await fs.writeFile(source, "stable database bytes");
      const backupDir = path.join(directory, "backup");
      const result = await createVerifiedBackup({
        destinationDir: backupDir,
        schemaVersion: "legacy-v1",
        tableCounts: { legacy_items: 2 },
        artifacts: [{ role: "database", sourcePath: source, relativePath: "database/aervox.db" }],
      });
      expect((await verifyBackupManifest(result.manifestPath)).ok).toBe(true);
      await expect(assertVerifiedBackup(result.manifestPath)).resolves.toMatchObject({
        schemaVersion: "legacy-v1",
        tableCounts: { legacy_items: 2 },
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("fails verification when an artifact is tampered with and rejects traversal paths", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-cr030-backup-"));
    try {
      const source = path.join(directory, "vault.db");
      await fs.writeFile(source, "secret vault bytes");
      const result = await createVerifiedBackup({
        destinationDir: path.join(directory, "backup"),
        schemaVersion: "legacy-v1",
        artifacts: [{ role: "vault", sourcePath: source, relativePath: "vault.db" }],
      });
      await fs.writeFile(path.join(directory, "backup", "vault.db"), "tampered");
      const verification = await verifyBackupManifest(result.manifestPath);
      expect(verification.ok).toBe(false);
      expect(verification.issues.join(" ")).toContain("SHA-256 mismatch");
      await expect(
        createVerifiedBackup({
          destinationDir: path.join(directory, "bad"),
          schemaVersion: "legacy-v1",
          artifacts: [{ role: "database", sourcePath: source, relativePath: "../escape.db" }],
        }),
      ).rejects.toThrow(/invalid backup relative path/);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
