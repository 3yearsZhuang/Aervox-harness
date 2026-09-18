/**
 * Aervox｜思隅 ADR 索引渲染与校验
 *
 * 机器事实源：docs/reference/adr/ADR-*.md 文件集合。
 * 目标生成区：
 * 1. docs/reference/adr/README.md（<!-- ADR_TABLE_START --> ~ <!-- ADR_TABLE_END -->）
 * 2. docs/reference/ARCHITECTURE.md §11（<!-- ADR_TABLE_START --> ~ <!-- ADR_TABLE_END -->）
 *
 * 用法：
 *   node scripts/render-adr-index.mjs --render   # 重新生成表格
 *   node scripts/render-adr-index.mjs --check    # 门禁校验，不一致退出码 1
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ADR_DIR = "docs/reference/adr";
const ADR_README_PATH = "docs/reference/adr/README.md";
const ARCHITECTURE_PATH = "docs/reference/ARCHITECTURE.md";

const START_MARKER = "<!-- ADR_TABLE_START -->";
const END_MARKER = "<!-- ADR_TABLE_END -->";

export function collectAdrs(dir = ADR_DIR) {
  const adrs = [];
  for (const file of readdirSync(dir)) {
    if (!file.startsWith("ADR-") || !file.endsWith(".md") || file === "README.md") continue;
    const content = readFileSync(join(dir, file), "utf8");
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    const titleMatch = content.match(/\n# (ADR-\d+[\s\S]*?)\n/);

    const idMatch = file.match(/^(ADR-\d+)/);
    const id = idMatch ? idMatch[1] : file;

    let title = file;
    if (titleMatch) {
      // 提取标题正文，去除前缀 "ADR-### "
      title = titleMatch[1].trim().replace(/^ADR-\d+\s*[:：]?\s*/, "");
    }

    let status = "Proposed";
    if (fmMatch) {
      const s = fmMatch[1].match(/decision_status:\s*([^\n]+)/);
      if (s) {
        const raw = s[1].trim().toLowerCase();
        if (raw === "accepted") status = "Accepted";
        else if (raw === "rejected") status = "Rejected";
        else if (raw === "superseded") status = "Superseded";
        else if (raw === "proposed") status = "Proposed";
        else status = s[1].trim();
      }
    }

    // 针对替代和历史的展示状态微调
    let displayStatus = status;
    if (id === "ADR-002") displayStatus = "Superseded by ADR-015";
    else if (id === "ADR-008") displayStatus = "Superseded by CR-030";
    else if (id === "ADR-003") displayStatus = "Accepted（经 CR-030 修订）";

    adrs.push({ id, file, title, status, displayStatus });
  }

  adrs.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return adrs;
}

export function generateAdrReadmeTable(adrs) {
  const lines = [
    "| ADR | 状态 | 决策 | 独立记录 |",
    "|---|---|---|---|",
  ];
  for (const a of adrs) {
    lines.push(`| ${a.id} | ${a.displayStatus} | ${a.title} | [${a.id}](${a.file}) |`);
  }
  return lines.join("\n");
}

export function generateArchitectureAdrTable(adrs) {
  const lines = [
    "| ADR | 状态 | 决策 |",
    "|---|---|---|",
  ];
  for (const a of adrs) {
    lines.push(`| [${a.id}](adr/${a.file}) | ${a.displayStatus} | ${a.title} |`);
  }
  return lines.join("\n");
}

export function injectSection(content, generated, startMarker = START_MARKER, endMarker = END_MARKER) {
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx === -1 || startIdx >= endIdx) {
    return null;
  }
  return (
    content.slice(0, startIdx + startMarker.length) +
    "\n" +
    generated +
    "\n" +
    content.slice(endIdx)
  );
}

export function run(checkOnly = false) {
  const adrs = collectAdrs();
  const readmeTable = generateAdrReadmeTable(adrs);
  const archTable = generateArchitectureAdrTable(adrs);

  let hasDiff = false;

  // 1. ADR README
  const readmeContent = readFileSync(ADR_README_PATH, "utf8");
  const newReadme = injectSection(readmeContent, readmeTable);
  if (!newReadme) {
    console.error(`❌ 未能在 ${ADR_README_PATH} 中找到 ${START_MARKER} 和 ${END_MARKER}`);
    return false;
  }
  if (newReadme !== readmeContent) {
    hasDiff = true;
    if (checkOnly) {
      console.error(`❌ ${ADR_README_PATH} 中的 ADR 表格与 ADR 事实源不一致，请运行 mise tasks run docs-render`);
    } else {
      writeFileSync(ADR_README_PATH, newReadme, "utf8");
      console.log(`✔ 已更新 ${ADR_README_PATH} 中的 ADR 表格`);
    }
  }

  // 2. ARCHITECTURE.md
  const archContent = readFileSync(ARCHITECTURE_PATH, "utf8");
  const newArch = injectSection(archContent, archTable);
  if (!newArch) {
    console.error(`❌ 未能在 ${ARCHITECTURE_PATH} 中找到 ${START_MARKER} 和 ${END_MARKER}`);
    return false;
  }
  if (newArch !== archContent) {
    hasDiff = true;
    if (checkOnly) {
      console.error(`❌ ${ARCHITECTURE_PATH} 中的 ADR 表格与 ADR 事实源不一致，请运行 mise tasks run docs-render`);
    } else {
      writeFileSync(ARCHITECTURE_PATH, newArch, "utf8");
      console.log(`✔ 已更新 ${ARCHITECTURE_PATH} 中的 ADR 表格`);
    }
  }

  if (!hasDiff) {
    console.log(`✔ ADR 索引与真源完全一致（共 ${adrs.length} 项）`);
    return true;
  }

  return !checkOnly;
}

if (process.argv[1]?.endsWith("render-adr-index.mjs")) {
  const isCheck = process.argv.includes("--check");
  const ok = run(isCheck);
  if (!ok) {
    process.exit(1);
  }
}
