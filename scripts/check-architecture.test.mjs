import { test } from "node:test";
import assert from "node:assert/strict";
import { inspectDependency, findCycles, auditArchitecture, inspectLazySchemaImport } from "./check-architecture.mjs";
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


test("workspace source resolution follows exact exports and plugin UI/server subpaths", () => {
  const from = "apps/web/src/App.vue";
  for (const [specifier, target] of [
    ["@aervox/core", "packages/core/src/index.ts"],
    ["@aervox/plugin-focus-mode/ui", "plugins/plugins/ui/focus-mode/src/ui/index.ts"],
    ["@aervox/plugin-focus-mode/server", "plugins/plugins/ui/focus-mode/src/server/index.ts"],
    ["@aervox/plugin-bot-onebot/server", "plugins/plugins/bot/onebot/src/server/index.ts"],
    ["@aervox/plugin-bot-weixin/server", "plugins/plugins/bot/weixin/src/server/index.ts"],
    ["@aervox/contracts/proactive", "packages/contracts/src/proactive.ts"],
    ["@aervox/ui/env", "packages/ui/src/env.d.ts"],
  ]) assert.equal(resolveRepoRelative(from, specifier), target);
  assert.equal(resolveRepoRelative(from, "@aervox/plugin-focus-mode/not-exported"), null);
  // Private host targets remain discoverable for rejection by import/removability guards.
  assert.equal(resolveRepoRelative(from, "@aervox/host-runtime/modules/companion/memory/tool-contribution"),
    "packages/host-runtime/src/modules/companion/memory/tool-contribution.ts");
});

test("resolver supports conditional and wildcard exports without using built artifacts", () => {
  const workspaces = [{ name: "@aervox/sample", relDir: "packages/sample", manifest: { exports: {
    ".": { import: { types: "./dist/index.d.mts", default: "./dist/index.mjs" } },
    "./feature/*": { types: "./dist/feature/*.d.ts", default: "./dist/feature/*.js" },
  } } }];
  const files = new Set(["packages/sample/src/index.mts", "packages/sample/src/feature/one.ts"]);
  assert.equal(resolveRepoRelative("apps/web/src/a.ts", "@aervox/sample", { workspaces, files }), "packages/sample/src/index.mts");
  assert.equal(resolveRepoRelative("apps/web/src/a.ts", "@aervox/sample/feature/one", { workspaces, files }), "packages/sample/src/feature/one.ts");
});

test("full file graph catches shared/context runtime cycles hidden by direct module graphs", () => {
  const a = "packages/host-runtime/src/modules/context.ts", b = "packages/host-runtime/src/shared/audit-helper.ts";
  const result = auditArchitecture({ sources: new Map([[a, 'import "../shared/audit-helper.js"'], [b, 'import "../modules/context.js"']]) });
  assert.deepEqual(result.graphs.workspace.runtimeCycles, []);
  assert.deepEqual(result.graphs.directModule.runtimeCycles, []);
  assert.deepEqual(result.graphs.file.runtimeCycles, [[a, b].sort()]);
  assert.ok(result.violations.some(value => value.includes("source file runtime dependency cycle")));
});

test("type-inclusive file SCCs report real members without becoming runtime-cycle violations", () => {
  const a = "packages/core/src/audit-a.ts", b = "packages/core/src/audit-b.ts";
  const result = auditArchitecture({ sources: new Map([[a, 'import type { B } from "./audit-b.js"'], [b, 'import { a } from "./audit-a.js"']]) });
  assert.deepEqual(result.graphs.file.runtimeCycles, []);
  assert.deepEqual(result.graphs.file.combinedCycles, [[a, b]]);
  assert.deepEqual(result.violations, []);
});

test("source self imports are runtime cycles too", () => {
  const file = "packages/core/src/audit-self.ts";
  const result = auditArchitecture({ sources: new Map([[file, 'import "./audit-self.js"']]) });
  assert.deepEqual(result.graphs.file.runtimeCycles, [[file]]);
  assert.ok(result.violations.some(value => value.includes("runtime dependency cycle")));
});

test("the exact lazy Schema exception cannot authorize eager table access or other file cycles", () => {
  const resolve = () => "packages/schema/src/provenance.ts";
  const lazy = 'import { memoryRevisions } from "./provenance.js"; const fk = text("id").references(() => memoryRevisions.id);';
  assert.equal(inspectLazySchemaImport(lazy, "x.ts", resolve(), ["memoryRevisions"], resolve), true);
  assert.equal(inspectLazySchemaImport(lazy + " console.log(memoryRevisions.id);", "x.ts", resolve(), ["memoryRevisions"], resolve), false);
  assert.equal(inspectLazySchemaImport(lazy + ' export { unrelated } from "./provenance.js";', "x.ts", resolve(), ["memoryRevisions"], resolve), false);
  assert.equal(inspectLazySchemaImport(lazy.replace("memoryRevisions.id", "memoryRevisions"), "x.ts", resolve(), ["anotherTable"], resolve), false);
  const a = "packages/schema/src/audit-a.ts", b = "packages/schema/src/audit-b.ts";
  const result = auditArchitecture({ sources: new Map([[a, 'import "./audit-b.js"'], [b, 'import "./audit-a.js"']]) });
  assert.equal(result.approvedRuntimeCycles.length, 0);
  assert.ok(result.violations.some(value => value.includes("runtime dependency cycle")));
});

test("TypeScript import type equals require remains an erased edge", () => {
  assert.deepEqual(extractImports('import type Value = require("type-only");', "x.ts", true), [{ specifier: "type-only", kind: "type" }]);
});
