import { afterEach, describe, expect, it } from "vitest";
import {
  assertLocalSqliteUrl,
  createProactiveVaultDatabase,
  resolveProactiveVaultUrl,
} from "../src/client.js";

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalVaultUrl = process.env.AERVOX_PROACTIVE_VAULT_URL;

afterEach(() => {
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (originalVaultUrl === undefined) delete process.env.AERVOX_PROACTIVE_VAULT_URL;
  else process.env.AERVOX_PROACTIVE_VAULT_URL = originalVaultUrl;
});

describe("CAP-033 proactive vault connection boundary", () => {
  it("accepts only local SQLite paths", () => {
    expect(() => assertLocalSqliteUrl("file:/tmp/aervox-proactive.db")).not.toThrow();
    expect(() => assertLocalSqliteUrl("relative/proactive.db")).not.toThrow();
    expect(() => assertLocalSqliteUrl("libsql://example.turso.io/proactive")).toThrow(
      "requires a local SQLite file URL",
    );
    expect(() => assertLocalSqliteUrl("https://example.invalid/proactive.db")).toThrow(
      "requires a local SQLite file URL",
    );
    expect(() => assertLocalSqliteUrl("libsql:example.turso.io/proactive")).toThrow(
      "requires a local SQLite file URL",
    );
    expect(() => assertLocalSqliteUrl("file://fileserver/share/proactive.db")).toThrow(
      "requires a local SQLite file URL",
    );
  });

  it("does not inherit a remote main DATABASE_URL", () => {
    process.env.DATABASE_URL = "libsql://example.turso.io/main";
    delete process.env.AERVOX_PROACTIVE_VAULT_URL;
    expect(resolveProactiveVaultUrl()).toContain("proactive-vault.db");
    expect(resolveProactiveVaultUrl()).not.toContain("example.turso.io");
  });

  it("rejects a remote proactive vault before opening a connection", async () => {
    await expect(
      createProactiveVaultDatabase({ url: "https://example.invalid/proactive.db" }),
    ).rejects.toThrow("requires a local SQLite file URL");
  });
});
