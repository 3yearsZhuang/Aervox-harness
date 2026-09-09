import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createProactiveVaultCipher,
  loadProactiveVaultCipher,
} from "../src/proactive-vault-crypto.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CAP-033 proactive vault field encryption", () => {
  it("round-trips text with authenticated context and rejects the wrong context", () => {
    const cipher = createProactiveVaultCipher(new Uint8Array(32).fill(7), "test-key");
    const envelope = cipher.encrypt("private profile text", "capture:cap_1");
    expect(envelope).not.toContain("private profile text");
    expect(cipher.isEncrypted(envelope)).toBe(true);
    expect(cipher.decrypt(envelope, "capture:cap_1")).toBe("private profile text");
    expect(() => cipher.decrypt(envelope, "capture:cap_2")).toThrow();
  });

  it("persists the fallback key with owner-only permissions", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aervox-vault-key-"));
    tempDirs.push(dir);
    const keyPath = path.join(dir, "nested", "vault.key");
    const first = await loadProactiveVaultCipher({ keyPath, keyId: "test-key" }, {});
    const second = await loadProactiveVaultCipher({ keyPath, keyId: "test-key" }, {});
    const envelope = first.encrypt("same local key", "claim:1");
    expect(second.decrypt(envelope, "claim:1")).toBe("same local key");
    expect((await readFile(keyPath, "utf8")).trim()).not.toHaveLength(0);
    if (process.platform !== "win32") {
      expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
    }
  });
});
