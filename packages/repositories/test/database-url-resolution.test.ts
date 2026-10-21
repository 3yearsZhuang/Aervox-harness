import { describe, it, expect } from "vitest";
import path from "node:path";
import { resolveDatabaseUrl } from "../src/client.js";
import { defaultDataDirectory, repositoryRoot } from "../src/data-directory.js";

describe("resolveDatabaseUrl", () => {
  it("resolves bare aervox.db and file:aervox.db to defaultDataDirectory", () => {
    const expected = `file:${path.join(defaultDataDirectory(), "aervox.db")}`;
    expect(resolveDatabaseUrl("aervox.db")).toBe(expected);
    expect(resolveDatabaseUrl("file:aervox.db")).toBe(expected);
    expect(resolveDatabaseUrl("./aervox.db")).toBe(expected);
    expect(resolveDatabaseUrl("file:./aervox.db")).toBe(expected);
  });

  it("resolves data/aervox.db and file:data/aervox.db to repo data directory", () => {
    const expected = `file:${path.join(repositoryRoot, "data", "aervox.db")}`;
    expect(resolveDatabaseUrl("data/aervox.db")).toBe(expected);
    expect(resolveDatabaseUrl("file:data/aervox.db")).toBe(expected);
    expect(resolveDatabaseUrl("./data/aervox.db")).toBe(expected);
    expect(resolveDatabaseUrl("file:./data/aervox.db")).toBe(expected);
  });

  it("preserves absolute paths", () => {
    const absPath = "/var/lib/aervox/custom.db";
    expect(resolveDatabaseUrl(absPath)).toBe(`file:${absPath}`);
    expect(resolveDatabaseUrl(`file:${absPath}`)).toBe(`file:${absPath}`);
  });

  it("preserves remote URLs", () => {
    expect(resolveDatabaseUrl("libsql://mydb.turso.io")).toBe("libsql://mydb.turso.io");
    expect(resolveDatabaseUrl("https://example.com/db")).toBe("https://example.com/db");
  });
});
