import { describe, expect, it } from "vitest";
import { PostgresqlDatabaseOpenError, postgresqlPoolConfig } from "../src/driver/create-postgresql-database.js";

describe("PostgreSQL connection address and transport policy", () => {
  it("supports local sockets and loopback, with explicit verified TLS for local or remote TCP", () => {
    expect(postgresqlPoolConfig("postgresql://user@localhost/app").ssl).toBe(false);
    expect(postgresqlPoolConfig("postgresql://user@[::1]/app").ssl).toBe(false);
    expect(postgresqlPoolConfig("postgresql://user@localhost/app?host=%2Ftmp%2Faervox-pg&port=65437").ssl).toBe(false);
    expect(postgresqlPoolConfig("postgresql://user@localhost/app?sslmode=verify-full").ssl).toEqual({ rejectUnauthorized: true });
    const remote = postgresqlPoolConfig("postgresql://user:secret@database.example/app?sslmode=verify-full");
    expect(remote.ssl).toEqual({ rejectUnauthorized: true });
    expect(remote.connectionString).not.toContain("sslmode");
    expect(remote).toMatchObject({ max: 1, connectionTimeoutMillis: 5_000, query_timeout: 15_000, statement_timeout: 15_000, lock_timeout: 5_000, idle_in_transaction_session_timeout: 30_000 });
    expect(postgresqlPoolConfig("postgresql://user@database.example/app").ssl).toEqual({ rejectUnauthorized: true });
  });
  it.each(["disable", "prefer", "require", "verify-ca", "no-verify"])("rejects weakened remote TLS mode %s", mode => {
    expect(() => postgresqlPoolConfig(`postgresql://user@database.example/app?sslmode=${mode}`)).toThrow(expect.objectContaining({ reasonCode: "VERIFIED_REMOTE_TLS_REQUIRED" }));
  });
  it.each(["ssl=0", "sslcert=/private/file", "sslrootcert=/private/file", "uselibpqcompat=true", "query_timeout=0", "options=-c%20statement_timeout%3D0", "connectionString=postgresql%3A%2F%2Fother%2Fapp"])("prevents driver query option %s from overriding policy", options => {
    expect(() => postgresqlPoolConfig(`postgresql://user@database.example/app?${options}`)).toThrow(expect.objectContaining({ reasonCode: "CONNECTION_PARAMETER_UNSUPPORTED" }));
  });
  it.each([
    "postgresql://user@localhost/app?host=localhost&host=database.example&sslmode=disable",
    "postgresql://user@localhost/app?sslmode=verify-full&sslmode=disable",
    "postgresql://user@localhost/app?port=65437&port=5432",
  ])("rejects ambiguous duplicate address keys without leaking input %s", value => {
    expect(() => postgresqlPoolConfig(value)).toThrow(expect.objectContaining({ reasonCode: "CONNECTION_PARAMETER_DUPLICATED" }));
  });
  it.each(["http://user:password@localhost/app", "postgresql://user@localhost/app?host=", "postgresql://user@localhost/app?host=host1,host2", "postgresql://user@localhost/app?port=65437suffix", "postgresql://user@localhost/app?port=65536", "postgresql://user@localhost/app?port=0"])("rejects malformed connection addresses", value => {
    try { postgresqlPoolConfig(value); expect.fail("must reject invalid address"); }
    catch (error) { expect(error).toBeInstanceOf(PostgresqlDatabaseOpenError); expect(String(error)).not.toContain("password"); expect(String(error)).not.toContain(value); }
  });
});
