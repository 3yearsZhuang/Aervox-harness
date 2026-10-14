import { test } from "node:test";
import assert from "node:assert/strict";
import { assessAudit } from "./check-dependency-audit.mjs";
const report = { advisories: { one: { github_advisory_id: "GHSA-test", module_name: "example", findings: [{ version: "1.0.0", paths: ["root>example"] }] } } };
const exception = { advisory: "GHSA-test", package: "example", version: "1.0.0", paths: ["root>example"], owner: "maintainers", reason: "reviewed use", expiresOn: "2026-11-13" };
test("exceptions apply to exact versions and paths and expire", () => {
  assert.equal(assessAudit(report, [exception], "2026-10-13").outstanding.length, 0);
  for (const changed of [{ version: "2.0.0" }, { paths: ["other>example"] }, { expiresOn: "2026-10-12" }, { expiresOn: "2026-99-99" }, { expiresOn: "2027-02-30" }, { reason: "" }]) {
    assert.equal(assessAudit(report, [{ ...exception, ...changed }], "2026-10-13").outstanding.length, 1);
  }
  assert.equal(assessAudit({ advisories: {} }, [exception]).stale.length, 1);
});
test("obsolete paths cannot hide behind another live path in the same exception", () => {
  const assessment = assessAudit(report, [{ ...exception, paths: ["root>example", "removed>example"] }], "2026-10-13");
  assert.equal(assessment.outstanding.length, 0);
  assert.equal(assessment.reviewed.length, 1);
  assert.deepEqual(assessment.stale, [{ ...exception, paths: ["removed>example"] }]);
});
test("malformed exceptions fail closed", () => {
  for (const malformed of [null, {}, [null], [{ ...exception, paths: [] }], [{ ...exception, paths: [3] }]]) {
    assert.throws(() => assessAudit(report, malformed));
  }
});
test("missing/error/malformed audit responses cannot appear green", () => {
  for (const malformed of [{}, { error: "unavailable", advisories: {} }, { advisories: [] }, { advisories: { one: {} } }]) {
    assert.throws(() => assessAudit(malformed, []));
  }
});
