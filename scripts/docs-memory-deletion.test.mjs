import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { selectDocumentationChecks } from "./docs-lint-affected.mjs";
import { validateReport, validateCsv } from "./memory-deletion-research/validate-report.mjs";

const rootDirectory = fileURLToPath(new URL("../", import.meta.url));
const studyDirectory = "docs/explanation/memory-deletion-study";
const resultsDirectory = `${studyDirectory}/results`;
const archivedJson = fs.readFileSync(path.join(rootDirectory, resultsDirectory, "report.json"), "utf8");
const archivedCsv = fs.readFileSync(path.join(rootDirectory, resultsDirectory, "cases.csv"), "utf8");
const supplementPath = path.join(rootDirectory, resultsDirectory, "supplement.json");
const archivedSupplement = fs.existsSync(supplementPath) ? fs.readFileSync(supplementPath, "utf8") : null;

// The existing ci-docs test glob runs this against checked-in evidence without
// importing repositories, checking current build hashes, or rerunning the study.
test("文档全量门禁校验已归档的记忆删除 JSON 与 CSV", () => {
  const report = JSON.parse(archivedJson);
  assert.equal(validateReport(report).correctnessCases, report.protocol.arms.length * report.protocol.casesPerArm);
  assert.equal(validateCsv(report, archivedCsv), report.cases.length);
});

test("仅研究说明、JSON、CSV 或删除研究资产也选择归档校验", () => {
  for (const file of [
    `${studyDirectory}/README.md`, `${studyDirectory}/paper.md`,
    `${resultsDirectory}/report.json`, `${resultsDirectory}/cases.csv`,
    `${studyDirectory}/figures/outcomes.png`,
  ]) {
    assert.equal(selectDocumentationChecks([file], () => false).runMemoryDeletionStudy, true, file);
  }
  assert.equal(selectDocumentationChecks(["docs/guide.md"], () => true).runMemoryDeletionStudy, false);
});

function fixture(t, changedFile, { json = archivedJson, csv = archivedCsv, supplement = archivedSupplement } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aervox-docs-deletion-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text, mode) => {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, text, mode ? { mode } : undefined);
  };
  for (const file of [
    "scripts/docs-lint-affected.mjs", "scripts/docs-governance.mjs",
    "scripts/memory-deletion-research/validate-report.mjs",
    "scripts/memory-deletion-research/protocol.mjs",
    "scripts/memory-deletion-research/validate-supplement.mjs",
  ]) write(file, fs.readFileSync(path.join(rootDirectory, file)));
  write("README.md", "# Project\n");
  write("docs/guide.md", "# Guide\n");
  write(`${studyDirectory}/README.md`, "# Study\n");
  write(`${resultsDirectory}/report.json`, json);
  write(`${resultsDirectory}/cases.csv`, csv);
  if (supplement) write(`${resultsDirectory}/supplement.json`, supplement);
  write("fixture-bin/git", `#!${process.execPath}
const args = process.argv.slice(2);
if (args[0] === "status") process.stdout.write(${JSON.stringify(` M ${changedFile}\0`)});
else if (args[0] === "rev-parse") process.stdout.write("fixture-commit");
else if (args[0] !== "diff") process.exitCode = 1;
`, 0o755);
  for (const command of ["markdownlint-cli2", "vale"]) {
    write(`fixture-bin/${command}`, `#!${process.execPath}\n`, 0o755);
  }
  return spawnSync(process.execPath, ["scripts/docs-lint-affected.mjs"], {
    cwd: root, encoding: "utf8",
    env: { ...process.env, PATH: `${path.join(root, "fixture-bin")}${path.delimiter}${process.env.PATH ?? ""}` },
  });
}

test("增量研究文档门禁无需依赖和构建产物即可验证归档", { skip: process.platform === "win32" }, (t) => {
  for (const file of [`${studyDirectory}/README.md`, `${resultsDirectory}/report.json`, `${resultsDirectory}/cases.csv`]) {
    const result = fixture(t, file);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /校验记忆删除研究的归档 JSON 与 CSV/);
  }
});

test("仅改 JSON 或 CSV 时增量门禁传播实际校验失败", { skip: process.platform === "win32" }, (t) => {
  const report = JSON.parse(archivedJson);
  report.summary[0].completed--;
  const jsonResult = fixture(t, `${resultsDirectory}/report.json`, { json: JSON.stringify(report) });
  assert.equal(jsonResult.status, 1, jsonResult.stdout + jsonResult.stderr);
  assert.match(jsonResult.stderr, /summary disagrees with raw correctness or timing rows/);

  const csvResult = fixture(t, `${resultsDirectory}/cases.csv`, { csv: archivedCsv.replace('"fts:before-clean"', '"changed-case"') });
  assert.equal(csvResult.status, 1, csvResult.stdout + csvResult.stderr);
  assert.match(csvResult.stderr, /CSV differs from JSON case rows/);
});

test("仅改研究说明仍拒绝损坏证据，普通文档不触发实验或证据校验", { skip: process.platform === "win32" }, (t) => {
  const studyResult = fixture(t, `${studyDirectory}/README.md`, { json: "{broken" });
  assert.equal(studyResult.status, 1, studyResult.stdout + studyResult.stderr);
  assert.match(studyResult.stderr, /SyntaxError/);

  const ordinaryResult = fixture(t, "docs/guide.md", { json: "{broken" });
  assert.equal(ordinaryResult.status, 0, ordinaryResult.stdout + ordinaryResult.stderr);
  assert.doesNotMatch(ordinaryResult.stdout, /校验记忆删除研究的归档 JSON 与 CSV/);
});

test("增量门禁拒绝损坏的生产补充证据", { skip: process.platform === "win32" }, (t) => {
  if (JSON.parse(archivedJson).schemaVersion < 3) return;
  const report = JSON.parse(archivedSupplement);
  report.crashes[0].rollbackIntact = false;
  const result = fixture(t, `${resultsDirectory}/supplement.json`, { supplement: JSON.stringify(report) });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /rollback/);
});
