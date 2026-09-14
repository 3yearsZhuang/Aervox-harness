/**
 * Aervox｜思隅文档治理门禁自测（Node.js test runner）。
 * 运行：node --test scripts/docs-governance.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePorcelainStatus } from "./docs-governance.mjs";

test("porcelain 普通状态保留完整路径首字符与空格", () => {
  const output = [
    " M apps/worker/src/index.ts",
    "?? docs/reference/new document.md",
  ].join("\0") + "\0";

  assert.deepEqual(parsePorcelainStatus(output), [
    "apps/worker/src/index.ts",
    "docs/reference/new document.md",
  ]);
});

test("porcelain 重命名状态同时返回新旧路径", () => {
  const output = "R  docs/reference/new-name.md\0docs/reference/old-name.md\0";

  assert.deepEqual(parsePorcelainStatus(output), [
    "docs/reference/new-name.md",
    "docs/reference/old-name.md",
  ]);
});

test("porcelain 去重并忽略空记录", () => {
  const output = " M docs/README.md\0 M docs/README.md\0\0";

  assert.deepEqual(parsePorcelainStatus(output), ["docs/README.md"]);
});
