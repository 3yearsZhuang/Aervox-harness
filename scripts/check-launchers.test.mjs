import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, writeFileSync, chmodSync, rmSync, readFileSync, mkdirSync, existsSync } from "node:fs";
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
    mkdirSync(join(dir, "scripts"));
    copyFileSync(new URL("scripts/project-env.sh", root), join(dir, "scripts/project-env.sh"));
    const run = spawnSync("bash", [join(dir, "aervox"), "--help"], { cwd: tmpdir(), encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /aervox <命令>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function withTestWorkspaces(check) {
  const dir = mkdtempSync(join(tmpdir(), "aervox-test-target-"));
  try {
    copyFileSync(new URL("aervox", root), join(dir, "aervox"));
    mkdirSync(join(dir, "scripts"));
    for (const file of ["test-package.mjs", "workspaces.mjs", "project-env.sh"]) {
      copyFileSync(new URL(`scripts/${file}`, root), join(dir, "scripts", file));
    }
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "test-root", private: true, scripts: { test: "node test.mjs" } }));
    writeFileSync(join(dir, "test.mjs"), "import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./ran', import.meta.url), 'ran');\n");
    writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "apps/*"\n  - "packages/*"\n  - "plugins/*"\n  - "surfaces/*"\n');
    for (const [relDir, name, exitCode] of [
      ["apps/api", "@aervox/api", 0],
      ["packages/repositories", "@aervox/repositories", 0],
      ["surfaces/companion-ui", "@aervox/plugin-companion-ui", 0],
      ["plugins/focus-mode", "@aervox/plugin-focus-mode", 0],
      ["apps/mobile", "@aervox/mobile", null],
      ["apps/failing", "@aervox/failing", 23],
    ]) {
      mkdirSync(join(dir, relDir), { recursive: true });
      writeFileSync(join(dir, relDir, "package.json"), JSON.stringify({
        name, private: true, scripts: exitCode === null ? {} : { test: "node test.mjs" },
      }));
      writeFileSync(join(dir, relDir, "test.mjs"), `import { writeFileSync } from 'node:fs';\nwriteFileSync(new URL('./ran', import.meta.url), 'ran');\nprocess.exit(${exitCode ?? 0});\n`);
    }
    mkdirSync(join(dir, "bin"));
    // The outer test already uses the locked toolchain. Keep fixture dispatch
    // local instead of activating or installing tools in the temporary repo.
    writeFileSync(join(dir, "bin", "mise"), '#!/bin/sh\n[ "$1" = exec ] || exit 99\nshift\n[ "$1" = -- ] && shift\nexec "$@"\n', { mode: 0o755 });
    const run = target => spawnSync("bash", [join(dir, "aervox"), "test", target], {
      cwd: tmpdir(), encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
    });
    check({ dir, run });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("aervox test resolves manifest names for application, surface and plugin short names", () => {
  withTestWorkspaces(({ dir, run }) => {
    for (const [target, relDir] of [
      ["api", "apps/api"],
      ["repos", "packages/repositories"],
      ["companion-ui", "surfaces/companion-ui"],
      ["focus-mode", "plugins/focus-mode"],
      ["@aervox/plugin-companion-ui", "surfaces/companion-ui"],
      ["./surfaces/companion-ui", "surfaces/companion-ui"],
    ]) {
      const result = run(target);
      assert.equal(result.status, 0, `${target}: ${result.stdout}\n${result.stderr}`);
      assert.ok(existsSync(join(dir, relDir, "ran")), `${target} must execute its test`);
      rmSync(join(dir, relDir, "ran"));
    }
  });
});

test("aervox test preserves pnpm selectors and runs every selected test", () => {
  withTestWorkspaces(({ dir, run }) => {
    const result = run("@aervox/plugin-*");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(join(dir, "surfaces/companion-ui/ran")));
    assert.ok(existsSync(join(dir, "plugins/focus-mode/ran")));
    assert.equal(existsSync(join(dir, "apps/api/ran")), false);
  });
});

test("aervox test preserves root package selectors and reads its real manifest name", () => {
  withTestWorkspaces(({ dir, run }) => {
    for (const target of [".", "test-root"]) {
      const result = run(target);
      assert.equal(result.status, 0, `${target}: ${result.stdout}\n${result.stderr}`);
      assert.ok(existsSync(join(dir, "ran")), `${target} must execute the root test`);
      assert.equal(existsSync(join(dir, "apps/api/ran")), false);
      rmSync(join(dir, "ran"));
    }
  });
});

test("aervox test rejects unmatched targets and packages without test scripts", () => {
  withTestWorkspaces(({ dir, run }) => {
    for (const target of ["unknown", "@aervox/missing-*", "mobile"]) {
      const result = run(target);
      assert.notEqual(result.status, 0, `${target} must not report success`);
      assert.doesNotMatch(result.stdout, /测试完成/);
    }
    assert.equal(existsSync(join(dir, "apps/mobile/ran")), false);
    assert.equal(existsSync(join(dir, "apps/api/ran")), false);
  });
});

test("aervox test propagates a selected test failure", () => {
  withTestWorkspaces(({ dir, run }) => {
    const result = run("failing");
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.ok(existsSync(join(dir, "apps/failing/ran")));
    assert.doesNotMatch(result.stdout, /测试完成/);
  });
});
