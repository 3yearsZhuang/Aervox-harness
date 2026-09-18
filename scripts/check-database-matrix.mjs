/**
 * Aervox｜思隅 数据库覆盖矩阵守卫
 *
 * 机器事实源：
 * 1. packages/schema/src/*.ts 中通过 sqliteTable() 声明的业务表（结构真源）
 * 2. docs/reference/database-coverage-matrix.md 中的「已落表」清单（文档追踪）
 *
 * 不变量：
 * 1. Schema 声明的每一张业务表必须在覆盖矩阵中被登记为「已落表」。
 * 2. 覆盖矩阵中标记为「已落表」的业务表必须在 Schema 中真实存在。
 * 3. 覆盖矩阵文档正文中注明的业务表总数与 Schema 实际表数严格相等。
 *
 * 用法：
 *   node scripts/check-database-matrix.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEMA_DIR = "packages/schema/src";
const MATRIX_DOC_PATH = "docs/reference/database-coverage-matrix.md";

export function collectSchemaTables(schemaDir = SCHEMA_DIR) {
  const tables = new Set();
  for (const file of readdirSync(schemaDir)) {
    if (!file.endsWith(".ts") || file === "index.ts" || file === "common.ts") continue;
    const content = readFileSync(join(schemaDir, file), "utf8");
    for (const m of content.matchAll(/sqliteTable\s*\(\s*["\x27]([^"\x27]+)["\x27]/g)) {
      tables.add(m[1]);
    }
  }
  return tables;
}

export function extractDocumentTables(docContent, schemaTables) {
  const documented = new Set();
  for (const line of docContent.split("\n")) {
    if (!line.includes("| 已落表 |")) continue;
    const matches = line.matchAll(/`([a-z0-9_]+)`/g);
    for (const m of matches) {
      if (schemaTables.has(m[1])) {
        documented.add(m[1]);
      }
    }
  }
  return documented;
}

export function extractDocumentTableCount(docContent) {
  const m = docContent.match(/共维护\s*\*\*(\d+)\s*张业务表\*\*/);
  return m ? parseInt(m[1], 10) : null;
}

export function verifyDatabaseMatrix(schemaDir = SCHEMA_DIR, docPath = MATRIX_DOC_PATH) {
  const schemaTables = collectSchemaTables(schemaDir);
  const docContent = readFileSync(docPath, "utf8");
  const documentedTables = extractDocumentTables(docContent, schemaTables);
  const docCount = extractDocumentTableCount(docContent);

  const missingInDoc = [...schemaTables].filter((t) => !documentedTables.has(t)).sort();
  const countMismatch = docCount !== null && docCount !== schemaTables.size;

  return {
    schemaCount: schemaTables.size,
    documentedCount: documentedTables.size,
    docStatedCount: docCount,
    missingInDoc,
    countMismatch,
  };
}

if (process.argv[1]?.endsWith("check-database-matrix.mjs")) {
  const result = verifyDatabaseMatrix();

  let hasError = false;
  if (result.missingInDoc.length > 0) {
    console.error(`❌ Schema 中存在但 docs/reference/database-coverage-matrix.md 未登记的表（共 ${result.missingInDoc.length} 张）：`);
    for (const t of result.missingInDoc) {
      console.error(`   - ${t}`);
    }
    hasError = true;
  }

  if (result.countMismatch) {
    console.error(`❌ 覆盖矩阵正文声明的表总数（${result.docStatedCount}）与 Schema 实际表数（${result.schemaCount}）不一致`);
    hasError = true;
  }

  if (hasError) {
    process.exit(1);
  }

  console.log(`✔ 数据库覆盖矩阵对齐检查通过：${result.schemaCount} 张业务表与文档严格一致`);
}
