import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ROOT_DOCUMENTS, DOCUMENTATION_TARGETS, MARKDOWNLINT_CONFIG, VALE_CONFIG, LYCHEE_EXCLUDE_FILE,
  collectDocumentationFiles, isGovernedMarkdown, isDocumentationToolInput, isProjectDocumentation, linkCheckArguments,
} from "./docs-config.mjs";
import { runDocumentationChecks } from "./docs-check.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aervox docs targets "));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, file, text = "# Document\n") {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

test("documentation ownership drives collection, classification and generated link inputs", (t) => {
  const root = fixture(t);
  for (const file of ["README.md", "AGENTS.md", "CONTRIBUTING.md", "plan.md", "docs/z.md", "docs/nested/a[1] page.md", "docs/.hidden.md",
    "docs/image.png", ".agents/private.md", "packages/core/README.md", "reference/README.md", "scripts/README.md"]) write(root, file);
  const expected = ["README.md", "AGENTS.md", "CONTRIBUTING.md", "plan.md", "docs/z.md", "docs/nested/a[1] page.md", "docs/.hidden.md"].map(file => path.join(root, file)).sort();
  assert.deepEqual(collectDocumentationFiles(root), expected);
  assert.ok(collectDocumentationFiles(root).every(file => path.isAbsolute(file)));
  for (const file of expected) assert.equal(isGovernedMarkdown(path.relative(root, file).split(path.sep).join("/")), true);
  for (const file of ["docs/image.png", ".agents/private.md", "packages/core/README.md", "scripts/docs-config.mjs"]) assert.equal(isGovernedMarkdown(file), false);
  assert.deepEqual(DOCUMENTATION_TARGETS, ["docs", ...ROOT_DOCUMENTS]);
  assert.equal(Object.isFrozen(ROOT_DOCUMENTS), true);
  assert.equal(Object.isFrozen(DOCUMENTATION_TARGETS), true);
  assert.deepEqual(linkCheckArguments(), ["--exclude-file", LYCHEE_EXCLUDE_FILE, ...DOCUMENTATION_TARGETS]);
  const output = spawnSync(process.execPath, [fileURLToPath(new URL("./docs-config.mjs", import.meta.url)), "--github-output"], { encoding: "utf8" });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout, `args=${linkCheckArguments().join(" ")}\n`);
});

test("docs tools and assets are documentation inputs while executable scripts and product Markdown stay code inputs", () => {
  for (const file of [MARKDOWNLINT_CONFIG, VALE_CONFIG, LYCHEE_EXCLUDE_FILE, "tooling/docs/styles/Project/Terms.yml"]) {
    assert.equal(isDocumentationToolInput(file), true);
    assert.equal(isProjectDocumentation(file), true);
  }
  for (const file of [...ROOT_DOCUMENTS, "docs/guide.md", "docs/image.png"]) assert.equal(isProjectDocumentation(file), true);
  for (const file of ["tooling/vitest.shared.ts", "scripts/docs-config.mjs", "plugins/example/SKILL.md", ".vale.ini", ".vale/styles/Terms.yml"]) assert.equal(isProjectDocumentation(file), false);
});

test("shared documentation modules can be imported from eval commands without treating data arguments as an entry point", () => {
  for (const file of ["docs-config.mjs", "docs-check.mjs"]) {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL(`./${file}`, import.meta.url).href)});`, "not-an-entrypoint"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
});

test("full and incremental batches use identical explicit tool configs and literal filenames", (t) => {
  const root = fixture(t);
  const files = ["docs/a[1] page.md", "README.md", "docs/a[1] page.md"];
  const calls = [];
  assert.equal(runDocumentationChecks({ root, files, run: (command, args, options) => { calls.push({ command, args, ...options }); return 0; } }), 0);
  assert.deepEqual(calls, [
    { command: "markdownlint-cli2", args: ["--config", MARKDOWNLINT_CONFIG, ":README.md", ":docs/a[1] page.md"], cwd: root },
    { command: "vale", args: ["--config", VALE_CONFIG, "--minAlertLevel=error", "README.md", "docs/a[1] page.md"], cwd: root },
    { command: process.execPath, args: ["scripts/docs-governance.mjs"], cwd: root },
  ]);
});

for (const failingStage of [0, 1, 2]) {
  test(`check failure at stage ${failingStage} preserves its status and prevents later checks`, (t) => {
    const root = fixture(t);
    let calls = 0;
    const status = 7 + failingStage;
    assert.equal(runDocumentationChecks({ root, files: ["README.md"], run: () => calls++ === failingStage ? status : 0 }), status);
    assert.equal(calls, failingStage + 1);
  });
}

test("prose-only and empty batches never expand into unintended lint targets", (t) => {
  const root = fixture(t);
  const calls = [];
  const run = (command, args) => { calls.push({ command, args }); return 0; };
  assert.equal(runDocumentationChecks({ root, files: ["README.md"], mode: "prose", run }), 0);
  assert.deepEqual(calls, [{ command: "vale", args: ["--config", VALE_CONFIG, "--minAlertLevel=error", "README.md"] }]);
  calls.length = 0;
  assert.equal(runDocumentationChecks({ root, files: [], run }), 0);
  assert.deepEqual(calls, [{ command: process.execPath, args: ["scripts/docs-governance.mjs"] }]);
  calls.length = 0;
  assert.equal(runDocumentationChecks({ root, files: [], mode: "prose", run }), 0);
  assert.equal(runDocumentationChecks({ root, files: [], governance: false, run }), 0);
  assert.deepEqual(calls, []);
});

function cliFixture(t) {
  const root = fixture(t);
  for (const file of ["docs-config.mjs", "docs-check.mjs"]) {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.copyFileSync(new URL(`./${file}`, import.meta.url), path.join(root, "scripts", file));
  }
  for (const file of ["README.md", "plan.md", "docs/a[1] page.md", "packages/core/README.md"]) write(root, file);
  const log = path.join(root, "calls.jsonl");
  const bin = path.join(root, "fixture-bin");
  fs.mkdirSync(bin);
  for (const command of ["markdownlint-cli2", "vale"]) {
    write(root, `fixture-bin/${command}`, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(process.env.DOCS_CHECK_LOG, JSON.stringify([${JSON.stringify(command)}, ...process.argv.slice(2)]) + '\\n');\nif (process.env.DOCS_FAIL_COMMAND === ${JSON.stringify(command)}) process.exitCode = 7;\n`);
    fs.chmodSync(path.join(bin, command), 0o755);
  }
  write(root, "scripts/docs-governance.mjs", "import fs from 'node:fs';\nfs.appendFileSync(process.env.DOCS_CHECK_LOG, JSON.stringify(['governance']) + '\\n');\nif (process.env.DOCS_FAIL_COMMAND === 'governance') process.exitCode = 7;\n");
  return { root, log, env: { ...process.env, DOCS_CHECK_LOG: log, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` } };
}

test("real full CLI runs one owned batch from its repository, including names with spaces and brackets", { skip: process.platform === "win32" }, (t) => {
  const f = cliFixture(t);
  const result = spawnSync(process.execPath, [path.join(f.root, "scripts/docs-check.mjs")], { cwd: os.tmpdir(), encoding: "utf8", env: f.env });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse), [
    ["markdownlint-cli2", "--config", MARKDOWNLINT_CONFIG, ":README.md", ":docs/a[1] page.md", ":plan.md"],
    ["vale", "--config", VALE_CONFIG, "--minAlertLevel=error", "README.md", "docs/a[1] page.md", "plan.md"],
    ["governance"],
  ]);
});

test("real CLI propagates formatter, prose and governance failures; --prose only runs Vale", { skip: process.platform === "win32" }, (t) => {
  for (const command of ["markdownlint-cli2", "vale", "governance"]) {
    const f = cliFixture(t);
    const result = spawnSync(process.execPath, [path.join(f.root, "scripts/docs-check.mjs")], { encoding: "utf8", env: { ...f.env, DOCS_FAIL_COMMAND: command } });
    assert.equal(result.status, 7, result.stderr);
    const calls = fs.readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(calls.at(-1)[0], command);
  }
  const f = cliFixture(t);
  const result = spawnSync(process.execPath, [path.join(f.root, "scripts/docs-check.mjs"), "--prose"], { encoding: "utf8", env: f.env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").map(JSON.parse)[0][0], "vale");
  assert.equal(fs.readFileSync(f.log, "utf8").trim().split("\n").length, 1);
});
