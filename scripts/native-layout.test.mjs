import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { loadTurboScope, resolveChangeScope, ROOT_DIR, readWorkflowPaths, findUncoveredPaths } from "./ci-scope.mjs";
import { join } from "node:path";

function taskGraph(task, pkg) {
  const output = execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "turbo", "run", task, `--filter=${pkg}`, "--dry=json"], {
    cwd: ROOT_DIR, encoding: "utf8", timeout: 30_000, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output).tasks;
}

test("ordinary repository build stays TypeScript-only; integration tests explicitly build native artifacts", () => {
  const build = taskGraph("build", "@aervox/repositories");
  assert.ok(build.some(task => task.taskId === "@aervox/native-runtime#build"));
  assert.ok(build.every(task => !task.taskId.endsWith("#native:build")));
  for (const pkg of ["@aervox/native-runtime", "@aervox/repositories"]) {
    assert.ok(taskGraph("test", pkg).some(task => task.taskId === "@aervox/native-runtime#native:build"));
  }
});

test("out-of-package Rust and IPC changes select native consumers and all CI entrypoints", () => {
  const files = ["native/crates/runtime/src/vector/mod.rs", "native/tools/vector-pilot/src/main.rs", "native/Cargo.lock", "native/protocol/runtime.json", "scripts/build-native-runtime.mjs", "scripts/generate-native-protocol.mjs"];
  for (const file of files) {
    const scope = resolveChangeScope([file], loadTurboScope());
    assert.equal(scope.mode, "scoped", file);
    assert.ok(scope.packages.includes("@aervox/native-runtime"), file);
  }
  for (const name of ["ci", "native-runtime"]) {
    const paths = readWorkflowPaths(join(ROOT_DIR, `.github/workflows/${name}.yml`));
    assert.deepEqual(findUncoveredPaths(paths.pullRequest, files), [], name);
    assert.deepEqual(findUncoveredPaths(paths.push, files), [], name);
  }
});
