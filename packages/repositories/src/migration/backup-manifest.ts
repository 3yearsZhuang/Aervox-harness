import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export type BackupArtifactRole = "database" | "vault" | "recovery-ledger" | "wal" | "shm" | "export";

export interface BackupArtifactInput {
  readonly role: BackupArtifactRole;
  readonly sourcePath: string;
  readonly relativePath: string;
}

export interface BackupArtifact {
  readonly role: BackupArtifactRole;
  readonly relativePath: string;
  readonly size: number;
  readonly sha256: string;
}

export interface Cr030BackupManifest {
  readonly format: "aervox-cr030-backup";
  readonly formatVersion: 1;
  readonly createdAt: string;
  readonly schemaVersion: string;
  readonly tableCounts: Readonly<Record<string, number>>;
  readonly artifacts: readonly BackupArtifact[];
}

export interface BackupVerification {
  readonly ok: boolean;
  readonly issues: readonly string[];
  readonly manifest?: Cr030BackupManifest;
}

function safeRelativePath(relativePath: string): string {
  const normalized = path.posix.normalize(relativePath.replaceAll(path.sep, "/"));
  if (normalized === "." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`invalid backup relative path: ${relativePath}`);
  }
  return normalized;
}

async function sha256File(filePath: string): Promise<{ size: number; sha256: string }> {
  const stat = await fs.lstat(filePath);
  if (!stat.isFile()) throw new Error(`backup artifact is not a regular file: ${filePath}`);
  const hash = createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(Buffer.from(chunk));
  } finally {
    await handle.close();
  }
  return { size: stat.size, sha256: hash.digest("hex") };
}

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  const handle = await fs.open(temporaryPath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(temporaryPath, filePath);
}

export async function createVerifiedBackup(options: {
  readonly destinationDir: string;
  readonly schemaVersion: string;
  readonly tableCounts?: Readonly<Record<string, number>>;
  readonly artifacts: readonly BackupArtifactInput[];
}): Promise<{ manifestPath: string; manifest: Cr030BackupManifest }> {
  if (options.artifacts.length === 0) throw new Error("CR-030 backup requires at least one artifact");
  await fs.mkdir(options.destinationDir, { recursive: true });
  const artifacts: BackupArtifact[] = [];
  for (const input of options.artifacts) {
    const relativePath = safeRelativePath(input.relativePath);
    const destinationPath = path.join(options.destinationDir, relativePath);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.copyFile(input.sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
    const digest = await sha256File(destinationPath);
    artifacts.push({ role: input.role, relativePath, ...digest });
  }
  const manifest: Cr030BackupManifest = {
    format: "aervox-cr030-backup",
    formatVersion: 1,
    createdAt: new Date().toISOString(),
    schemaVersion: options.schemaVersion,
    tableCounts: options.tableCounts ?? {},
    artifacts,
  };
  const manifestPath = path.join(options.destinationDir, "manifest.json");
  await writeJsonAtomically(manifestPath, manifest);
  return { manifestPath, manifest };
}

export async function verifyBackupManifest(manifestPath: string): Promise<BackupVerification> {
  let manifest: Cr030BackupManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as Cr030BackupManifest;
  } catch (error) {
    return { ok: false, issues: [`cannot read backup manifest: ${String(error)}`] };
  }
  const issues: string[] = [];
  if (manifest.format !== "aervox-cr030-backup" || manifest.formatVersion !== 1) {
    issues.push("unsupported CR-030 backup manifest format");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) {
    issues.push("backup manifest has no artifacts");
    return { ok: false, issues, manifest };
  }
  for (const artifact of manifest.artifacts) {
    let relativePath: string;
    try {
      relativePath = safeRelativePath(artifact.relativePath);
    } catch (error) {
      issues.push(String(error));
      continue;
    }
    const artifactPath = path.join(path.dirname(manifestPath), relativePath);
    try {
      const digest = await sha256File(artifactPath);
      if (digest.size !== artifact.size || digest.sha256 !== artifact.sha256) {
        issues.push(`${relativePath}: size or SHA-256 mismatch`);
      }
    } catch (error) {
      issues.push(`${relativePath}: ${String(error)}`);
    }
  }
  return { ok: issues.length === 0, issues, manifest };
}

export async function assertVerifiedBackup(manifestPath: string): Promise<Cr030BackupManifest> {
  const verification = await verifyBackupManifest(manifestPath);
  if (!verification.ok || !verification.manifest) {
    throw new Error(`CR-030 backup verification failed: ${verification.issues.join("; ")}`);
  }
  return verification.manifest;
}
