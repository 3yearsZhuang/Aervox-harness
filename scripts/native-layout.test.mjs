import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { loadTurboScope, resolveChangeScope, ROOT_DIR, readWorkflowPaths, findUncoveredPaths } from "./ci-scope.mjs";
import { join } from "node:path";

/**
 * 读取 turbo 任务图（`--dry=json`）。
 *
 * 为什么合并成一次调用：`--dry=json` 的输出约 78% 是每个任务的 `inputs` 文件哈希
 * 清单，而本文件只用到 `taskId` / `outputs` / `dependencies`。此前按包分别查询
 * 4 次、每次都拉取数百 KB 机器之外的数据，在 windows-latest 上 `spawnSync`
 * 经 cmd.exe 调用 pnpm.cmd 时会撞上 30s 超时（`@aervox/api` 单次输出 358KB 最大，
 * 正是 CI 实测超时的那一次）。
 *
 * 一次多 `--filter` 查询返回各包任务的并集，每个包的 `#test` 任务与其
 * `native:build` 依赖均保留，断言语义不变，进程数与传输量都下降。
 */
function taskGraph(task, packages) {
  const filters = packages.flatMap(pkg => ["--filter", pkg]);
  const output = execFileSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", ["exec", "turbo", "run", task, ...filters, "--dry=json"], {
    cwd: ROOT_DIR, encoding: "utf8", timeout: 60_000, shell: process.platform === "win32", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(output).tasks;
}

test("ordinary repository build stays TypeScript-only; integration tests explicitly build native artifacts", () => {
  const build = taskGraph("build", ["@aervox/repositories"]);
  assert.ok(build.some(task => task.taskId === "@aervox/native-runtime#build"));
  assert.ok(build.every(task => !task.taskId.endsWith("#native:build")));

  const consumers = ["@aervox/native-runtime", "@aervox/repositories", "@aervox/api"];
  const graph = taskGraph("test", consumers);
  for (const pkg of consumers) {
    const nativeBuild = graph.find(task => task.taskId === "@aervox/native-runtime#native:build");
    assert.ok(nativeBuild, `${pkg} tests must build the production native runtime`);
    assert.deepEqual(nativeBuild.outputs, ["dist/bin/**"]);
    assert.ok(graph.find(task => task.taskId === `${pkg}#test`)?.dependencies.includes(nativeBuild.taskId),
      `${pkg} tests must wait for native artifacts, not merely run alongside native:build`);
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
