import test from "node:test";
import assert from "node:assert/strict";
import { inspectFile, extractIdentifiers, RULES } from "./check-banned-identifiers.mjs";

test("check-banned-identifiers: detects TenantContext across files", () => {
  const code = `
    import type { TenantContext } from "./types.js";
    export function doWork(ctx: TenantContext) {}
  `;
  const violations = inspectFile("packages/my-pkg/src/service.ts", code);
  assert.equal(violations.length, 3);
  assert.equal(violations[0].identifier, "TenantContext");
  assert.equal(violations[0].rule, "ban-tenant-context-global");
});

test("check-banned-identifiers: detects tenantId outside allowlist", () => {
  const code = `
    export function getUser(tenantId: string) { return tenantId; }
  `;
  const violations = inspectFile("apps/api/src/modules/foo.ts", code);
  assert.equal(violations.length, 2);
  assert.equal(violations[0].identifier, "tenantId");
  assert.equal(violations[0].rule, "ban-tenant-id-code");
});

test("check-banned-identifiers: allows tenantId in migrations and DDL", () => {
  const code = `
    export function up(knex) {
      table.string("tenant_id").notNull();
      const tenantId = "legacy";
    }
  `;
  const violations = inspectFile("packages/repositories/src/migration/001.ts", code);
  assert.equal(violations.length, 0);

  const ddlViolations = inspectFile("packages/repositories/src/schema/ddl/content.ts", code);
  assert.equal(ddlViolations.length, 0);
});

test("check-banned-identifiers: detects tenant identifier in contracts/schema/proactive", () => {
  const code = `
    export function run(tenant: LocalContext) {
      console.log(tenant);
    }
  `;
  const contractViolations = inspectFile("packages/contracts/src/foo.ts", code);
  assert.equal(contractViolations.length, 2);
  assert.equal(contractViolations[0].identifier, "tenant");
  assert.equal(contractViolations[0].rule, "ban-tenant-core-packages");

  const proactiveViolations = inspectFile("apps/worker/src/proactive/turn.ts", code);
  assert.equal(proactiveViolations.length, 2);
});

test("check-banned-identifiers: passes for clean code", () => {
  const code = `
    import type { LocalContext } from "@aervox/repositories";
    export function handle(ctx: LocalContext) {
      const { workspaceId, subjectUserId } = ctx;
      return { ok: true };
    }
  `;
  const violations = inspectFile("packages/contracts/src/foo.ts", code);
  assert.equal(violations.length, 0);
});
