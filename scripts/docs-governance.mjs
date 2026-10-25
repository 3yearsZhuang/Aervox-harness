#!/usr/bin/env node
/**
 * 文档只检查可执行的完整性约束：声明的 ID 唯一、ADR 状态与替代关系、
 * 本地链接及锚点。普通文档无需 Front Matter，历史与作者由 Git 记录。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collectDocumentationFiles } from "./docs-config.mjs";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADR_STATUSES = new Set(["proposed", "accepted", "rejected", "superseded"]);

function parseFrontMatter(text) {
  if (!text.startsWith("---\n")) return { fields: {} };
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return { fields: {}, malformed: true };
  const fields = {};
  for (const line of match[1].split("\n")) {
    const field = line.match(/^(id|decision_status|superseded_by):\s*(.*?)\s*$/);
    if (field) fields[field[1]] = field[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return { fields };
}

function removeFencedCode(text) {
  let fence = null;
  return text.split("\n").map((line) => {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return "";
    }
    return fence ? "" : line;
  }).join("\n");
}

function githubSlug(value) {
  return value.toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function anchorsFor(text) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of removeFencedCode(text).split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (heading) {
      const base = githubSlug(heading[1]);
      const count = counts.get(base) ?? 0;
      counts.set(base, count + 1);
      anchors.add(count === 0 ? base : `${base}-${count}`);
    }
    for (const match of line.matchAll(/<a\s+(?:id|name)=["']([^"']+)["']/gi)) anchors.add(match[1]);
  }
  return anchors;
}

function decode(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function parseLinkTarget(raw) {
  const target = raw.trim();
  if (target.startsWith("<")) return target.slice(1, target.indexOf(">"));
  return target.replace(/\s+["'].*$/, "");
}

function checkLocalTarget(file, rawTarget, errors, root) {
  const target = parseLinkTarget(rawTarget);
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return;
  const [rawPath, rawFragment] = target.split("#", 2);
  const targetFile = rawPath ? path.resolve(path.dirname(file), decode(rawPath)) : file;
  const relative = path.relative(root, file);
  if (!fs.existsSync(targetFile)) {
    errors.push(`${relative}: 本地链接目标不存在：${target}`);
  } else if (rawFragment && path.extname(targetFile).toLowerCase() === ".md" && fs.statSync(targetFile).isFile()) {
    if (!anchorsFor(fs.readFileSync(targetFile, "utf8")).has(decode(rawFragment))) {
      errors.push(`${relative}: 锚点不存在：${target}`);
    }
  }
}

/** 保留工作区重命名/复制的新旧路径，删除目标也必须触发全仓入链校验。 */
export function parsePorcelainStatus(output) {
  const records = output.split("\0");
  const paths = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const status = record.slice(0, 2);
    const changedPath = record.slice(3);
    if (changedPath) paths.push(changedPath);
    if (status.includes("R") || status.includes("C")) {
      const originalPath = records[index + 1];
      if (originalPath) paths.push(originalPath);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

export function checkDocumentation(root = rootDir) {
  const files = collectDocumentationFiles(root);
  const errors = [];
  const ids = new Map();
  const documents = files.map((file) => {
    const relative = path.relative(root, file).split(path.sep).join("/");
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const { fields, malformed } = parseFrontMatter(text);
    const isArchive = relative.startsWith("docs/archive/");
    const exempt = relative.startsWith("docs/templates/") || isArchive;
    const isAdr = relative.startsWith("docs/reference/adr/") && relative !== "docs/reference/adr/README.md";
    if (!exempt) {
      if (malformed) errors.push(`${relative}: YAML front matter 未正确闭合`);
      if (fields.id) {
        if (ids.has(fields.id)) errors.push(`重复文档编号 ${fields.id}：${ids.get(fields.id)} 与 ${relative}`);
        else ids.set(fields.id, relative);
      }
    }
    return { file, relative, text, fields, isArchive, isAdr };
  });
  const adrs = new Map(documents.filter((doc) => doc.isAdr).map((doc) => [
    doc.fields.id, doc,
  ]));

  for (const doc of documents) {
    if (doc.isArchive) continue;
    if (doc.isAdr) {
      const filenameId = path.basename(doc.file).match(/^(ADR-\d{3})(?:-[^/]+)?\.md$/)?.[1];
      if (!filenameId) errors.push(`${doc.relative}: ADR 文件名必须以 ADR-三位数字命名`);
      if (!doc.fields.id) errors.push(`${doc.relative}: ADR 必须声明 id: ${filenameId ?? "ADR-###"}`);
      else if (filenameId && doc.fields.id !== filenameId) errors.push(`${doc.relative}: ADR id 必须与文件名前缀 ${filenameId} 一致`);
      const status = doc.fields.decision_status;
      if (!ADR_STATUSES.has(status)) {
        errors.push(`${doc.relative}: ADR decision_status 必须为 proposed、accepted、rejected 或 superseded`);
      }
      const replacement = doc.fields.superseded_by;
      if (status === "superseded" && !replacement) errors.push(`${doc.relative}: superseded ADR 必须声明 superseded_by`);
      if (replacement) {
        if (/^ADR-\d+$/.test(replacement)) {
          if (!adrs.has(replacement) || adrs.get(replacement).file === doc.file) {
            errors.push(`${doc.relative}: superseded_by 必须指向另一篇现存 ADR：${replacement}`);
          }
        } else if (!/^CR-\d+$/.test(replacement) && !/^https?:\/\/\S+$/.test(replacement)) {
          // 历史 CR 已在独立归档仓库；保留原编号或归档 URL，无需复制回主仓。
          errors.push(`${doc.relative}: superseded_by 应为 ADR 编号、历史 CR 编号或归档 URL`);
        }
      }
    }
    const linkText = removeFencedCode(doc.text);
    for (const match of linkText.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      checkLocalTarget(doc.file, match[1], errors, root);
    }
    // 引用式链接的定义也指向真实资源，不只检查行内链接。
    for (const match of linkText.matchAll(/^\s{0,3}\[(?!\^)[^\]]+\]:\s*(.+)$/gm)) {
      checkLocalTarget(doc.file, match[1], errors, root);
    }
    // Markdown 可直接嵌入 HTML；href/src 与 Markdown 链接共用本地目标检查。
    const htmlText = linkText.replace(/<!--[\s\S]*?-->/g, "");
    for (const tag of htmlText.matchAll(/<[a-z][a-z0-9:-]*\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi)) {
      for (const attribute of tag[0].matchAll(/\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
        checkLocalTarget(doc.file, attribute[1] ?? attribute[2] ?? attribute[3], errors, root);
      }
    }
  }
  const completed = new Set();
  for (const id of adrs.keys()) {
    const chain = [];
    let current = id;
    while (current && adrs.has(current) && !completed.has(current)) {
      const cycleStart = chain.indexOf(current);
      if (cycleStart >= 0) {
        errors.push(`ADR 替代关系成环：${[...chain.slice(cycleStart), current].join(" → ")}`);
        break;
      }
      chain.push(current);
      current = adrs.get(current).fields.superseded_by;
    }
    for (const visited of chain) completed.add(visited);
  }
  return { files: files.length, errors };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkDocumentation();
  for (const error of result.errors) console.error(`error: ${error}`);
  console.log(`[docs-validate] ${result.files} documents, ${result.errors.length} error(s)`);
  process.exitCode = result.errors.length > 0 ? 1 : 0;
}
