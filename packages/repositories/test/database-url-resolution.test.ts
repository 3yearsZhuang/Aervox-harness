import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createDatabase, resolveDatabaseUrl } from "../src/client.js";
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


describe("database URL connection semantics", () => {
  it.each([":memory:", "file::memory:", "file::memory:?cache=private"])("keeps %s in memory", async (url) => {
    expect(resolveDatabaseUrl(url)).toBe(url);
    const { client } = await createDatabase({ url });
    try {
      const databases = await client.execute("PRAGMA database_list");
      expect(databases.rows[0]?.file).toBe("");
      await client.execute("CREATE TABLE memory_only (id INTEGER)");
    } finally {
      client.close();
    }
  });

  it("preserves absolute file URI authorities so libsql validates the host", async () => {
    const invalid = "file://remote.invalid/tmp/should-not-exist.db";
    expect(resolveDatabaseUrl(invalid)).toBe(invalid);
    await expect(createDatabase({ url: invalid })).rejects.toThrow();
  });

  it("opens encoded file URLs at the decoded filesystem path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "aervox-url-"));
    const file = path.join(dir, "nested space", "db #1.sqlite");
    const url = pathToFileURL(file).href;
    const localAuthorityUrl = url.replace("file://", "file://localhost");
    const { client } = await createDatabase({ url: localAuthorityUrl });
    try {
      await client.execute("CREATE TABLE chosen_file (id INTEGER)");
      expect(existsSync(file)).toBe(true);
      expect(existsSync(path.join(dir, "nested%20space"))).toBe(false);
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("escapes bare paths and preserves encoded relative file paths and query parameters", () => {
    const expected = `file:${pathToFileURL(path.resolve(repositoryRoot, "custom dir/db #1.sqlite")).pathname}`;
    expect(resolveDatabaseUrl("custom dir/db #1.sqlite")).toBe(expected);
    expect(resolveDatabaseUrl("file:custom%20dir/db%20%231.sqlite")).toBe(expected);
    expect(resolveDatabaseUrl("file:custom%20dir/db.sqlite?tls=0")).toBe(
      `file:${pathToFileURL(path.resolve(repositoryRoot, "custom dir/db.sqlite")).pathname}?tls=0`,
    );
  });
});


it("rejects encoded path separators consistently for relative and absolute SQLite URIs", () => {
  for (const url of ["file:custom%2Fname.db", "file:/tmp/custom%2fname.db", "file:custom%2fname.db?tls=0"]) {
    expect(() => resolveDatabaseUrl(url)).toThrow(/encoded path separators/);
  }
  if (process.platform !== "win32") {
    expect(resolveDatabaseUrl("file:custom%5Cname.db")).toBe(
      `file:${pathToFileURL(path.resolve(repositoryRoot, "custom\\name.db")).pathname}`,
    );
  } else {
    expect(() => resolveDatabaseUrl("file:custom%5Cname.db")).toThrow(/encoded path separators/);
  }
});
