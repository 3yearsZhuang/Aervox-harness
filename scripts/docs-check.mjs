#!/usr/bin/env node
/** Run the shared Markdown, prose and governance checks without shell globs. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDocumentationFiles, MARKDOWNLINT_CONFIG, VALE_CONFIG } from "./docs-config.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

function runCommand(command, args, { cwd }) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) console.error(`[docs-check] ${result.error.message}`);
  return result.status ?? 1;
}

/** Explicit files also serve the incremental entry; an empty batch still verifies governance. */
export function runDocumentationChecks({ root = repositoryRoot, files, mode = "all", governance = true, run = runCommand } = {}) {
  if (mode !== "all" && mode !== "prose") throw new Error(`unsupported documentation check mode: ${mode}`);
  const cwd = path.resolve(root);
  const selected = [...new Set((files ?? collectDocumentationFiles(cwd)).map((file) => path.resolve(cwd, file)))].sort();
  const relativeFiles = selected.map((file) => path.relative(cwd, file).split(path.sep).join("/"));
  if (relativeFiles.length > 0) {
    if (mode === "all") {
      // A Markdown filename may contain spaces or glob characters. CLI2's
      // literal prefix avoids expanding those names into a different batch.
      const status = run("markdownlint-cli2", ["--config", MARKDOWNLINT_CONFIG, ...relativeFiles.map((file) => `:${file}`)], { cwd });
      if (status !== 0) return status;
    }
    const status = run("vale", ["--config", VALE_CONFIG, "--minAlertLevel=error", ...relativeFiles], { cwd });
    if (status !== 0) return status;
  }
  return mode === "all" && governance ? run(process.execPath, ["scripts/docs-governance.mjs"], { cwd }) : 0;
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--prose")) {
    console.error("Usage: node scripts/docs-check.mjs [--prose]");
    process.exitCode = 1;
  } else {
    process.exitCode = runDocumentationChecks({ mode: args[0] === "--prose" ? "prose" : "all" });
  }
}
