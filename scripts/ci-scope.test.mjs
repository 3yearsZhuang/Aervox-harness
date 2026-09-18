#!/usr/bin/env node
/**
 * Aervox｜思隅 — CI / 增量门禁作用域回归测试。
 *
 * 覆盖三类缺陷（ITER-001）：
 * 1. 包外声明的 Turbo 输入变更时，本地增量过滤器会选中 0 个任务（假绿）；
 * 2. 根级共享配置未进入 Turbo 哈希，陈旧缓存被重放；
 * 3. 工作流触发路径与 Turbo 声明漂移，CI 侧根本不会重新验证。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  ROOT_DIR,
  buildTurboFilterArgs,
  collectRequiredCodePaths,
  findUncoveredPaths,
  globToRegExp,
  loadTurboScope,
  matchesGlob,
  normalizeDeclaredInput,
  readWorkflowPaths,
  resolveChangeScope,
} from "./ci-scope.mjs";

const CI_WORKFLOW = path.join(ROOT_DIR, ".github/workflows/ci.yml");
const DOCS_WORKFLOW = path.join(ROOT_DIR, ".github/workflows/docs.yml");
const MISE_CONFIG = path.join(ROOT_DIR, "mise.toml");

function syntheticScope() {
  return {
    globalDependencies: ["tsconfig.base.json", "tsconfig.base.node.json"],
    packageInputs: [{ pkg: "@aervox/api", task: "test", glob: "plugins/**", raw: "../../plugins/**" }],
    sharedInputs: [{ task: "test", glob: "vitest.shared.ts", raw: "../../vitest.shared.ts" }],
  };
}

test("glob 语义：`*` 不跨目录，`**` 跨目录且允许零层", () => {
  assert.equal(matchesGlob("plugins/anki-sync/plugin.manifest.json", "plugins/**"), true);
  assert.equal(matchesGlob("plugins/readme.md", "plugins/**"), true);
  assert.equal(matchesGlob("dist-plugins/x.aervox-plugin", "plugins/**"), false);
  assert.equal(matchesGlob("apps/api/src/app.ts", "packages/**"), false);
  assert.equal(matchesGlob("vitest.shared.ts", "vitest.shared.ts"), true);
  assert.equal(matchesGlob("nested/vitest.shared.ts", "vitest.shared.ts"), false);
  assert.equal(matchesGlob("docs/a/b/c.md", "docs/**/*.md"), true);
  assert.equal(matchesGlob("docs/c.md", "docs/**/*.md"), true);
  assert.equal(matchesGlob("plan.md", "*.md"), true);
  assert.equal(matchesGlob("docs/plan.md", "*.md"), false);
  assert.equal(matchesGlob("a+b/c.ts", "a+b/**"), true, "特殊字符需转义后按字面匹配");
  assert.equal(globToRegExp("plugins/**").source.startsWith("^"), true);
});

test("包内相对声明归一化为仓库根相对 glob", () => {
  assert.equal(normalizeDeclaredInput("../../plugins/**"), "plugins/**");
  assert.equal(normalizeDeclaredInput("../../vitest.shared.ts"), "vitest.shared.ts");
  assert.equal(normalizeDeclaredInput("src/**"), "src/**");
  assert.equal(normalizeDeclaredInput("./turbo.json"), "turbo.json");
});

test("loadTurboScope 只提取包目录之外的声明", () => {
  const scope = loadTurboScope();
  const apiPluginInput = scope.packageInputs.find((decl) => decl.glob === "plugins/**");
  assert.ok(apiPluginInput, "应识别 @aervox/api#test 的 ../../plugins/** 包外输入");
  assert.equal(apiPluginInput.pkg, "@aervox/api");
  assert.equal(apiPluginInput.task, "test");

  const shared = scope.sharedInputs.map((decl) => decl.glob);
  assert.ok(shared.includes("vitest.shared.ts"), "应识别共享输入 ../../vitest.shared.ts");

  const allGlobs = [
    ...scope.globalDependencies,
    ...scope.packageInputs.map((decl) => decl.glob),
    ...scope.sharedInputs.map((decl) => decl.glob),
  ];
  assert.equal(allGlobs.some((glob) => glob.startsWith("src/")), false, "包内输入不应出现在包外声明中");

  assert.ok(
    scope.globalDependencies.includes("tsconfig.base.json") &&
      scope.globalDependencies.includes("tsconfig.base.node.json"),
    "根级共享 tsconfig 必须进入 globalDependencies，否则改动不会使缓存失效",
  );
});

test("仅插件目录变更时命中声明它的包（而非选中 0 个任务）", () => {
  const changeScope = resolveChangeScope(["plugins/anki-sync/plugin.manifest.json"], syntheticScope());
  assert.equal(changeScope.mode, "scoped");
  assert.deepEqual(changeScope.packages, ["@aervox/api"]);
  assert.deepEqual(
    buildTurboFilterArgs("origin/main", changeScope),
    ["--filter=...[origin/main]", "--filter=@aervox/api..."],
  );
});

test("共享输入与根级依赖变更时收敛为全量，不按包收窄", () => {
  for (const changed of [["vitest.shared.ts"], ["tsconfig.base.json"], ["tsconfig.base.node.json"]]) {
    const changeScope = resolveChangeScope(changed, syntheticScope());
    assert.equal(changeScope.mode, "full", `${changed[0]} 变更应触发全量`);
    assert.deepEqual(buildTurboFilterArgs("origin/main", changeScope), []);
  }
});

test("仅包内变更时交给差异过滤器，不额外扩容", () => {
  const changeScope = resolveChangeScope(["apps/api/src/app.ts", "docs/README.md"], syntheticScope());
  assert.equal(changeScope.mode, "diff-only");
  assert.deepEqual(buildTurboFilterArgs("origin/main", changeScope), ["--filter=...[origin/main]"]);
});

test("无基准分支时退化为全量", () => {
  const changeScope = resolveChangeScope(["plugins/x/plugin.manifest.json"], syntheticScope());
  assert.deepEqual(buildTurboFilterArgs(null, changeScope), []);
});

test("readWorkflowPaths 能解析真实工作流的 pull_request 与 push 路径", () => {
  const ci = readWorkflowPaths(CI_WORKFLOW);
  assert.ok(Array.isArray(ci.pullRequest) && ci.pullRequest.length > 0, "ci.yml 应解析出 pull_request.paths");
  assert.ok(Array.isArray(ci.push) && ci.push.length > 0, "ci.yml 应解析出 push.paths");
  assert.ok(ci.pullRequest.includes("apps/**"));

  const docs = readWorkflowPaths(DOCS_WORKFLOW);
  assert.ok(Array.isArray(docs.pullRequest) && docs.pullRequest.length > 0, "docs.yml 应解析出 pull_request.paths");
  assert.ok(docs.pullRequest.includes("docs/**"));
});

test("CI 触发路径覆盖全部包外 Turbo 输入与根级依赖", () => {
  const ci = readWorkflowPaths(CI_WORKFLOW);
  const required = collectRequiredCodePaths(loadTurboScope());
  assert.ok(required.length > 0, "应至少声明一项包外输入");

  const gaps = findUncoveredPaths(ci.pullRequest, required);
  assert.deepEqual(
    gaps,
    [],
    `以下声明为验证输入但不会触发 CI：${gaps.join(", ")}（改 .github/workflows/ci.yml 的 paths）`,
  );
});

test("工作流的 pull_request 与 push 触发路径保持一致", () => {
  for (const workflow of [CI_WORKFLOW, DOCS_WORKFLOW]) {
    const paths = readWorkflowPaths(workflow);
    assert.deepEqual(
      [...paths.pullRequest].sort(),
      [...paths.push].sort(),
      `${path.basename(workflow)} 的 pull_request / push 路径漂移`,
    );
  }
});

test("Docs 触发路径覆盖文档门禁声明的 Markdown 范围与治理输入", () => {
  const docs = readWorkflowPaths(DOCS_WORKFLOW);

  // Markdown 范围直接从 `mise tasks run ci-docs` 的命令串解析，避免与门禁双源漂移。
  const ciDocsCommand = fs
    .readFileSync(MISE_CONFIG, "utf8")
    .split(/\r?\n/)
    .filter((line) => /^ci-docs\s*=/.test(line))
    .join("\n");
  const markdownScope = [...ciDocsCommand.matchAll(/'([^']*\.md)'/g)].map((match) => match[1]);
  assert.ok(markdownScope.length > 0, "应从 mise ci-docs 解析出 Markdown 检查范围");

  const governanceInputs = [
    ".markdownlint-cli2.jsonc",
    ".lycheeignore",
    ".vale.ini",
    ".vale/**",
    "scripts/docs-governance.mjs",
    "scripts/docs-lint-affected.mjs",
    "scripts/plan-queue.mjs",
    "scripts/plan-queue.test.mjs",
    "docs/_meta/plan-queue.json",
    "mise.toml",
  ];

  const gaps = findUncoveredPaths(docs.pullRequest, [...new Set([...markdownScope, ...governanceInputs])]);
  assert.deepEqual(gaps, [], `Docs 触发路径未覆盖：${gaps.join(", ")}`);
});

test("无法解析路径声明时按失败处理（fail-closed）", () => {
  assert.deepEqual(findUncoveredPaths(null, ["plugins/**"]), ["plugins/**"]);
  assert.deepEqual(findUncoveredPaths([], ["plugins/**"]), ["plugins/**"]);
});
