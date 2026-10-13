import { createHash, createPublicKey, verify } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { NATIVE_PROTOCOL } from "./protocol.js";

export interface NativeArtifact {
  binary: string;
  sha256: string;
  /** Ed25519 signature of the binary digest; public key belongs to the trusted release. */
  signature?: string;
  publicKey?: string;
  requireSignature?: boolean;
}
export async function verifyNativeArtifact(artifact: NativeArtifact): Promise<string> {
  if (!isAbsolute(artifact.binary) || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) throw new Error("native_artifact_invalid");
  const binary = await realpath(artifact.binary);
  const bytes = await readFile(binary);
  const digest = createHash("sha256").update(bytes).digest();
  if (digest.toString("hex") !== artifact.sha256) throw new Error("native_artifact_digest_mismatch");
  if (artifact.requireSignature || artifact.signature || artifact.publicKey) {
    if (!artifact.signature || !artifact.publicKey) throw new Error("native_artifact_signature_required");
    const key = createPublicKey(artifact.publicKey);
    if (key.asymmetricKeyType !== "ed25519" || !verify(null, digest, key, Buffer.from(artifact.signature, "base64"))) throw new Error("native_artifact_signature_invalid");
  }
  return binary;
}

export function nativeArtifactFromEnvironment(env: NodeJS.ProcessEnv = process.env): NativeArtifact | undefined {
  const binary = env.AERVOX_NATIVE_BINARY?.trim(), sha256 = env.AERVOX_NATIVE_SHA256?.trim();
  if (!binary && !sha256) return undefined;
  if (!binary || !sha256) throw new Error("native_artifact_configuration_incomplete");
  return { binary, sha256 };
}

export async function loadNativeArtifact(manifestPath?: string): Promise<NativeArtifact | undefined> {
  const path = manifestPath ?? fileURLToPath(new URL(`./bin/${process.platform}-${process.arch}/artifact.json`, import.meta.url));
  let bytes: Buffer;
  try { bytes = await readFile(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (bytes.length > 8192) throw new Error("native_artifact_manifest_limit");
  const manifest = JSON.parse(bytes.toString("utf8")) as { protocol: number; platform: string; arch: string; binary: string; sha256: string; signature?: string };
  if (manifest.protocol !== NATIVE_PROTOCOL || manifest.platform !== process.platform || manifest.arch !== process.arch
    || manifest.binary !== (process.platform === "win32" ? "aervox-native.exe" : "aervox-native")) throw new Error("native_artifact_platform_mismatch");
  return { binary: join(dirname(path), manifest.binary), sha256: manifest.sha256, signature: manifest.signature };
}
