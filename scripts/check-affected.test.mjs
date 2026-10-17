import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

function runFixture(t, changedFiles, hasBase = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aervox-check-affected-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, "scripts"));
  for (const name of ["check-affected.mjs", "ci-scope.mjs"]) {
    fs.copyFileSync(path.join(scriptsDirectory, name), path.join(root, "scripts", name));
  }
  fs.writeFileSync(path.join(root, "turbo.json"), JSON.stringify({ tasks: {} }));
  const status = changedFiles.map((file) => ` M ${file}\0`).join("");
  fs.writeFileSync(path.join(bin, "git"), `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "rev-parse") process.exitCode = ${hasBase ? 0 : 1};
else if (args[0] === "status") process.stdout.write(${JSON.stringify(status)});
else if (args[0] !== "diff") process.exitCode = 1;
`, { mode: 0o755 });
  const calls = path.join(root, "calls.jsonl");
  for (const command of ["node", "pnpm", "mise"]) {
    fs.writeFileSync(path.join(bin, command), `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(command)}, ...process.argv.slice(2)]) + "\\n");
`, { mode: 0o755 });
  }
  const result = spawnSync(process.execPath, ["scripts/check-affected.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  return {
    output: result.stdout,
    calls: fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse) : [],
  };
}

test("纯项目文档改动不会启动代码守卫、Turbo 或 Cargo", { skip: process.platform === "win32" }, (t) => {
  const result = runFixture(t, ["plan.md", "docs/guide.md"]);
  assert.deepEqual(result.calls, []);
  assert.match(result.output, /跳过代码守卫、业务构建与原生编译/);
});

test("工具配置、锁文件和原生源码仍经过代码守卫与原生门禁", { skip: process.platform === "win32" }, (t) => {
  for (const file of ["mise.toml", "pnpm-lock.yaml", "native/crates/runtime/src/lib.rs"]) {
    const { calls } = runFixture(t, ["docs/guide.md", file]);
    assert.deepEqual(calls[0], ["pnpm", "check:guards"], file);
    assert.ok(calls.some((args) => args.includes("build") && args.includes("typecheck")), file);
    assert.ok(calls.some((args) => args[0] === "pnpm" && args.includes("test")), file);
    assert.ok(calls.some((args) => args[0] === "pnpm" && args.includes("check:standards")), file);
    assert.ok(calls.some((args) => args[0] === "pnpm" && args.includes("check:memory-deletion")), file);
    assert.ok(calls.some((args) => args[0] === "pnpm" && args.includes("check:deletion-fault-testing")), file);
    assert.deepEqual(calls.at(-1), ["mise", "tasks", "run", "native-search-check"], file);
  }
});

test("无法确定 Git 基准时保留全量回退，不把文档工作区视为完整差量", { skip: process.platform === "win32" }, (t) => {
  const { calls } = runFixture(t, ["plan.md"], false);
  assert.deepEqual(calls[0], ["pnpm", "check:guards"]);
  const build = calls.find((args) => args.includes("build"));
  assert.ok(build);
  assert.ok(build.every((arg) => !arg.startsWith("--filter")));
});
