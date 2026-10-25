#!/usr/bin/env node
/** Project documentation targets and tool paths, shared by every docs entry point. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DOCUMENTS = Object.freeze(["README.md", "AGENTS.md", "CONTRIBUTING.md", "plan.md"]);
export const DOCUMENTATION_TARGETS = Object.freeze(["docs", ...ROOT_DOCUMENTS]);
export const DOCUMENTATION_TOOL_DIRECTORY = "tooling/docs";
export const MARKDOWNLINT_CONFIG = `${DOCUMENTATION_TOOL_DIRECTORY}/.markdownlint-cli2.jsonc`;
export const VALE_CONFIG = `${DOCUMENTATION_TOOL_DIRECTORY}/.vale.ini`;
export const LYCHEE_EXCLUDE_FILE = `${DOCUMENTATION_TOOL_DIRECTORY}/.lycheeignore`;

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : file.endsWith(".md") ? [file] : [];
  });
}

/** Match the governance walk; do not lint product, reference or agent Markdown. */
export function collectDocumentationFiles(root) {
  const absoluteRoot = path.resolve(root);
  return DOCUMENTATION_TARGETS.flatMap((target) => {
    const file = path.join(absoluteRoot, target);
    return target.endsWith(".md") ? fs.existsSync(file) ? [file] : [] : walk(file);
  }).sort();
}

export function isGovernedMarkdown(file) {
  return (file.startsWith("docs/") && file.endsWith(".md")) || ROOT_DOCUMENTS.includes(file);
}

export function isDocumentationToolInput(file) {
  return file === DOCUMENTATION_TOOL_DIRECTORY || file.startsWith(`${DOCUMENTATION_TOOL_DIRECTORY}/`);
}

export function isProjectDocumentation(file) {
  return file === "docs" || file.startsWith("docs/") || ROOT_DOCUMENTS.includes(file) || isDocumentationToolInput(file);
}

export function linkCheckArguments() {
  return ["--exclude-file", LYCHEE_EXCLUDE_FILE, ...DOCUMENTATION_TARGETS];
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  if (process.argv.length !== 3 || process.argv[2] !== "--github-output") {
    console.error("Usage: node scripts/docs-config.mjs --github-output");
    process.exitCode = 1;
  } else {
    const args = linkCheckArguments();
    // This output is consumed as a lychee-action argument string, never shell
    // source. Keep the declared target names plain and the output one line.
    if (args.some((arg) => !/^[A-Za-z0-9_./-]+$/.test(arg))) {
      console.error("Documentation link arguments require plain relative paths");
      process.exitCode = 1;
    } else {
      console.log(`args=${args.join(" ")}`);
    }
  }
}
