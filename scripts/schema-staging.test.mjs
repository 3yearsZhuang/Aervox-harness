import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMigrationArguments } from "./schema-staging.mjs";
const args = ["--source", "/tmp/source.db", "--staging", "/tmp/staging.db", "--rollback", "/tmp/rollback.db", "--backup", "/tmp/backup", "--stopped"];
test("staging migration never infers a source, destination or stopped runtime", () => {
  assert.throws(() => parseMigrationArguments([]), /--stopped/);
  assert.throws(() => parseMigrationArguments(args.slice(0,-1)), /--stopped/);
  assert.throws(() => parseMigrationArguments(["--stopped", "--source", "data/aervox.db"]), /absolute path/);
  assert.throws(() => parseMigrationArguments([...args, "--source", "/tmp/other.db"]), /duplicate/);
  assert.throws(() => parseMigrationArguments([...args, "--scope", "vault"]), /main or ledger/);
  assert.throws(() => parseMigrationArguments([...args, "--scope", "--unknown"]), /missing/);
});
test("source and staging identities cannot overlap and valid arguments preserve paths", () => {
  assert.throws(() => parseMigrationArguments(args.map(value => value === "/tmp/staging.db" ? "/tmp/source.db" : value)), /must differ/);
  assert.deepEqual(parseMigrationArguments(args), { sourcePath: "/tmp/source.db", stagingPath: "/tmp/staging.db", rollbackPath: "/tmp/rollback.db", backupDirectory: "/tmp/backup", scope: "main" });
});
