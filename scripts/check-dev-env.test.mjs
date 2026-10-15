/**
 * dev 入口的环境变量交付守卫。
 *
 * `./aervox dev` 会先 source `.env` 再把配置交给 `turbo run dev`；turbo 默认的 strict 环境模式
 * 只把 `globalEnv`、`globalPassThroughEnv` 与任务级 `env`／`passThroughEnv` 声明的变量交给任务，
 * 其余变量被静默剥离。缺少声明时表现为：`.env` 里配好的模型密钥、鉴权模式或主动画像 Token
 * 路径在 dev 进程里全部失效，进程退回内置默认值，且没有任何报错。
 *
 * 本守卫要求 `.env.example` 记录的每个键至少对 dev 任务可见，避免交付名单随配置新增而漂移。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** `.env.example` 中出现的全部键，含被注释的可选项。 */
export function documentedEnvKeys(examplePath = path.join(repositoryRoot, ".env.example")) {
  const keys = new Set();
  for (const line of fs.readFileSync(examplePath, "utf8").split(/\r?\n/)) {
    const match = /^\s*#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (match) keys.add(match[1]);
  }
  return keys;
}

/** turbo.json 中会交付给 dev 任务的变量集合。 */
export function devDeliveredEnvKeys(turboPath = path.join(repositoryRoot, "turbo.json")) {
  const turbo = JSON.parse(fs.readFileSync(turboPath, "utf8"));
  return new Set([
    ...(turbo.globalEnv ?? []),
    ...(turbo.globalPassThroughEnv ?? []),
    ...(turbo.tasks?.dev?.passThroughEnv ?? []),
  ]);
}

test(".env.example 的每个键都对 dev 任务可见", () => {
  const delivered = devDeliveredEnvKeys();
  const missing = [...documentedEnvKeys()].filter((key) => !delivered.has(key)).sort();
  assert.deepEqual(missing, [], `以下键没有交付给 dev 任务，需补进 turbo.json 的 dev.passThroughEnv：${missing.join("、")}`);
});

test("dev 任务的 passThroughEnv 没有重复声明", () => {
  const declared = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, "turbo.json"), "utf8"),
  ).tasks?.dev?.passThroughEnv ?? [];
  const duplicated = declared.filter((key, index) => declared.indexOf(key) !== index);
  assert.deepEqual([...new Set(duplicated)], [], `dev.passThroughEnv 存在重复键：${duplicated.join("、")}`);
});
