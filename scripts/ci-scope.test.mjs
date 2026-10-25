#!/usr/bin/env node
/**
 * Aervox｜思隅 — CI / 增量门禁作用域回归测试。
 *
 * 覆盖三类缺陷：
 * 1. 包外声明的 Turbo 输入变更时，本地增量过滤器会选中 0 个任务（假绿）；
 * 2. 根级共享配置未进入 Turbo 哈希，陈旧缓存被重放；
 * 3. 工作流触发路径与 Turbo 声明漂移，CI 侧根本不会重新验证。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { workspacePatterns } from './workspaces.mjs';
import { DOCUMENTATION_TARGETS, DOCUMENTATION_TOOL_DIRECTORY } from './docs-config.mjs';
import {
  ROOT_DIR,
  buildTurboFilterArgs,
  collectRequiredCodePaths,
  findUncoveredPaths,
  globToRegExp,
  isDocumentationOnlyChange,
  loadTurboScope,
  matchesGlob,
  normalizeDeclaredInput,
  readWorkflowPaths,
  resolveChangeScope,
} from "./ci-scope.mjs";

const CI_WORKFLOW = path.join(ROOT_DIR, ".github/workflows/ci.yml");
const DOCS_WORKFLOW = path.join(ROOT_DIR, ".github/workflows/docs.yml");
const MISE_CONFIG = path.join(ROOT_DIR, "mise.toml");

test("CI covers every package root declared in pnpm-workspace.yaml", () => {
  const roots = workspacePatterns(ROOT_DIR).map(pattern => pattern.replace(/\/\*$/, ''));
  assert.ok(roots.includes("surfaces"));
  const paths = readWorkflowPaths(CI_WORKFLOW);
  for (const trigger of [paths.pullRequest, paths.push]) {
    for (const root of roots) {
      const example = `${root}/example/src/index.ts`;
      assert.ok(trigger.some(glob => matchesGlob(example, glob)), `CI does not cover ${example}`);
    }
  }
});

function syntheticScope() {
  return {
    globalDependencies: ["tooling/tsconfig.base.json", "tooling/tsconfig.base.node.json"],
    packageInputs: [{ pkg: "@aervox/api", task: "test", glob: "plugins/**", raw: "../../plugins/**" }],
    sharedInputs: [{ task: "test", glob: "tooling/vitest.shared.ts", raw: "../../tooling/vitest.shared.ts" }],
  };
}

test("glob 语义：`*` 不跨目录，`**` 跨目录且允许零层", () => {
  assert.equal(matchesGlob("plugins/anki-sync/plugin.manifest.json", "plugins/**"), true);
  assert.equal(matchesGlob("plugins/readme.md", "plugins/**"), true);
  assert.equal(matchesGlob("dist/plugins/x.aervox-plugin", "plugins/**"), false);
  assert.equal(matchesGlob("apps/api/src/app.ts", "packages/**"), false);
  assert.equal(matchesGlob("tooling/vitest.shared.ts", "tooling/vitest.shared.ts"), true);
  assert.equal(matchesGlob("nested/tooling/vitest.shared.ts", "tooling/vitest.shared.ts"), false);
  assert.equal(matchesGlob("docs/a/b/c.md", "docs/**/*.md"), true);
  assert.equal(matchesGlob("docs/c.md", "docs/**/*.md"), true);
  assert.equal(matchesGlob("plan.md", "*.md"), true);
  assert.equal(matchesGlob("docs/plan.md", "*.md"), false);
  assert.equal(matchesGlob("a+b/c.ts", "a+b/**"), true, "特殊字符需转义后按字面匹配");
  assert.equal(globToRegExp("plugins/**").source.startsWith("^"), true);
});

test("包内相对声明归一化为仓库根相对 glob", () => {
  assert.equal(normalizeDeclaredInput("../../plugins/**"), "plugins/**");
  assert.equal(normalizeDeclaredInput("../../tooling/vitest.shared.ts"), "tooling/vitest.shared.ts");
  assert.equal(normalizeDeclaredInput("src/**"), "src/**");
  assert.equal(normalizeDeclaredInput("./turbo.json"), "turbo.json");
});

test("loadTurboScope 只提取包目录之外的声明", () => {
  const scope = loadTurboScope();
  const apiPluginInput = scope.packageInputs.find((decl) => decl.glob === "plugins/**" && decl.pkg === "@aervox/api");
  assert.ok(apiPluginInput, "应识别 @aervox/api#test 的 ../../plugins/** 包外输入");
  assert.equal(apiPluginInput.pkg, "@aervox/api");
  assert.equal(apiPluginInput.task, "test");

  const shared = scope.sharedInputs.map((decl) => decl.glob);
  assert.ok(shared.includes("tooling/vitest.shared.ts"), "应识别共享输入 ../../tooling/vitest.shared.ts");

  const allGlobs = [
    ...scope.globalDependencies,
    ...scope.packageInputs.map((decl) => decl.glob),
    ...scope.sharedInputs.map((decl) => decl.glob),
  ];
  assert.equal(allGlobs.some((glob) => glob.startsWith("src/")), false, "包内输入不应出现在包外声明中");

  assert.ok(
    scope.globalDependencies.includes("tooling/tsconfig.base.json") &&
      scope.globalDependencies.includes("tooling/tsconfig.base.node.json"),
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

test("桌面主进程桥接变更会重新验证 API 会话落库验收", () => {
  const scope = loadTurboScope();
  for (const file of [
    "apps/desktop/src/main/turn-bridge.ts",
    "apps/desktop/src/main/runtime-config.ts",
  ]) {
    const changeScope = resolveChangeScope([file], scope);
    assert.equal(changeScope.mode, "scoped", file);
    assert.ok(changeScope.packages.includes("@aervox/api"), `${file} must invalidate API acceptance`);
    assert.ok(buildTurboFilterArgs("origin/main", changeScope).includes("--filter=@aervox/api..."));
  }
});

test("共享输入与根级依赖变更时收敛为全量，不按包收窄", () => {
  for (const scope of [syntheticScope(), loadTurboScope()]) {
    for (const changed of [["tooling/vitest.shared.ts"], ["tooling/tsconfig.base.json"], ["tooling/tsconfig.base.node.json"]]) {
      const changeScope = resolveChangeScope(changed, scope);
      assert.equal(changeScope.mode, "full", `${changed[0]} 变更应触发全量`);
      assert.deepEqual(buildTurboFilterArgs("origin/main", changeScope), []);
    }
  }
});

test("仅包内变更时交给差异过滤器，不额外扩容", () => {
  const changeScope = resolveChangeScope(["apps/api/src/app.ts", "docs/README.md"], syntheticScope());
  assert.equal(changeScope.mode, "diff-only");
  assert.deepEqual(buildTurboFilterArgs("origin/main", changeScope), ["--filter=...[origin/main]"]);
});

test("纯项目文档跳过代码检查，工具配置、锁文件和产品 Markdown 仍验证", () => {
  const scope = syntheticScope();
  assert.equal(isDocumentationOnlyChange(["docs/guide.md", "plan.md", "README.md"], scope), true);
  assert.equal(isDocumentationOnlyChange(["tooling/docs/.vale.ini", "tooling/docs/styles/Project/Terms.yml"], scope), true);
  for (const file of [
    "mise.toml", "package.json", "pnpm-lock.yaml", "turbo.json", "tooling/vitest.shared.ts",
    "native/Cargo.lock", "native/crates/runtime/src/lib.rs", "plugins/example/SKILL.md",
    "apps/api/src/app.ts", "scripts/check-affected.mjs", "scripts/docs-config.mjs",
  ]) {
    assert.equal(isDocumentationOnlyChange(["docs/guide.md", file], scope), false, file);
  }
  scope.packageInputs.push({ pkg: "@aervox/api", task: "test", glob: "docs/fixtures/**" });
  assert.equal(isDocumentationOnlyChange(["docs/fixtures/input.md"], scope), false, "显式 Turbo 输入优先");
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

test("项目文档只触发 Docs，工具链与原生输入仍触发代码工作流", () => {
  for (const workflow of [CI_WORKFLOW, path.join(ROOT_DIR, ".github/workflows/native-runtime.yml")]) {
    const paths = readWorkflowPaths(workflow).pullRequest;
    for (const file of ["docs/guide.md", "README.md", "plan.md",
      `${DOCUMENTATION_TOOL_DIRECTORY}/.markdownlint-cli2.jsonc`, `${DOCUMENTATION_TOOL_DIRECTORY}/.vale.ini`,
      `${DOCUMENTATION_TOOL_DIRECTORY}/styles/Project/Terms.yml`]) {
      assert.equal(paths.some((pattern) => matchesGlob(file, pattern)), false, file);
    }
    for (const file of ["mise.toml", "pnpm-lock.yaml", "native/Cargo.lock"]) {
      assert.equal(paths.some((pattern) => matchesGlob(file, pattern)), true, file);
    }
  }
});

test("Docs 触发路径覆盖文档门禁声明的 Markdown 范围与治理输入", () => {
  const docs = readWorkflowPaths(DOCS_WORKFLOW);

  const markdownScope = DOCUMENTATION_TARGETS.map(target => target.endsWith(".md") ? target : target + "/**");
  const governanceInputs = [
    DOCUMENTATION_TOOL_DIRECTORY + "/**", "scripts/docs-*.mjs", "mise.toml", ".github/workflows/docs.yml",
  ];
  const workflow = fs.readFileSync(DOCS_WORKFLOW, "utf8");
  assert.match(workflow, /mise exec -- node scripts\/docs-config\.mjs --github-output/);
  assert.ok(workflow.includes("steps.docs_links.outputs.args"), "Link checker must consume the shared generated targets");
  const config = fs.readFileSync(MISE_CONFIG, "utf8");
  assert.match(config, /ci-docs = "node --test scripts\/docs-\*\.test\.mjs && node scripts\/docs-check\.mjs"/);
  assert.match(config, /docs-lint-prose = "node scripts\/docs-check\.mjs --prose"/);

  const gaps = findUncoveredPaths(docs.pullRequest, [...new Set([...markdownScope, ...governanceInputs])]);
  assert.deepEqual(gaps, [], `Docs 触发路径未覆盖：${gaps.join(", ")}`);
  assert.deepEqual(findUncoveredPaths(docs.push, [...markdownScope, ...governanceInputs]), []);
});

test("无法解析路径声明时按失败处理（fail-closed）", () => {
  assert.deepEqual(findUncoveredPaths(null, ["plugins/**"]), ["plugins/**"]);
  assert.deepEqual(findUncoveredPaths([], ["plugins/**"]), ["plugins/**"]);
});

test("Rust pilot and executable contracts remain in local and CI gates", () => {
  const config = fs.readFileSync(MISE_CONFIG, "utf8");
  for (const gate of ["ci-code", "ci-code-full"]) {
    const command = config.split(/\r?\n/).find((line) => line.startsWith(`${gate} =`));
    assert.ok(command?.includes("mise tasks run native-search-check"), `${gate} must check the Rust pilot`);
  }
  const incremental = fs.readFileSync(path.join(ROOT_DIR, "scripts/check-affected.mjs"), "utf8");
  assert.match(config, /ci-fast = ".*node scripts\/check-affected\.mjs/);
  assert.match(incremental, /"native-search-check"/, "增量代码路径仍保留 Rust pilot 校验");
  assert.match(config, /rust = "\d+\.\d+\.\d+"/);
  assert.match(config, /cargo test --locked --manifest-path native\/tools\/vector-pilot\/Cargo.toml/);
  assert.match(config, /node --test scripts\/native-search.test.mjs/);
});

test("Memory deletion regression gates generate their evidence without the paper archive", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
  const command = pkg.scripts["check:memory-deletion"];
  assert.equal(typeof command, "string");
  const steps = command.split(/\s+&&\s+/);
  assert.deepEqual(steps, [
    "turbo run build --filter=@aervox/worker...",
    "node --test scripts/memory-deletion-research/runner.test.mjs scripts/memory-deletion-research/supplement.test.mjs",
  ], "build dependencies before exercising the runner and production supplement");
  assert.equal(command.includes("docs/"), false, "code gates must not depend on archived paper assets");

  const config = fs.readFileSync(MISE_CONFIG, "utf8");
  for (const gate of ["ci-code", "ci-code-full"]) {
    const line = config.split(/\r?\n/).find((entry) => entry.startsWith(`${gate} =`));
    assert.ok(line?.includes("pnpm check:memory-deletion"), `${gate} must validate the research contract`);
  }
  const incremental = fs.readFileSync(path.join(ROOT_DIR, "scripts/check-affected.mjs"), "utf8");
  assert.match(incremental, /spawnSync\("pnpm", \["check:memory-deletion"\]/);
  assert.match(incremental, /if \(memoryDeletionRes\.status !== 0\) process\.exit\(memoryDeletionRes\.status \?\? 1\)/);
  const workflow = readWorkflowPaths(CI_WORKFLOW);
  for (const file of [
    "scripts/memory-deletion-research/runner.mjs",
    "scripts/memory-deletion-research/runner.test.mjs",
    "scripts/memory-deletion-research/validate-report.mjs",
    "packages/repositories/src/repositories/sqlite/memory-deletion-store.ts",
  ]) {
    assert.equal(isDocumentationOnlyChange([file], loadTurboScope()), false, file);
    for (const trigger of [workflow.pullRequest, workflow.push]) {
      assert.ok(trigger.some((glob) => matchesGlob(file, glob)), `CI must cover ${file}`);
    }
  }
});


test("Deletion fault testing runs live evidence and never reads the private paper archive", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
  const command = pkg.scripts["check:deletion-fault-testing"];
  assert.equal(command, "turbo run build --filter=@aervox/worker... && node --test scripts/deletion-fault-testing/*.test.mjs");
  for (const gate of ["ci-code", "ci-code-full"]) {
    const entry = fs.readFileSync(MISE_CONFIG, "utf8").split(/\r?\n/).find(line => line.startsWith(`${gate} =`));
    assert.ok(entry?.includes("pnpm check:deletion-fault-testing"));
    assert.ok(entry?.includes("pnpm check:deletion-fault-integration"));
  }
  const incremental = fs.readFileSync(path.join(ROOT_DIR, "scripts/check-affected.mjs"), "utf8");
  assert.match(incremental, /spawnSync\("pnpm", \["check:deletion-fault-testing"\]/);
  assert.match(incremental, /spawnSync\("pnpm", \["check:deletion-fault-integration"\]/);
  assert.match(incremental, /if \(deletionIntegrationRes\.status !== 0\) process\.exit\(deletionIntegrationRes\.status \?\? 1\)/);
  assert.match(incremental, /if \(deletionFaultRes\.status !== 0\) process\.exit\(deletionFaultRes\.status \?\? 1\)/);
  for (const file of ["scripts/deletion-fault-testing/engine.mjs", "scripts/deletion-fault-testing/protocol.json"]) {
    assert.equal(isDocumentationOnlyChange([file], loadTurboScope()), false);
    const paths = readWorkflowPaths(CI_WORKFLOW);
    for (const trigger of [paths.pullRequest, paths.push]) assert.ok(trigger.some(glob => matchesGlob(file, glob)));
  }
});

test('installer settings trigger CI and invalidate shared build caches', () => {
  const scope = loadTurboScope();
  for (const file of ['.npmrc', 'pnpm-workspace.yaml']) {
    assert.equal(resolveChangeScope([file], scope).mode, 'full');
    for (const paths of Object.values(readWorkflowPaths(CI_WORKFLOW))) {
      assert.ok(paths.includes(file));
      assert.ok(findUncoveredPaths(paths.filter(path => path !== file), collectRequiredCodePaths(scope)).includes(file));
    }
  }
});

test('desktop checks both referenced projects before bundling', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'apps/desktop/package.json'), 'utf8'));
  assert.match(pkg.scripts.typecheck, /tsc --noEmit -p tsconfig\.node\.json/);
  assert.match(pkg.scripts.typecheck, /vue-tsc --noEmit -p tsconfig\.web\.json/);
  assert.ok(pkg.scripts.build.startsWith('pnpm typecheck &&'));
  const config = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'apps/desktop/tsconfig.node.json'), 'utf8'));
  assert.ok(config.include.includes('src/main/**/*.ts'));
  assert.ok(config.include.includes('src/preload/**/*.ts'));
  assert.ok(config.include.includes('../../scripts/vendor-chunks.ts'));
});

test("CI covers Playwright test directories, configs and executable root launchers", () => {
  const workflow = readWorkflowPaths(CI_WORKFLOW);
  const required = ["aervox", "siyu-chat.command"];
  const config = "e2e/playwright.config.ts";
  const configSource = fs.readFileSync(path.join(ROOT_DIR, config), "utf8");
  // 单配置多 project：每个 project 的 testDir 都必须被工作流路径过滤覆盖，
  // 否则改动某个 project 的用例会既不触发工作流、也不使缓存失效。
  const testDirs = [...configSource.matchAll(/testDir:\s*["']\.\/([^"']+)["']/g)]
    .map((match) => path.posix.join(path.posix.dirname(config), match[1]));
  assert.ok(testDirs.length > 0, `${config} must declare at least one testDir`);
  for (const project of ["api", "ui"]) {
    assert.match(configSource, new RegExp(`name:\\s*["']${project}["']`), `${config} must declare the ${project} project`);
  }
  assert.deepEqual(testDirs, ["e2e/api", "e2e/ui"]);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, "package.json"), "utf8"));
  for (const script of ["test:e2e", "test:e2e:api", "test:e2e:ui"]) {
    assert.ok(pkg.scripts[script].includes(`--config ${config}`), `${script} must select the relocated config`);
  }
  required.push(config, ...testDirs.map((dir) => `${dir}/**`));
  assert.deepEqual(findUncoveredPaths(workflow.pullRequest, required), []);
  assert.deepEqual(findUncoveredPaths(workflow.push, required), []);
  const source = fs.readFileSync(CI_WORKFLOW, "utf8");
  assert.match(source, /playwright install --with-deps chromium/);
  // 两个 project 都要在 CI 里被显式执行：合并配置后 `playwright test` 会同时跑到
  // UI 用例，而 API job 不安装浏览器二进制，因此它必须锁定 --project=api。
  assert.match(source, /pnpm run test:e2e:api/);
  assert.match(source, /pnpm test:e2e:ui/);
  assert.match(source, /pnpm check:dependency-audit/);
});


test("API and plugin standards run after build in full and incremental gates", () => {
  const config = fs.readFileSync(MISE_CONFIG, "utf8");
  for (const gate of ["ci-code", "ci-code-full"]) {
    const command = config.split(/\r?\n/).find((line) => line.startsWith(`${gate} =`));
    assert.match(command ?? "", /pnpm build && pnpm check:standards/);
  }
  const incremental = fs.readFileSync(path.join(ROOT_DIR, "scripts/check-affected.mjs"), "utf8");
  assert.ok(incremental.indexOf('["check:standards"]') > incremental.indexOf('const buildRes ='));
});
