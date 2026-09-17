/**
 * Aervox｜思隅文档治理门禁自测（Node.js test runner）。
 * 运行：node --test scripts/docs-governance.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePorcelainStatus } from "./docs-governance.mjs";
import { selectDocumentationChecks } from "./docs-lint-affected.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const today = new Date().toISOString().slice(0, 10);

function document(id, fields = {}, body = "") {
  const metadata = {
    id,
    type: "reference",
    scope: "guide",
    owner: "maintainers",
    doc_status: "review-candidate",
    decision_status: "not-applicable",
    delivery_status: "not-applicable",
    version: "0.1.0",
    updated_at: today,
    reviewed_at: today,
    ...fields,
  };
  const frontMatter = Object.entries(metadata)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => Array.isArray(value)
      ? `${key}:\n${value.map((item) => `  - ${item}`).join("\n")}`
      : `${key}: ${value}`)
    .join("\n");
  return `---\n${frontMatter}\n---\n\n# Fixture\n\n- 提出人：fixture · ${today}\n- 修改人：fixture · ${today}\n\n${body}\n`;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aervox-docs-governance-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "_meta"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "reference"), { recursive: true });
  for (const name of ["docs-governance.mjs", "docs-lint-affected.mjs"]) {
    fs.copyFileSync(path.join(scriptsDirectory, name), path.join(root, "scripts", name));
  }
  fs.copyFileSync(
    path.resolve(scriptsDirectory, "../docs/_meta/document-policy.json"),
    path.join(root, "docs/_meta/document-policy.json"),
  );
  const registry = path.join(root, "docs/DOC_REGISTRY.md");
  fs.writeFileSync(registry, document("AVX-DOC-CONF-001", {},
    `| ID | 文档 | 核验日期 |\n|---|---|---|\n| \`AVX-PLAN-001\` | [当前计划](../plan.md) | ${today} |`));
  fs.writeFileSync(path.join(root, "plan.md"), document("AVX-PLAN-001", { planning_role: "current" },
    "[文档登记](docs/DOC_REGISTRY.md)"));
  return root;
}

function runGovernance(root, ...args) {
  return spawnSync(process.execPath, ["scripts/docs-governance.mjs", "--strict", ...args], {
    cwd: root,
    encoding: "utf8",
  });
}

function output(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function addRegisteredDocument(root, name, id, role) {
  fs.writeFileSync(path.join(root, "docs/reference", name), document(id, { planning_role: role }));
  fs.appendFileSync(path.join(root, "docs/DOC_REGISTRY.md"), `| \`${id}\` | [记录](reference/${name}) | ${today} |\n`);
}

function mockGitEnvironment(root, status, branchRename = false) {
  const bin = path.join(root, "fixture-bin");
  fs.mkdirSync(bin, { recursive: true });
  const git = path.join(bin, "git");
  const source = `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "status") process.stdout.write(${JSON.stringify(status)});
else if (${branchRename} && args[0] === "rev-parse") process.stdout.write("fixture-commit");
else if (${branchRename} && args[0] === "diff") {
  // 模拟 Git 的重命名检测：默认仅报告新路径，--no-renames 同时报告删除和新增。
  if (args.includes("--no-renames")) process.stdout.write("docs/reference/deleted.md\\0renamed.txt\\0");
  else process.stdout.write("renamed.txt\\0");
} else process.exitCode = 1;
`;
  fs.writeFileSync(git, source, { mode: 0o755 });
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
}

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

test("根计划进入完整治理和 docs-relative catalog", (t) => {
  const root = fixture(t);
  const result = runGovernance(root, "--generate-catalog");
  assert.equal(result.status, 0, output(result));
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "docs/_meta/document-catalog.json"), "utf8"));
  const plan = catalog.documents.find((item) => item.id === "AVX-PLAN-001");
  assert.equal(plan.path, "../plan.md");
  assert.equal(plan.type, "reference");
  assert.equal(plan.scope, "guide");
  assert.equal(plan.planning_role, "current");
});

test("缺少根计划不能用 docs 内的 current 计划替代", (t) => {
  const root = fixture(t);
  fs.renameSync(path.join(root, "plan.md"), path.join(root, "docs/plan.md"));
  const result = runGovernance(root);
  assert.equal(result.status, 1);
  assert.match(output(result), /根 plan\.md 必须存在/);
  assert.match(output(result), /planning_role: current 必须唯一且仅能由根 plan\.md 声明/);
});

test("策略不能将当前计划路径改到其它位置", (t) => {
  const root = fixture(t);
  const policyFile = path.join(root, "docs/_meta/document-policy.json");
  const policy = JSON.parse(fs.readFileSync(policyFile, "utf8"));
  policy.currentIterationPlan.path = "docs/plan.md";
  fs.writeFileSync(policyFile, JSON.stringify(policy));
  const result = runGovernance(root);
  assert.equal(result.status, 1);
  assert.match(output(result), /策略 currentIterationPlan 必须指定根 plan\.md/);
});

test("根计划缺少必填元数据、签名或固定角色时阻断", async (t) => {
  for (const [name, transform, expected] of [
    ["owner", (text) => text.replace(/^owner:.*\n/m, ""), /缺少必填字段 owner/],
    ["updated_at", (text) => text.replace(/^updated_at:.*\n/m, ""), /缺少必填字段 updated_at/],
    ["modifier", (text) => text.replace(/^- 修改人：.*\n/m, ""), /plan\.md 必须包含标准提出人\/修改人签名/],
    ["id", (text) => text.replace("id: AVX-PLAN-001", "id: AVX-PLAN-002"), /id 必须为 AVX-PLAN-001/],
    ["type", (text) => text.replace("type: reference", "type: explanation"), /type 必须为 reference/],
    ["scope", (text) => text.replace("scope: guide", "scope: baseline"), /scope 必须为 guide/],
    ["front matter", (text) => text.replace(/^---\n[\s\S]*?\n---\n/, ""), /plan\.md 必须使用 canonical YAML front matter/],
    ["role", (text) => text.replace("planning_role: current", "planning_role: history"), /plan\.md 必须声明 planning_role: current/],
  ]) {
    await t.test(name, (child) => {
      const root = fixture(child);
      const planFile = path.join(root, "plan.md");
      fs.writeFileSync(planFile, transform(fs.readFileSync(planFile, "utf8")));
      const result = runGovernance(root);
      assert.equal(result.status, 1);
      assert.match(output(result), expected);
    });
  }
});

test("current 角色在 docs 和其它根 Markdown 中均不能重复", async (t) => {
  for (const location of ["docs", "root"]) {
    await t.test(location, (child) => {
      const root = fixture(child);
      if (location === "docs") addRegisteredDocument(root, "another-plan.md", "AVX-PLAN-999", "current");
      else fs.writeFileSync(path.join(root, "another-plan.md"), document("AVX-PLAN-999", { planning_role: "current" }));
      const result = runGovernance(root);
      assert.equal(result.status, 1);
      assert.match(output(result), /planning_role: current 必须唯一/);
    });
  }
});

test("历史计划和证据文档不被 current 唯一性规则误禁", (t) => {
  const root = fixture(t);
  addRegisteredDocument(root, "history-plan.md", "AVX-PLAN-998", "history");
  addRegisteredDocument(root, "plan-evidence.md", "AVX-PLAN-999", "evidence");
  const result = runGovernance(root, "--generate-catalog");
  assert.equal(result.status, 0, output(result));
  const catalog = JSON.parse(fs.readFileSync(path.join(root, "docs/_meta/document-catalog.json"), "utf8"));
  assert.equal(catalog.documents.find((item) => item.id === "AVX-PLAN-998").planning_role, "history");
  assert.equal(catalog.documents.find((item) => item.id === "AVX-PLAN-999").planning_role, "evidence");
});

test("声明 planning_role 时只允许 current、history、evidence", (t) => {
  const root = fixture(t);
  addRegisteredDocument(root, "unknown-role.md", "AVX-PLAN-998", "upcoming");
  const result = runGovernance(root);
  assert.equal(result.status, 1);
  assert.match(output(result), /planning_role 必须为 current、history 或 evidence/);
});

test("根计划的本地链接与登记缺失均被检查", async (t) => {
  await t.test("bad link", (child) => {
    const root = fixture(child);
    fs.appendFileSync(path.join(root, "plan.md"), "\n[失效链接](docs/missing.md)\n");
    const result = runGovernance(root);
    assert.equal(result.status, 1);
    assert.match(output(result), /本地链接目标不存在：docs\/missing\.md/);
  });
  await t.test("unregistered", (child) => {
    const root = fixture(child);
    fs.writeFileSync(path.join(root, "docs/DOC_REGISTRY.md"), document("AVX-DOC-CONF-001"));
    const result = runGovernance(root);
    assert.equal(result.status, 1);
    assert.match(output(result), /\.\.\/plan\.md: canonical 文档必须登记/);
  });
});

test("根计划登记日期必须一致且 docs-sync 能对齐根路径", (t) => {
  const root = fixture(t);
  const registryFile = path.join(root, "docs/DOC_REGISTRY.md");
  fs.writeFileSync(registryFile, fs.readFileSync(registryFile, "utf8").replace(`](../plan.md) | ${today}`, "](../plan.md) | 2000-01-01"));
  const invalid = runGovernance(root);
  assert.equal(invalid.status, 1);
  assert.match(output(invalid), /登记日期 2000-01-01 与文档核验日期/);
  const synced = runGovernance(root, "--sync-registry");
  assert.equal(synced.status, 0, output(synced));
  assert.match(fs.readFileSync(registryFile, "utf8"), new RegExp(`\\]\\(\\.\\./plan\\.md\\) \\| ${today}`));
});

test("增量检查保留删除和治理关键输入，普通代码变动仍可快退", () => {
  const exists = (file) => file === "plan.md";
  assert.deepEqual(selectDocumentationChecks(["docs/deleted.md"], exists), { markdownFiles: [], runGovernance: true });
  for (const file of ["docs/_meta/document-policy.json", "scripts/docs-governance.test.mjs", "scripts/docs-lint-affected.mjs", "mise.toml", ".github/workflows/docs.yml"]) {
    assert.equal(selectDocumentationChecks([file], exists).runGovernance, true, file);
  }
  assert.deepEqual(selectDocumentationChecks(["apps/api/src/app.ts"], exists), { markdownFiles: [], runGovernance: false });
  assert.equal(selectDocumentationChecks([], () => false).runGovernance, true);
});

test("增量 CLI 在仅删除 plan.md 时运行真实治理并失败", { skip: process.platform === "win32" }, (t) => {
  const root = fixture(t);
  fs.rmSync(path.join(root, "plan.md"));
  const result = spawnSync(process.execPath, ["scripts/docs-lint-affected.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: mockGitEnvironment(root, " D plan.md\0"),
  });
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /无现存 Markdown 待 lint/);
  assert.match(output(result), /根 plan\.md 必须存在/);
});

test("增量 CLI 只有策略变动时也检查真实元数据", { skip: process.platform === "win32" }, (t) => {
  const root = fixture(t);
  const planFile = path.join(root, "plan.md");
  fs.writeFileSync(planFile, fs.readFileSync(planFile, "utf8").replace(/^owner:.*\n/m, ""));
  const result = spawnSync(process.execPath, ["scripts/docs-lint-affected.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: mockGitEnvironment(root, " M docs/_meta/document-policy.json\0"),
  });
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /缺少必填字段 owner/);
});

test("增量 CLI 保留已提交重命名的旧文档路径并检查悬空引用", { skip: process.platform === "win32" }, (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "plan.md"), "\n[旧记录](docs/reference/deleted.md)\n");
  fs.writeFileSync(path.join(root, "renamed.txt"), "renamed document\n");
  const result = spawnSync(process.execPath, ["scripts/docs-lint-affected.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: mockGitEnvironment(root, "", true),
  });
  assert.equal(result.status, 1, output(result));
  assert.match(output(result), /无现存 Markdown 待 lint/);
  assert.match(output(result), /本地链接目标不存在：docs\/reference\/deleted\.md/);
});

test("触发器能识别根计划已经同步修改", { skip: process.platform === "win32" }, (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "plan.md"), document("AVX-PLAN-001", {
    planning_role: "current",
    review_triggers: ["apps/**"],
  }));
  const result = spawnSync(process.execPath, ["scripts/docs-governance.mjs", "--strict", "--check-triggers"], {
    cwd: root,
    encoding: "utf8",
    env: mockGitEnvironment(root, " M apps/api/src/app.ts\0 M plan.md\0"),
  });
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /\.\.\/plan\.md （已同步修改/);
});
