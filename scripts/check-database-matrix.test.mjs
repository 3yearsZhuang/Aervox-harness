import test from "node:test";
import assert from "node:assert/strict";
import { extractDocumentTables, extractDocumentTableCount } from "./check-database-matrix.mjs";

test("check-database-matrix: extracts documented tables", () => {
  const sampleDoc = `
### 14.1 会话
| PRD 实体 | 阶段 | 实现状态 | 说明 / 对应表 |
|---|---|---|---|
| Session | MVP | 已落表 | \`sessions\`（会话表） |
| Message | MVP | 已落表 | \`messages\` 身份表与 \`message_versions\` |
| Other | P2 | 未落表 | \`ghost_table\` 未落表 |
  `;
  const schemaTables = new Set(["sessions", "messages", "message_versions"]);
  const documented = extractDocumentTables(sampleDoc, schemaTables);

  assert.equal(documented.size, 3);
  assert.ok(documented.has("sessions"));
  assert.ok(documented.has("messages"));
  assert.ok(documented.has("message_versions"));
  assert.ok(!documented.has("ghost_table"));
});

test("check-database-matrix: extracts stated count", () => {
  const sample = "当前代码库 `@aervox/schema` 共维护 **131 张业务表**，另有 2 张虚拟表";
  const count = extractDocumentTableCount(sample);
  assert.equal(count, 131);
});
