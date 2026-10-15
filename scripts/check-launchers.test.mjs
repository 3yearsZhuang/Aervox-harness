import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = new URL("../", import.meta.url);
for (const launcher of ["aervox", "siyu-chat.command"]) {
  test(`${launcher}: valid shell syntax`, () => {
    const run = spawnSync("bash", ["-n", new URL(launcher, root).pathname], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
  });
}
test("CLI wrappers preserve quoted arguments when dispatching to aervox", () => {
  const dir = mkdtempSync(join(tmpdir(), "aervox-launcher-"));
  try {
    for (const file of ["siyu-chat.command"]) {
      copyFileSync(new URL(file, root), join(dir, file));
      chmodSync(join(dir, file), 0o755);
    }
    writeFileSync(join(dir, "aervox"), '#!/usr/bin/env bash\nprintf "%s\\0" "$@" > args\n', { mode: 0o755 });
    for (const file of ["siyu-chat.command"]) {
      const run = spawnSync("bash", [join(dir, file), "two words", "--flag"], { encoding: "utf8" });
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(readFileSync(join(dir, "args"), "utf8").split("\0"), ["dev", "cli", "two words", "--flag", ""]);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("aervox help works from an unrelated working directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "aervox-help-"));
  try {
    copyFileSync(new URL("aervox", root), join(dir, "aervox"));
    const run = spawnSync("bash", [join(dir, "aervox"), "--help"], { cwd: tmpdir(), encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /aervox <命令>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
