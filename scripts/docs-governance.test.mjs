import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkDocumentation, parsePorcelainStatus } from "./docs-governance.mjs";
import { selectDocumentationChecks } from "./docs-lint-affected.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aervox-docs-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "docs/reference/adr"), { recursive: true });
  for (const name of ["docs-governance.mjs", "docs-lint-affected.mjs", "docs-config.mjs", "docs-check.mjs"]) {
    fs.copyFileSync(path.join(scriptsDirectory, name), path.join(root, "scripts", name));
  }
  write(root, "plan.md", "# 当前计划\n\n直接维护内容。\n");
  write(root, "README.md", "# Project\n\n[当前计划](plan.md)\n");
  write(root, "CONTRIBUTING.md", "# Contributing\n");
  return root;
}

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function adr(root, id, metadata = "decision_status: accepted") {
  write(root, `docs/reference/adr/${id}-example.md`, `---\nid: ${id}\n${metadata}\n---\n\n# ${id}\n`);
}

function mockGitEnvironment(root, status, committedRename = false) {
  const bin = path.join(root, "fixture-bin");
  fs.mkdirSync(bin);
  write(root, "fixture-bin/git", `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "status") process.stdout.write(${JSON.stringify(status)});
else if (args[0] === "rev-parse") process.stdout.write("fixture-commit");
else if (args[0] === "diff") {
  if (${committedRename} && args.includes("--no-renames")) process.stdout.write("docs/deleted.md\\0renamed.txt\\0");
  else if (${committedRename}) process.stdout.write("renamed.txt\\0");
} else process.exitCode = 1;
`);
  fs.chmodSync(path.join(bin, "git"), 0o755);
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` };
}

test("普通文档和手写 plan 无需元数据、策略、队列或登记表", (t) => {
  const root = fixture(t);
  write(root, "docs/guide.md", "# 指南\n\n[计划](../plan.md)\n");
  assert.deepEqual(checkDocumentation(root).errors, []);
  const result = spawnSync(process.execPath, ["scripts/docs-governance.mjs"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});

test("仅校验已经声明的稳定 ID，模板占位 ID 不参与唯一性", (t) => {
  const root = fixture(t);
  write(root, "docs/first.md", "---\nid: AVX-TEST-001\n---\n\n# First\n");
  write(root, "docs/second.md", "# Second\n");
  write(root, "docs/templates/example.md", "---\nid: AVX-TEST-001\n---\n\n# Template\n");
  assert.deepEqual(checkDocumentation(root).errors, []);
  write(root, "plan.md", "---\nid: AVX-TEST-001\n---\n\n# Plan\n");
  assert.match(checkDocumentation(root).errors.join("\n"), /重复文档编号 AVX-TEST-001/);
});

test("声明了 Front Matter 时必须正确闭合", (t) => {
  const root = fixture(t);
  write(root, "docs/broken.md", "---\nid: AVX-TEST-001\n\n# Broken\n");
  assert.match(checkDocumentation(root).errors.join("\n"), /front matter 未正确闭合/);
});

test("ADR 必须声明与文件名前缀一致的稳定编号", (t) => {
  const root = fixture(t);
  const file = "docs/reference/adr/ADR-001-example.md";
  write(root, file, "---\ndecision_status: accepted\n---\n\n# ADR-001\n");
  assert.match(checkDocumentation(root).errors.join("\n"), /ADR 必须声明 id: ADR-001/);
  write(root, file, "---\nid: ADR-002\ndecision_status: accepted\n---\n\n# ADR-001\n");
  assert.match(checkDocumentation(root).errors.join("\n"), /ADR id 必须与文件名前缀 ADR-001 一致/);
  adr(root, "ADR-002");
  assert.match(checkDocumentation(root).errors.join("\n"), /重复文档编号 ADR-002/);
});

test("ADR 目录内不能通过非数字编号或普通文件名绕过决策校验", (t) => {
  for (const name of ["ADR-XYZ-test.md", "new-decision.md"]) {
    const root = fixture(t);
    write(root, `docs/reference/adr/${name}`, "# New decision\n");
    const errors = checkDocumentation(root).errors.join("\n");
    assert.match(errors, /ADR 文件名必须以 ADR-三位数字命名/);
    assert.match(errors, /ADR 必须声明 id/);
    assert.match(errors, /ADR decision_status 必须/);
  }
});

test("ADR 保留编号和决策状态，不要求日期版本或交付登记", async (t) => {
  for (const status of ["proposed", "accepted", "rejected"]) {
    await t.test(status, (child) => {
      const root = fixture(child);
      adr(root, "ADR-001", `decision_status: ${status}`);
      assert.deepEqual(checkDocumentation(root).errors, []);
    });
  }
  for (const metadata of ["", "decision_status: implemented"]) {
    const root = fixture(t);
    adr(root, "ADR-001", metadata);
    assert.match(checkDocumentation(root).errors.join("\n"), /ADR decision_status 必须/);
  }
});

test("被替代 ADR 要指明替代来源，当前 ADR 引用不能悬空或指向自身", (t) => {
  const root = fixture(t);
  adr(root, "ADR-001", "decision_status: superseded");
  assert.match(checkDocumentation(root).errors.join("\n"), /必须声明 superseded_by/);
  for (const replacement of ["ADR-001", "ADR-999", "unknown"]) {
    adr(root, "ADR-001", `decision_status: superseded\nsuperseded_by: ${replacement}`);
    assert.match(checkDocumentation(root).errors.join("\n"), /superseded_by/);
  }
  adr(root, "ADR-002");
  adr(root, "ADR-001", "decision_status: superseded\nsuperseded_by: ADR-002");
  assert.deepEqual(checkDocumentation(root).errors, []);
});

test("历史 CR 替代来源可保留原编号或归档 URL", (t) => {
  const root = fixture(t);
  for (const replacement of ["CR-030", "https://example.com/archive/CR-030.md"]) {
    adr(root, "ADR-001", `decision_status: superseded\nsuperseded_by: ${replacement}`);
    assert.deepEqual(checkDocumentation(root).errors, []);
  }
});

test("ADR 替代关系不能成环，允许多步替代终止于历史 CR", (t) => {
  const root = fixture(t);
  adr(root, "ADR-001", "decision_status: superseded\nsuperseded_by: ADR-002");
  adr(root, "ADR-002", "decision_status: superseded\nsuperseded_by: ADR-001");
  assert.match(checkDocumentation(root).errors.join("\n"), /ADR 替代关系成环：ADR-001 → ADR-002 → ADR-001/);
  adr(root, "ADR-002", "decision_status: superseded\nsuperseded_by: ADR-003");
  adr(root, "ADR-003", "decision_status: superseded\nsuperseded_by: CR-030");
  assert.deepEqual(checkDocumentation(root).errors, []);
});

test("本地链接检查覆盖根文档、引用式链接、重复标题与显式锚点", (t) => {
  const root = fixture(t);
  write(root, "docs/target page.md", '# Target\n\n## 重复\n\n## 重复\n\n<a id="stable"></a>\n');
  write(root, "plan.md", '# Plan\n\n[标题](docs/target%20page.md#重复-1)\n[显式](<docs/target page.md#stable>)\n\n[ref]: <docs/target page.md#target>\n');
  assert.deepEqual(checkDocumentation(root).errors, []);
  fs.appendFileSync(path.join(root, "plan.md"), "\n[坏锚点](docs/target%20page.md#gone)\n[坏引用]: docs/gone.md\n");
  const errors = checkDocumentation(root).errors.join("\n");
  assert.match(errors, /锚点不存在/);
  assert.match(errors, /本地链接目标不存在：docs\/gone.md/);
});

test("HTML href/src 检查本地文档、锚点与图片，忽略代码围栏和注释", (t) => {
  const root = fixture(t);
  write(root, "docs/page.md", "# Page\n");
  write(root, "docs/image.png", "image fixture");
  write(root, "CONTRIBUTING.md", [
    "# Contributing",
    '<a href="docs/page.md#page">Page</a>',
    "<img alt='preview > detail' src='docs/image.png'>",
    "<img\n src=docs/image.png>",
    '<a href="https://example.com">External</a>',
    '<img src="data:image/png;base64,abc">',
    "<!-- <img src='docs/comment-example.png'> -->",
    "```html",
    "<a href='docs/code-example.md'>Example</a>",
    "<img src='docs/code-example.png'>",
    "```",
  ].join("\n"));
  assert.deepEqual(checkDocumentation(root).errors, []);
  fs.appendFileSync(path.join(root, "CONTRIBUTING.md"), [
    "",
    "<a href='docs/missing.md'>Missing</a>",
    '<img src="docs/missing.png">',
    "<a href=docs/page.md#missing>Missing anchor</a>",
  ].join("\n"));
  const errors = checkDocumentation(root).errors.join("\n");
  assert.match(errors, /本地链接目标不存在：docs\/missing.md/);
  assert.match(errors, /本地链接目标不存在：docs\/missing.png/);
  assert.match(errors, /锚点不存在：docs\/page.md#missing/);
});

test("代码示例内的链接和标题不当作文档链接或真实锚点", (t) => {
  const root = fixture(t);
  write(root, "docs/code.md", "# Code\n\n````md\n[示例](gone.md)\n## 虚构标题\n```\n````\n");
  assert.deepEqual(checkDocumentation(root).errors, []);
  fs.appendFileSync(path.join(root, "plan.md"), "\n[不存在的正文标题](docs/code.md#虚构标题)\n");
  assert.match(checkDocumentation(root).errors.join("\n"), /锚点不存在/);
});

test("porcelain 保留空格路径、重命名和复制两端，并去重", () => {
  assert.deepEqual(parsePorcelainStatus(" M apps/worker/src/index.ts\0?? docs/new document.md\0"), [
    "apps/worker/src/index.ts", "docs/new document.md",
  ]);
  for (const status of ["R ", " C"]) {
    assert.deepEqual(parsePorcelainStatus(`${status} docs/new-name.md\0docs/old-name.md\0`), [
      "docs/new-name.md", "docs/old-name.md",
    ]);
  }
  assert.deepEqual(parsePorcelainStatus(" M docs/README.md\0 M docs/README.md\0\0"), ["docs/README.md"]);
});

test("增量检查保留删除和文档工具输入，普通源码变动快退", () => {
  const exists = () => false;
  assert.deepEqual(selectDocumentationChecks(["docs/deleted.md"], exists), { markdownFiles: [], runGovernance: true, lintAll: false });
  assert.deepEqual(selectDocumentationChecks(["docs/deleted.png"], exists), { markdownFiles: [], runGovernance: true, lintAll: false });
  for (const file of ["scripts/docs-governance.test.mjs", "scripts/docs-lint-affected.mjs", "mise.toml", ".github/workflows/docs.yml"]) {
    assert.equal(selectDocumentationChecks([file], exists).runGovernance, true, file);
  }
  assert.deepEqual(selectDocumentationChecks(["apps/api/src/app.ts"], exists), { markdownFiles: [], runGovernance: false, lintAll: false });
  assert.deepEqual(selectDocumentationChecks(["docs/README.md", "plan.md", "CONTRIBUTING.md", ".agents/example.md", "plugins/example/SKILL.md"], () => true), {
    markdownFiles: ["docs/README.md", "plan.md", "CONTRIBUTING.md"], runGovernance: true, lintAll: false,
  });
});

test("排版、术语和工具版本变化必须重查全部文档", () => {
  for (const file of ["tooling/docs/.markdownlint-cli2.jsonc", "tooling/docs/.vale.ini", "tooling/docs/styles/Project/Terms.yml", "scripts/docs-config.mjs", "scripts/docs-check.mjs", "mise.toml"]) {
    assert.equal(selectDocumentationChecks([file], () => false).lintAll, true, file);
  }
  assert.equal(selectDocumentationChecks(["docs/guide.md"], () => true).lintAll, false);
});

test("配置单独变化时增量 CLI 也向两个 linter 传入未修改文档并传播失败", { skip: process.platform === "win32" }, (t) => {
  for (const config of ["tooling/docs/.markdownlint-cli2.jsonc", "tooling/docs/.vale.ini", "tooling/docs/styles/Project/Terms.yml", "scripts/docs-config.mjs"]) {
    const root = fixture(t);
    write(root, "docs/untouched.md", "# Existing document\n");
    const env = mockGitEnvironment(root, ` M ${config}\0`);
    const calls = path.join(root, "linter-calls.jsonl");
    for (const command of ["markdownlint-cli2", "vale"]) {
      const executable = path.join(root, "fixture-bin", command);
      fs.writeFileSync(executable, `#!${process.execPath}
require("node:fs").appendFileSync(${JSON.stringify(calls)}, JSON.stringify([${JSON.stringify(command)}, ...process.argv.slice(2)]) + "\\n");
if (${JSON.stringify(command)} === "vale") process.exitCode = 7;
`, { mode: 0o755 });
    }
    const result = spawnSync(process.execPath, ["scripts/docs-lint-affected.mjs"], { cwd: root, encoding: "utf8", env });
    assert.equal(result.status, 7, result.stdout + result.stderr);
    const recorded = fs.readFileSync(calls, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(recorded.map((args) => args[0]), ["markdownlint-cli2", "vale"]);
    for (const args of recorded) {
      const prefix = args[0] === "markdownlint-cli2" ? ":" : "";
      assert.ok(args.includes(`${prefix}docs/untouched.md`), `${config} -> ${args[0]}`);
      assert.ok(args.includes(`${prefix}plan.md`));
      assert.ok(args.includes(`${prefix}CONTRIBUTING.md`));
      assert.equal(args[1], "--config");
      assert.equal(args[2], args[0] === "vale" ? "tooling/docs/.vale.ini" : "tooling/docs/.markdownlint-cli2.jsonc");
    }
  }
});

test("增量 CLI 删除被引用的 plan 时仍检查入链并失败", { skip: process.platform === "win32" }, (t) => {
  const root = fixture(t);
  fs.rmSync(path.join(root, "plan.md"));
  const result = spawnSync(process.execPath, ["scripts/docs-lint-affected.mjs"], {
    cwd: root, encoding: "utf8", env: mockGitEnvironment(root, " D plan.md\0"),
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /无现存 Markdown 待 lint/);
  assert.match(result.stderr, /本地链接目标不存在：plan.md/);
});

test("增量 CLI 仅删除文档图片资产时也检查 HTML 入链并失败", { skip: process.platform === "win32" }, (t) => {
  const root = fixture(t);
  write(root, "docs/page.md", '# Page\n\n<img src="image.png">\n');
  write(root, "docs/image.png", "image fixture");
  assert.deepEqual(checkDocumentation(root).errors, []);
  fs.rmSync(path.join(root, "docs/image.png"));
  const result = spawnSync(process.execPath, ["scripts/docs-lint-affected.mjs"], {
    cwd: root, encoding: "utf8", env: mockGitEnvironment(root, " D docs/image.png\0"),
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /无现存 Markdown 待 lint/);
  assert.match(result.stderr, /本地链接目标不存在：image.png/);
});

test("增量 CLI 保留已提交重命名的旧路径并检查悬空引用", { skip: process.platform === "win32" }, (t) => {
  const root = fixture(t);
  fs.appendFileSync(path.join(root, "plan.md"), "\n[旧记录](docs/deleted.md)\n");
  write(root, "renamed.txt", "renamed document\n");
  const result = spawnSync(process.execPath, ["scripts/docs-lint-affected.mjs"], {
    cwd: root, encoding: "utf8", env: mockGitEnvironment(root, "", true),
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /无现存 Markdown 待 lint/);
  assert.match(result.stderr, /本地链接目标不存在：docs\/deleted.md/);
});
