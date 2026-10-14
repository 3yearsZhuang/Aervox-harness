import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { DrizzleQueryError } from "drizzle-orm";
import { sqliteErrorDetails } from "../src/sqlite-errors.js";
import { isSqliteBusyError, isSqliteConnectionPoisonedError } from "../src/write-retry.js";

describe("Drizzle driver error classification", () => {
  it("ESM and CJS errors keep SQL parameters out of message, stack and JSON", () => {
    const cjs = createRequire(import.meta.url)("drizzle-orm") as { DrizzleQueryError: typeof DrizzleQueryError };
    for (const QueryError of [DrizzleQueryError, cjs.DrizzleQueryError]) {
      const error = new QueryError("insert secret_column", ["private-api-key"], new Error("constraint failed"));
      expect(error.message).toBe("Database query failed");
      expect(error.stack).not.toContain("private-api-key");
      expect(JSON.stringify(error)).not.toContain("private-api-key");
      expect(JSON.stringify(error)).not.toContain("secret_column");
      expect(error.cause).toBeInstanceOf(Error);
    }
  });
  it("recognizes wrapped busy/poisoned connections and constraint codes", () => {
    const busy = new DrizzleQueryError("insert", [], new Error("SQLITE_BUSY: database is locked"));
    expect(isSqliteBusyError(busy)).toBe(true);
    const poisoned = new DrizzleQueryError("commit", [], new Error("SQLITE_BUSY: SQL statements in progress"));
    expect(isSqliteBusyError(poisoned)).toBe(false);
    expect(isSqliteConnectionPoisonedError(poisoned)).toBe(true);
    const constraint = Object.assign(new Error("UNIQUE constraint failed: leases.device_id"), { code: "SQLITE_CONSTRAINT_UNIQUE" });
    expect(sqliteErrorDetails(new DrizzleQueryError("insert", [], constraint))).toEqual({ code: constraint.code, message: constraint.message });
  });
  it("does not classify user parameter text as the driver failure", () => {
    const error = new DrizzleQueryError("insert", ["database is locked"], new Error("NOT NULL constraint failed"));
    expect(isSqliteBusyError(error)).toBe(false);
  });
});
