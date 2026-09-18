import test from "node:test";
import assert from "node:assert/strict";
import { collectAdrs, generateAdrReadmeTable, generateArchitectureAdrTable, injectSection } from "./render-adr-index.mjs";

test("render-adr-index: collects all ADRs with proper ids", () => {
  const adrs = collectAdrs();
  assert.ok(adrs.length >= 19);
  assert.equal(adrs[0].id, "ADR-001");
  assert.equal(adrs[0].status, "Accepted");
});

test("render-adr-index: generates valid markdown tables", () => {
  const adrs = [
    { id: "ADR-001", file: "ADR-001.md", title: "测试", status: "Accepted", displayStatus: "Accepted" }
  ];
  const readmeTable = generateAdrReadmeTable(adrs);
  assert.ok(readmeTable.includes("| ADR-001 | Accepted | 测试 | [ADR-001](ADR-001.md) |"));

  const archTable = generateArchitectureAdrTable(adrs);
  assert.ok(archTable.includes("| [ADR-001](adr/ADR-001.md) | Accepted | 测试 |"));
});

test("render-adr-index: injects section between markers", () => {
  const content = "before\n<!-- ADR_TABLE_START -->\nold\n<!-- ADR_TABLE_END -->\nafter";
  const updated = injectSection(content, "new");
  assert.equal(updated, "before\n<!-- ADR_TABLE_START -->\nnew\n<!-- ADR_TABLE_END -->\nafter");
});
