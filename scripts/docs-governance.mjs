#!/usr/bin/env node

/**
 * Aervox 文档治理校验器。
 *
 * 默认是兼容模式：历史文档的旧头格式和缺失字段只报告 warning；
 * 路径不存在、重复 ID、策略损坏和 canonical 文档未登记始终阻断。
 * 设置 DOCS_GOVERNANCE_STRICT=1 或传入 --strict 后，迁移 warning 也会阻断。
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const docsDir = path.join(rootDir, "docs");
const policyPath = path.join(docsDir, "_meta", "document-policy.json");
const strict = process.argv.includes("--strict") || process.env.DOCS_GOVERNANCE_STRICT === "1";

const errors = [];
const warnings = [];
const metrics = {
  markdownFiles: 0,
  governedFiles: 0,
  canonicalFiles: 0,
  legacyFiles: 0,
  duplicateIds: 0,
  missingLocalLinks: 0,
  brokenAnchors: 0,
  registryDateMismatches: 0,
  registryMissingEntries: 0,
  staleFiles: 0,
};

function reportWarning(message) {
  warnings.push(message);
}

function reportMigrationWarning(message) {
  if (strict) errors.push(message);
  else reportWarning(message);
}

function reportError(message) {
  errors.push(message);
}

function walk(directory) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute));
    else files.push(absolute);
  }
  return files;
}

function relativeToRoot(file) {
  return path.relative(rootDir, file).split(path.sep).join("/");
}

function relativeToDocs(file) {
  return path.relative(docsDir, file).split(path.sep).join("/");
}

function stripQuotes(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseFrontMatter(text) {
  if (!text.startsWith("---\n")) return { present: false, fields: {}, endOffset: 0 };
  const endMatch = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!endMatch) return { present: true, fields: {}, endOffset: 0, malformed: true };

  const fields = {};
  let currentArrayKey = "";
  for (const line of endMatch[1].split("\n")) {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (field) {
      const [, key, rawValue] = field;
      if (rawValue.trim() === "") {
        fields[key] = [];
        currentArrayKey = key;
      } else {
        fields[key] = stripQuotes(rawValue);
        currentArrayKey = "";
      }
      continue;
    }
    const item = line.match(/^\s+-\s+(.+)$/);
    if (item && currentArrayKey) fields[currentArrayKey].push(stripQuotes(item[1]));
  }
  return { present: true, fields, endOffset: endMatch[0].length, malformed: false };
}

function firstMatch(text, expressions) {
  for (const expression of expressions) {
    const match = text.match(expression);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function normalizeId(value) {
  return String(value ?? "")
    .trim()
    .replace(/[（(].*?[）)]/g, "")
    .trim();
}

function parseMetadata(file, text) {
  const relative = relativeToDocs(file);
  const basename = path.basename(file);
  const frontMatter = parseFrontMatter(text);
  const headerText = frontMatter.present
    ? text.slice(frontMatter.endOffset, Math.min(text.length, frontMatter.endOffset + 4_000))
    : text.split("\n").slice(0, 30).join("\n");
  const fields = frontMatter.fields;
  const isTemplate = relative.startsWith("templates/");
  const isNavigation = relative === "README.md" || relative === "DOC_REGISTRY.md" || relative === "getting-started.md" || relative === "reference/adr/README.md";
  const isAdr = relative.startsWith("reference/adr/") && basename !== "README.md";
  const isChange = relative.startsWith("reference/changes/");
  const title = fields.title || firstMatch(text, [/^#\s+(.+)$/m]);
  const idFromField = fields.id || firstMatch(headerText, [/^>\s*文档编号：\s*(.+)$/m]);
  const idFromTitle = firstMatch(text, [/^#\s+(ADR-\d{3})\b/m, /^#\s+(CR-\d{3})\b/m]);
  const id = normalizeId(idFromField || idFromTitle);
  const type = fields.type || firstMatch(headerText, [/^>\s*类型：\s*(.+)$/m]);
  let documentStatus = fields.doc_status || firstMatch(headerText, [
    /^>\s*文档状态：\s*(.+)$/m,
    /^>\s*状态：\s*(.+)$/m,
  ]);
  let decisionStatus = fields.decision_status || firstMatch(headerText, [
    /^>\s*决策状态：\s*(.+)$/m,
    /^-\s*决策：\s*((?:Proposed|Accepted|Rejected|Deferred|More Evidence Required|提议|已接受|已拒绝|延期|需要更多证据))/m,
    /^-\s*状态：\s*(Proposed|Accepted|Rejected|Deferred|More Evidence Required)\b/m,
  ]);
  const deliveryStatus = fields.delivery_status || firstMatch(headerText, [
    /^>\s*交付状态：\s*(.+)$/m,
    /^-\s*交付状态：\s*(.+)$/m,
  ]);
  // Legacy CR/ADR files often use one "状态" field for the decision dimension.
  // Treat the explicit "More Evidence Required" value as a decision status when
  // no separate document status is present, while retaining Review Candidate as
  // the document status for files that declare both dimensions.
  if ((isAdr || isChange) && !fields.doc_status && normalizeStatus(documentStatus) === "more-evidence-required") {
    decisionStatus ||= documentStatus;
    documentStatus = "";
  }
  const updatedAt = fields.updated_at || firstMatch(headerText, [/^>\s*(?:更新日期|创建\/更新日期)：\s*(\d{4}-\d{2}-\d{2})/m]);
  const reviewedAt = fields.reviewed_at || firstMatch(headerText, [/^>\s*最后核验：\s*(\d{4}-\d{2}-\d{2})/m]) || updatedAt;
  const hasProposer = /^-\s*提出人：.+$/m.test(headerText);
  const hasModifier = /^-\s*修改人：.+$/m.test(headerText);
  const statusLabels = [...headerText.matchAll(/(?:^|\n)(?:>\s*)?(?:文档状态|决策状态|交付状态|状态)：/g)].map((match) => match[0].trim());

  return {
    relative,
    basename,
    title,
    id,
    type,
    documentStatus,
    decisionStatus,
    deliveryStatus,
    updatedAt,
    reviewedAt,
    hasProposer,
    hasModifier,
    usesCanonicalFrontMatter: frontMatter.present && !frontMatter.malformed,
    frontMatter,
    fields,
    isTemplate,
    isNavigation,
    isAdr,
    isChange,
    statusLabels,
    text,
  };
}

function normalizeStatus(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[（(].*?[）)]/g, "")
    .replace(/[_\s]+/g, "-");
  const aliases = new Map([
    ["草稿", "draft"],
    ["评审候选", "review-candidate"],
    ["已批准", "approved"],
    ["已替代", "superseded"],
    ["已退役", "retired"],
  ]);
  return aliases.get(normalized) ?? normalized;
}

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

function githubSlug(value) {
  return value
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

function anchorsFor(text) {
  const anchors = new Set();
  const counts = new Map();
  for (const line of text.split("\n")) {
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

function decodeFragment(fragment) {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function parseLinkTarget(rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith("<")) {
    const closing = target.indexOf(">");
    if (closing >= 0) target = target.slice(1, closing);
  } else {
    const titleStart = target.search(/\s+["']/);
    if (titleStart >= 0) target = target.slice(0, titleStart);
  }
  return target;
}

function removeFencedCode(text) {
  return text.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, "");
}

function checkLinks(metadataByFile) {
  for (const [file, metadata] of metadataByFile) {
    const linkText = removeFencedCode(metadata.text);
    for (const match of linkText.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = parseLinkTarget(match[1]);
      if (!target || /^(?:https?:|mailto:|tel:)/i.test(target)) continue;
      const [rawPath, rawFragment] = target.split("#", 2);
      const targetFile = path.resolve(path.dirname(file), rawPath || path.basename(file));
      if (!fs.existsSync(targetFile)) {
        metrics.missingLocalLinks += 1;
        reportError(`${metadata.relative}: 本地链接目标不存在：${target}`);
        continue;
      }
      if (rawFragment && fs.statSync(targetFile).isFile() && path.extname(targetFile).toLowerCase() === ".md") {
        const fragment = decodeFragment(rawFragment);
        const targetText = fs.readFileSync(targetFile, "utf8");
        if (!anchorsFor(targetText).has(fragment)) {
          metrics.brokenAnchors += 1;
          reportError(`${metadata.relative}: 锚点不存在：${target}`);
        }
      }
    }
  }
}

function parseRegistry(registryFile) {
  const text = fs.readFileSync(registryFile, "utf8");
  const entries = [];
  const rowPattern = /^\|\s*`([^`]+)`\s*\|\s*\[[^\]]+\]\(([^)#\s]+)(?:#[^)]*)?\)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|/gm;
  for (const match of text.matchAll(rowPattern)) {
    entries.push({ id: match[1], relativePath: normalizePath(match[2]), reviewedAt: match[3] });
  }
  return entries;
}

function checkRegistry(metadataByFile) {
  const registryFile = path.join(docsDir, "DOC_REGISTRY.md");
  if (!fs.existsSync(registryFile)) {
    reportError("docs/DOC_REGISTRY.md 不存在");
    return;
  }

  const entries = parseRegistry(registryFile);
  const registeredPaths = new Set();
  const registeredIds = new Map();
  for (const entry of entries) {
    const target = path.resolve(docsDir, entry.relativePath.trim());
    if (registeredIds.has(entry.id)) reportError(`DOC_REGISTRY.md: 重复登记编号 ${entry.id}`);
    registeredIds.set(entry.id, target);
    if (registeredPaths.has(target)) reportError(`DOC_REGISTRY.md: 重复登记路径 ${entry.relativePath}`);
    registeredPaths.add(target);
    if (!fs.existsSync(target)) {
      reportError(`DOC_REGISTRY.md: 登记路径不存在：${entry.relativePath}`);
      continue;
    }
    const metadata = metadataByFile.get(target);
    if (!metadata) continue;
    if (metadata.id && !metadata.id.includes("~") && metadata.id !== entry.id) {
      reportMigrationWarning(`DOC_REGISTRY.md: 编号 ${entry.id} 与文档 ${metadata.relative} 的编号 ${metadata.id} 不一致`);
    }
    if (!metadata.reviewedAt || metadata.reviewedAt === "YYYY-MM-DD") continue;
    if (metadata.reviewedAt !== entry.reviewedAt) {
      metrics.registryDateMismatches += 1;
      reportMigrationWarning(`DOC_REGISTRY.md: ${entry.id} 登记日期 ${entry.reviewedAt} 与文档核验日期 ${metadata.reviewedAt} 不一致（${entry.relativePath}）`);
    }
  }

  for (const [file, metadata] of metadataByFile) {
    if (metadata.isTemplate || metadata.basename === "LICENSE" || metadata.isNavigation || !metadata.usesCanonicalFrontMatter) continue;
    metrics.canonicalFiles += 1;
    if (!registeredPaths.has(file)) {
      metrics.registryMissingEntries += 1;
      reportError(`${metadata.relative}: canonical 文档必须登记在 docs/DOC_REGISTRY.md`);
    }
  }
}

function validatePolicy(policy) {
  const requiredArrays = ["documentStatus", "decisionStatus", "deliveryStatus"];
  for (const key of requiredArrays) {
    if (!Array.isArray(policy[key]) || policy[key].length === 0) reportError(`策略字段 ${key} 必须是非空数组`);
  }
  if (!policy.policyId || !policy.registryPath) reportError("策略必须包含 policyId 和 registryPath");
  if (!Number.isInteger(policy.defaultReviewIntervalDays) || policy.defaultReviewIntervalDays <= 0) {
    reportError("策略 defaultReviewIntervalDays 必须是正整数");
  }
}

function expectedTypeFor(relative) {
  const segment = relative.split("/")[0];
  return {
    tutorials: "tutorial",
    "how-to": "how-to",
    explanation: "explanation",
    reference: "reference",
  }[segment] ?? "";
}

function checkMetadata(metadataByFile, policy) {
  const ids = new Map();
  const allowedDocumentStatuses = new Set((policy.documentStatus ?? []).map(normalizeStatus));
  const allowedDecisionStatuses = new Set((policy.decisionStatus ?? []).map(normalizeStatus));
  const allowedDeliveryStatuses = new Set((policy.deliveryStatus ?? []).map(normalizeStatus));
  const requiredFields = Array.isArray(policy.requiredFrontMatterFields) ? policy.requiredFrontMatterFields : [];

  for (const [file, metadata] of metadataByFile) {
    metrics.markdownFiles += 1;
    if (metadata.isTemplate || metadata.basename === "LICENSE") continue;
    metrics.governedFiles += 1;

    if (metadata.id && !metadata.id.includes("###") && !metadata.id.includes("~")) {
      const existing = ids.get(metadata.id);
      if (existing) {
        metrics.duplicateIds += 1;
        reportError(`重复文档编号 ${metadata.id}：${relativeToRoot(existing)} 与 ${metadata.relative}`);
      } else ids.set(metadata.id, file);
    }

    if (!metadata.hasProposer || !metadata.hasModifier) reportMigrationWarning(`${metadata.relative}: 缺少标准提出人/修改人签名`);
    if (!metadata.id && !metadata.isNavigation) reportMigrationWarning(`${metadata.relative}: 缺少可解析的文档编号`);
    if (!metadata.type && !metadata.isNavigation && !metadata.isAdr && !metadata.isChange) reportMigrationWarning(`${metadata.relative}: 缺少类型字段`);
    if (!metadata.updatedAt && !metadata.isNavigation) reportMigrationWarning(`${metadata.relative}: 缺少更新日期`);

    if (!metadata.usesCanonicalFrontMatter) {
      metrics.legacyFiles += 1;
      if (metadata.frontMatter.present && metadata.frontMatter.malformed) {
        reportError(`${metadata.relative}: YAML front matter 未正确闭合`);
      } else if (strict) {
        reportMigrationWarning(`${metadata.relative}: 使用兼容头格式；新文档应迁移到 canonical metadata`);
      }
    } else {
      if (metadata.frontMatter.malformed) reportError(`${metadata.relative}: YAML front matter 未正确闭合`);
      for (const field of requiredFields) {
        const value = metadata.fields[field];
        if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
          reportError(`${metadata.relative}: canonical front matter 缺少必填字段 ${field}`);
        }
      }
      if (metadata.isAdr && !metadata.fields.decision_status) reportError(`${metadata.relative}: ADR 必须声明 decision_status`);
      if (metadata.isChange && (!metadata.fields.decision_status || !metadata.fields.delivery_status)) {
        reportError(`${metadata.relative}: CR 必须声明 decision_status 和 delivery_status`);
      }
      const expectedType = expectedTypeFor(metadata.relative);
      if (expectedType && metadata.fields.type !== expectedType && !(metadata.isNavigation && !metadata.fields.type)) {
        reportError(`${metadata.relative}: type=${metadata.fields.type} 与目录推断的 ${expectedType} 不一致`);
      }
      if (!/^(?:AVX-[A-Z0-9-]+-\d{3}|ADR-\d{3}|CR-\d{3})$/.test(metadata.id)) {
        reportError(`${metadata.relative}: id 格式不符合 AVX/ADR/CR 编号规范：${metadata.id}`);
      }
      if (!/^\d+\.\d+\.\d+$/.test(String(metadata.fields.version ?? ""))) {
        reportError(`${metadata.relative}: version 必须是三段语义化版本`);
      }
      for (const dateField of ["updated_at", "reviewed_at"]) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(metadata.fields[dateField] ?? ""))) {
          reportError(`${metadata.relative}: ${dateField} 必须是 YYYY-MM-DD`);
        }
      }
      const updatedTime = Date.parse(`${metadata.fields.updated_at}T00:00:00Z`);
      const reviewedTime = Date.parse(`${metadata.fields.reviewed_at}T00:00:00Z`);
      if (Number.isFinite(updatedTime) && Number.isFinite(reviewedTime) && reviewedTime < updatedTime) {
        reportError(`${metadata.relative}: reviewed_at 不能早于 updated_at`);
      }
      if (metadata.fields.review_interval_days !== undefined &&
          (!/^\d+$/.test(String(metadata.fields.review_interval_days)) || Number(metadata.fields.review_interval_days) <= 0)) {
        reportError(`${metadata.relative}: review_interval_days 必须是正整数`);
      }
      const sourceEntries = Array.isArray(metadata.fields.sources) ? metadata.fields.sources : [];
      for (const source of sourceEntries) {
        const sourcePath = String(source).replace(/\/$/, "");
        if (!sourcePath || sourcePath.includes("*")) continue;
        const absoluteSource = path.resolve(rootDir, sourcePath);
        if (!fs.existsSync(absoluteSource)) reportMigrationWarning(`${metadata.relative}: sources 路径不存在：${source}`);
      }
    }

    const documentStatus = normalizeStatus(metadata.documentStatus);
    if (metadata.isChange && !metadata.usesCanonicalFrontMatter && metadata.decisionStatus && !metadata.documentStatus) {
      // Legacy CR files commonly use a single "状态" field for decision status.
    } else if (documentStatus && !allowedDocumentStatuses.has(documentStatus)) {
      reportMigrationWarning(`${metadata.relative}: 文档状态不在策略允许集合中：${metadata.documentStatus}`);
    }
    if (metadata.decisionStatus && !allowedDecisionStatuses.has(normalizeStatus(metadata.decisionStatus))) {
      reportMigrationWarning(`${metadata.relative}: 决策状态不在策略允许集合中：${metadata.decisionStatus}`);
    }
    if (metadata.deliveryStatus && !allowedDeliveryStatuses.has(normalizeStatus(metadata.deliveryStatus))) {
      reportMigrationWarning(`${metadata.relative}: 交付状态不在策略允许集合中：${metadata.deliveryStatus}`);
    }

    const duplicateLabels = metadata.statusLabels.filter((label, index, labels) => labels.indexOf(label) !== index);
    if (duplicateLabels.length > 0) reportMigrationWarning(`${metadata.relative}: 重复状态字段：${[...new Set(duplicateLabels)].join(", ")}`);

    if (metadata.reviewedAt && /^\d{4}-\d{2}-\d{2}$/.test(metadata.reviewedAt)) {
      const ageDays = Math.floor((Date.now() - Date.parse(`${metadata.reviewedAt}T00:00:00Z`)) / 86_400_000);
      if (ageDays > Number(policy.defaultReviewIntervalDays)) {
        metrics.staleFiles += 1;
        reportWarning(`${metadata.relative}: 距离最后核验 ${ageDays} 天，超过 ${policy.defaultReviewIntervalDays} 天复核周期`);
      }
    }
  }
}

function main() {
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  } catch (error) {
    reportError(`无法读取 ${relativeToRoot(policyPath)}：${error instanceof Error ? error.message : String(error)}`);
    finish();
    return;
  }
  validatePolicy(policy);

  const markdownFiles = walk(docsDir).filter((file) => file.endsWith(".md"));
  const metadataByFile = new Map();
  for (const file of markdownFiles) {
    const text = fs.readFileSync(file, "utf8");
    metadataByFile.set(file, parseMetadata(file, text));
  }
  checkMetadata(metadataByFile, policy);
  const linkFiles = new Map(metadataByFile);
  for (const rootDocument of ["README.md", "AGENTS.md", "CONTRIBUTING.md"]) {
    const file = path.join(rootDir, rootDocument);
    if (!fs.existsSync(file)) continue;
    linkFiles.set(file, { relative: rootDocument, text: fs.readFileSync(file, "utf8") });
  }
  checkLinks(linkFiles);
  checkRegistry(metadataByFile);
  finish();
}

function finish() {
  console.log(`[docs-validate] mode=${strict ? "strict" : "compatibility"}`);
  console.log(`[docs-validate] markdown=${metrics.markdownFiles} governed=${metrics.governedFiles} canonical=${metrics.canonicalFiles} legacy=${metrics.legacyFiles}`);
  console.log(`[docs-validate] duplicate_ids=${metrics.duplicateIds} missing_links=${metrics.missingLocalLinks} broken_anchors=${metrics.brokenAnchors}`);
  console.log(`[docs-validate] registry_date_mismatches=${metrics.registryDateMismatches} registry_missing=${metrics.registryMissingEntries} stale=${metrics.staleFiles}`);
  const warningLimit = strict ? warnings.length : 40;
  for (const warning of warnings.slice(0, warningLimit)) console.warn(`warning: ${warning}`);
  if (warnings.length > warningLimit) console.warn(`warning: 另有 ${warnings.length - warningLimit} 条迁移 warning 已省略；使用 --strict 查看并阻断全部`);
  for (const error of errors) console.error(`error: ${error}`);
  if (errors.length > 0) {
    console.error(`[docs-validate] failed: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exitCode = 1;
  } else {
    console.log(`[docs-validate] passed: ${warnings.length} warning(s)`);
  }
}

main();
