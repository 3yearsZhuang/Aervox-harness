/**
 * Aervox｜思隅 包拓扑守卫
 *
 * 机器事实源：docs/reference/ARCHITECTURE.md §3「仓库与领域边界」。
 * 规则：
 * 1. apps/ 与 packages/ 下的所有工作区包/目录必须在 ARCHITECTURE.md §3 中显式登记并附有说明。
 * 2. ARCHITECTURE.md §3 中声明的包路径必须在文件系统中真实存在。
 *
 * 用法：
 *   node scripts/check-architecture-topology.mjs
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ARCHITECTURE_MD_PATH = "docs/reference/ARCHITECTURE.md";

export function getDiskPackages() {
  const packages = [];
  for (const root of ["apps", "packages"]) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root)) {
      const dirPath = join(root, entry);
      if (entry.startsWith(".")) continue;
      // 检查是否为目录
      try {
        if (existsSync(join(dirPath, "package.json"))) {
          packages.push(`${root}/${entry}`);
        }
      } catch {
        // ignore
      }
    }
  }
  return packages.sort();
}

export function parseArchitecturePackages(docContent) {
  const sectionMatch = docContent.match(/## 3\.\s*仓库与领域边界[\s\S]*?```text([\s\S]*?)```/);
  if (!sectionMatch) {
    throw new Error("未能定位 ARCHITECTURE.md 中的 ## 3. 仓库与领域边界 代码块");
  }

  const blockText = sectionMatch[1];
  const declared = [];
  let currentGroup = "";

  for (const line of blockText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("apps/")) {
      currentGroup = "apps";
      continue;
    }
    if (trimmed.startsWith("packages/")) {
      currentGroup = "packages";
      continue;
    }
    if (currentGroup) {
      // 匹配 "  name/      # 说明" 或 "name/ name2/" 格式
      const m = trimmed.match(/^([a-zA-Z0-9_-]+)\//);
      if (m) {
        declared.push(`${currentGroup}/${m[1]}`);
      } else {
        // 匹配单行多个包的情况，如 "contracts/ identity-consent/"
        const parts = trimmed.split(/\s+/);
        for (const part of parts) {
          const sub = part.match(/^([a-zA-Z0-9_-]+)\//);
          if (sub && !sub[1].startsWith("#")) {
            declared.push(`${currentGroup}/${sub[1]}`);
          }
        }
      }
    }
  }

  return [...new Set(declared)].sort();
}

export function inspectTopology(docContent, diskPkgs = getDiskPackages()) {
  const declaredPkgs = parseArchitecturePackages(docContent);
  const declaredSet = new Set(declaredPkgs);
  const diskSet = new Set(diskPkgs);

  const missingInDoc = diskPkgs.filter((p) => !declaredSet.has(p));
  const missingOnDisk = declaredPkgs.filter((p) => !diskSet.has(p));

  return { declaredPkgs, diskPkgs, missingInDoc, missingOnDisk };
}

if (process.argv[1]?.endsWith("check-architecture-topology.mjs")) {
  const doc = readFileSync(ARCHITECTURE_MD_PATH, "utf8");
  const { missingInDoc, missingOnDisk, declaredPkgs, diskPkgs } = inspectTopology(doc);

  let hasError = false;
  if (missingInDoc.length > 0) {
    console.error(`❌ 文件系统中存在但 ARCHITECTURE.md §3 未登记的包：\n  ${missingInDoc.join("\n  ")}`);
    hasError = true;
  }
  if (missingOnDisk.length > 0) {
    console.error(`❌ ARCHITECTURE.md §3 中声明但文件系统中不存在的包：\n  ${missingOnDisk.join("\n  ")}`);
    hasError = true;
  }

  if (hasError) {
    process.exit(1);
  }

  console.log(`✔ 包拓扑一致性检查通过：共 ${diskPkgs.length} 个工作区目录与 ARCHITECTURE.md §3 完全对齐`);
}
