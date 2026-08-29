import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProactiveAccessToken } from "../src/proactive-vault-auth.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("CAP-033 proactive loopback access token", () => {
  it("persists a stable owner-only token", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "aervox-proactive-auth-"));
    tempDirs.push(dir);
    const tokenPath = path.join(dir, "nested", "access.token");
    const first = await loadProactiveAccessToken({ tokenPath }, {});
    const second = await loadProactiveAccessToken({ tokenPath }, {});
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThanOrEqual(32);
    if (process.platform !== "win32") {
      expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects short configured tokens", async () => {
    await expect(loadProactiveAccessToken({ token: "too-short" }, {})).rejects.toThrow(
      "32-256 characters",
    );
  });
});
