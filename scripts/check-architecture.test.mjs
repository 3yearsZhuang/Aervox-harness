import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectDependency, findCycles, auditArchitecture } from "./check-architecture.mjs";
import { extractImports, resolveRepoRelative } from "./source-imports.mjs";

test("architecture rejects inverted dependencies even when old blacklist permits them", () => {
  for (const [from,to] of [["core","ui"],["schema","host-runtime"],["sync-runtime","repositories"],["api-client","core"]]) {
    assert.match(inspectDependency(`@aervox/${from}`, `@aervox/${to}`), /not allowed/);
  }
  assert.equal(inspectDependency("@aervox/host-runtime", "@aervox/core"), null);
  assert.equal(inspectDependency("@aervox/repositories", "@aervox/sync-runtime"), null);
});
test("runtime and type cycles both remain visible", () => {
  const edges = [{from:"a",to:"b",kind:"runtime"},{from:"b",to:"a",kind:"type"}];
  assert.deepEqual(findCycles(edges), [["a","b"]]);
  assert.deepEqual(findCycles(edges,"runtime"), []);
});
test("shared parser classifies imports and exports including Vue, TSImportType and dynamic literal", () => {
  const source = `<script lang="ts">import type { X } from "a"; import { type Y } from "b"; export type { Z } from "c"; type P = import("d").P; const p = import("e");</script>`;
  assert.deepEqual(extractImports(source, "x.vue"), [
    {specifier:"a",kind:"type"},{specifier:"b",kind:"type"},{specifier:"c",kind:"type"},{specifier:"d",kind:"type"},{specifier:"e",kind:"runtime"},
  ]);
  assert.throws(() => extractImports('import(`a/${x}`)', "x.ts", true), /动态导入/);
  assert.deepEqual(extractImports('const a = require("a"); import b = require("b");', "x.ts"), [
    {specifier:"a",kind:"runtime"},{specifier:"b",kind:"runtime"},
  ]);
});
test("governed sources reject nonliteral import and require rather than hiding dependency edges", () => {
  for (const source of ['import(`@aervox/${name}`)', 'require(name)']) {
    assert.throws(() => extractImports(source, "packages/core/src/hidden.ts", true), /动态导入/);
  }
});
test("Vue external scripts are runtime edges and malformed script blocks fail closed", () => {
  for (const source of ['<script src="../other.ts"></script>', "<script src='../other.ts' />", '<script src=../other.ts></script>', '<script src=../other.ts/>']) {
    assert.deepEqual(extractImports(source, "x.vue", true), [{specifier:"../other.ts",kind:"runtime"}]);
  }
  assert.deepEqual(extractImports('<!-- <script src="ignored.ts"></script> --><script lang="ts">const html = "<script>"; import type { X } from "visible";</script>', "x.vue", true), [{specifier:"visible",kind:"type"}]);
  assert.throws(() => extractImports('<script lang="ts">import "hidden";', "x.vue", true), /unclosed Vue script/);
  assert.throws(() => extractImports('<script src="&#46;&#46;/hidden.ts"></script>', "x.vue", true), /explicit static path/);
});
test("URL query/hash suffixes cannot hide workspace or source dependencies", () => {
  assert.equal(resolveRepoRelative("packages/core/src/index.ts", "../../ui/src/index.js?raw#view"), "packages/ui/src/index.ts");
  for (const target of ["../../ui/src/index.js?raw#view", "@aervox/ui?raw#view"]) {
    const result = auditArchitecture({ sources: new Map([["packages/core/src/hidden.ts", `import "${target}";`]]) });
    assert.ok(result.violations.some(violation => violation.includes("@aervox/core -> @aervox/ui")));
  }
});
test("all product sources fail closed on nonexistent relative dependencies", () => {
  for (const source of ['import "./missing-source.js";', 'require("./missing-source.js");', 'import(name);']) {
    const result = auditArchitecture({ sources: new Map([["packages/core/src/hidden.ts", source]]) });
    assert.equal(result.violations.length, 1);
    assert.match(result.violations[0], /cannot be resolved|动态导入/);
  }
});
test("application aliases cannot hide dependencies outside the application", () => {
  for (const [file, specifier, target] of [
    ["apps/desktop/src/renderer/src/hidden.ts", "@/../../../../../packages/host-runtime/src/index.js", "@aervox/desktop -> @aervox/host-runtime"],
    ["apps/web/src/hidden.ts", "@/../../../packages/core/src/index.js", "@aervox/web -> @aervox/core"],
  ]) {
    const result = auditArchitecture({ sources: new Map([[file, `import "${specifier}";`]]) });
    assert.ok(result.violations.some(violation => violation.includes(target)));
  }
});
