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
