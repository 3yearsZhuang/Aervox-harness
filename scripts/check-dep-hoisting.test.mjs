import test from "node:test";
import assert from "node:assert/strict";
import { inspectSubpackage } from "./check-dep-hoisting.mjs";

test("check-dep-hoisting: detects forbidden tools in subpackages", () => {
  const pkgJson = {
    name: "@aervox/bad-pkg",
    devDependencies: {
      vitest: "4.0.0",
    },
  };
  const rootDevDeps = new Set(["vitest"]);
  const violations = inspectSubpackage("packages/bad-pkg", pkgJson, rootDevDeps);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].dep, "vitest");
  assert.ok(violations[0].reason.includes("FORBIDDEN_IN_SUBPACKAGES"));
});

test("check-dep-hoisting: detects unallowed duplicate devDependencies", () => {
  const pkgJson = {
    name: "@aervox/bad-pkg",
    devDependencies: {
      "fflate": "0.8.2",
    },
  };
  const rootDevDeps = new Set(["fflate"]);
  const violations = inspectSubpackage("packages/bad-pkg", pkgJson, rootDevDeps);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].dep, "fflate");
});

test("check-dep-hoisting: allows explicitly allowlisted splits", () => {
  const pkgJson = {
    name: "@aervox/ui",
    devDependencies: {
      typescript: "^5.8.3",
    },
  };
  const rootDevDeps = new Set(["typescript"]);
  const violations = inspectSubpackage("packages/ui", pkgJson, rootDevDeps);
  assert.equal(violations.length, 0);
});

test("check-dep-hoisting: passes for clean subpackage", () => {
  const pkgJson = {
    name: "@aervox/clean-pkg",
    dependencies: {
      fastify: "^5.0.0",
    },
    devDependencies: {},
  };
  const rootDevDeps = new Set(["vitest", "turbo"]);
  const violations = inspectSubpackage("packages/clean-pkg", pkgJson, rootDevDeps);
  assert.equal(violations.length, 0);
});

test("research dependencies belong to their private workspace, not root tools", () => {
  assert.deepEqual(inspectSubpackage("research/deletion-fault-testing", { dependencies: { "@libsql/client": "0.17.0" } }, new Set()), []);
});

test('independent Core declares only its bounded development tools at the exact mount', () => {
  const tools = { typescript: '7.0.2', vitest: '4.1.12', esbuild: '0.28.2' };
  const pkg = { name: '@aervox/core', devDependencies: tools };
  assert.deepEqual(inspectSubpackage('packages/core', pkg, new Set(Object.keys(tools))), []);
  assert.ok(inspectSubpackage('packages/other', pkg, new Set(Object.keys(tools))).length);
  assert.ok(inspectSubpackage('packages/core', { ...pkg, name: '@example/other' }, new Set(Object.keys(tools))).length);
  assert.ok(inspectSubpackage('packages/core', { ...pkg, dependencies: { vitest: '4.1.12' } }, new Set(Object.keys(tools))).some(v => v.dep === 'vitest'));
  assert.ok(inspectSubpackage('packages/core', { ...pkg, devDependencies: { ...tools, turbo: '2' } }, new Set(Object.keys(tools))).some(v => v.dep === 'turbo'));
});
