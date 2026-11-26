#!/usr/bin/env node
/**
 * 文档只检查可执行的完整性约束：声明的 ID 唯一、ADR 状态与替代关系、
 * 本地链接及锚点。普通文档无需 Front Matter，历史与作者由 Git 记录。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_DOCUMENTS = ["README.md", "AGENTS.md", "CONTRIBUTING.md", "CHANGELOG.md", "plan.md"];
const ADR_STATUSES = new Set(["proposed", "accepted", "rejected", "superseded"]);

/**
 * plan.md 的体量与结构预算。
 *
 * 该文件曾从 78KB 涨到 255KB：每条 ITER 都追加当次运行的测试计数、提交号与
 * 失败复验过程，导致同一缺口分散在多处、并持续过期。这里用可执行预算阻止回涨，
 * 规则与 [CONTRIBUTING「当前迭代」](../CONTRIBUTING.md#plan-maintenance) 一致：
 * 计划只写结论与链接，验证流水留在 PR/CI。
 */
export const PLAN_BUDGET = {
  /**
   * 整份计划的**棘轮上限**：只允许下降，上升即失败。
   * 2026-11-26 卫生审计把 255KB 压到 ~150KB（已完成条目塌缩为结论 + PR 链接，
   * 验证流水移出）。余下体量属于仍在进行的条目，其证据按维护者决定保留；
   * 本次把上限钉在压缩后的实测值之上，使任何新增都必须先压缩同等体量。
   */
  maxBytes: 158 * 1024,
  /** 单个 `### ITER-` 小节的上限；仍需展开的条目应拆出独立文档并链接。 */
  maxSectionBytes: 20 * 1024,
  /** 禁止用 `####` 按 PR 分节——这是流水回写的主要形态。 */
  forbiddenHeading: /^####\s+(?:PR\s*#|PR\s*\d)/m,
};

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : file.endsWith(".md") ? [file] : [];
  });
}

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
  const files = [
    ...walk(path.join(root, "docs")),
    ...ROOT_DOCUMENTS.map((name) => path.join(root, name)).filter((file) => fs.existsSync(file)),
  ];
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
  const planFile = path.join(root, "plan.md");
  if (fs.existsSync(planFile)) errors.push(...checkPlanBudget(fs.readFileSync(planFile, "utf8")));
  errors.push(...checkAdrIndex(root));
  errors.push(...checkReferenceIds(documents));
  return { files: files.length, errors };
}

/**
 * 校验 ADR 索引覆盖全部 ADR 文件。
 *
 * 索引由人工维护，此前没有任何门禁检查它是否跟上了新增的 ADR——ADR-035 加入时
 * 就必须手工记得补索引，漏掉也不会报错。这类"导航静默落后于真源"正是本仓库
 * 反复出现的漂移模式，因此改为可执行检查：每篇 ADR 都必须在索引里被链接。
 *
 * 只查"索引是否覆盖"，不查条目措辞——那仍需人写。
 */
export function checkAdrIndex(root = rootDir) {
  const adrDirectory = path.join(root, "docs/reference/adr");
  const indexPath = path.join(adrDirectory, "README.md");
  if (!fs.existsSync(indexPath)) return [];
  const index = fs.readFileSync(indexPath, "utf8");
  const errors = [];
  for (const entry of fs.readdirSync(adrDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !/^ADR-\d{3}.*\.md$/.test(entry.name)) continue;
    // 链接目标可能是裸文件名或带路径，两者都算已索引。
    if (!index.includes(entry.name)) errors.push(`docs/reference/adr/${entry.name}: 未出现在 ADR 索引（docs/reference/adr/README.md）中`);
  }
  return errors;
}

/**
 * 校验 plan.md 的体量与结构预算，返回错误说明（空数组表示合规）。
 *
 * 导出为独立函数以便测试直接构造超预算文本，而不必改动真实计划文件。
 */
export function checkPlanBudget(text) {
  const errors = [];
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > PLAN_BUDGET.maxBytes) {
    errors.push(`plan.md 超出体量预算：${bytes} 字节 > ${PLAN_BUDGET.maxBytes}；已完成条目应塌缩为结论与 PR 链接`);
  }
  const lines = text.split("\n");
  let start = -1;
  let heading = "";
  const flush = (end) => {
    if (start < 0) return;
    const size = Buffer.byteLength(lines.slice(start, end).join("\n"), "utf8");
    if (size > PLAN_BUDGET.maxSectionBytes) {
      errors.push(`plan.md 条目「${heading}」超出单条预算：${size} 字节 > ${PLAN_BUDGET.maxSectionBytes}；验证流水应留在 PR/CI`);
    }
  };
  lines.forEach((line, index) => {
    if (!/^### /.test(line)) return;
    flush(index);
    start = index;
    heading = line.slice(4).trim();
  });
  flush(lines.length);
  if (PLAN_BUDGET.forbiddenHeading.test(text)) {
    errors.push("plan.md 不得用 `####` 按 PR 分节；同一变更的记录应合并为一段叙述");
  }
  return errors;
}

/**
 * `docs/reference/` 下的契约文档必须声明稳定 ID。
 *
 * 该目录是产品范围、行为、架构与机器契约的事实源，其余 16 份都有 ID，只有
 * `API_CONVENTIONS.md` 长期缺失——它是最重要的一份跨模块约定之一。缺 ID 不影响
 * 阅读，却让「按稳定编号引用契约」这条约定对它失效，也让它与同目录其他文档不一致。
 *
 * 只约束 reference 目录：`CONTRIBUTING.md:70` 明确普通文档无需 Front Matter。
 */
export function checkReferenceIds(documents) {
  const errors = [];
  for (const doc of documents) {
    if (!doc.relative.startsWith('docs/reference/')) continue;
    // 兼容历史形式：部分索引文档用 <a id="..."> 锚点而非 front matter。
    // 两者都算声明了稳定编号，接受其一即可。
    const hasAnchor = /<a id="[^"]+"\s*><\/a>/.test(doc.text);
    if (!doc.fields.id && !hasAnchor) errors.push(`${doc.relative}: docs/reference/ 下的契约文档必须声明 id`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkDocumentation();
  for (const error of result.errors) console.error(`error: ${error}`);
  console.log(`[docs-validate] ${result.files} documents, ${result.errors.length} error(s)`);
  process.exitCode = result.errors.length > 0 ? 1 : 0;
}
