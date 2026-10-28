// The check-*.test.mjs guard suite also verifies the physical drill's source transformations.
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { REMOVABLE_TARGETS } from "./check-removable-implementation.mjs";
import { applyRemovalStrips } from "./run-removability-drill.mjs";
import { extractSpecifiers } from "./source-imports.mjs";

const plugins = [
  { target: REMOVABLE_TARGETS.find((target) => target.id === "focus-mode-plugin"), package: "@aervox/plugin-focus-mode", variable: "firstPartyPlugin" },
  { target: REMOVABLE_TARGETS.find((target) => target.id === "flowcampus-plugin"), package: "@aervox/plugin-flowcampus", variable: "campusPlugin" },
];
const roots = [
  "packages/host-runtime/src/plugin-assembly.ts",
  "apps/web/src/App.vue",
  "apps/desktop/src/renderer/src/App.vue",
];
const manifests = [...new Set(plugins.flatMap(({ target }) => target.removalPlan.strips
  .map((strip) => strip.file).filter((file) => file.endsWith("package.json"))))];
const originals = new Map([...roots, ...manifests].map((file) => [file, readFileSync(file)]));

function assertRemovedPlugins(removed) {
  const before = new Map([...originals].map(([file, bytes]) => [file, Buffer.from(bytes)]));
  const result = applyRemovalStrips(originals, removed.map(({ target }) => target.removalPlan));
  for (const file of roots) {
    const source = result.get(file);
    const imports = extractSpecifiers(source, file);
    for (const plugin of plugins) {
      const absent = removed.includes(plugin);
      assert.equal(imports.some((specifier) => specifier.startsWith(`${plugin.package}/`)), !absent, file);
      if (file.endsWith(".vue")) {
        assert.equal(source.includes(`${plugin.variable}.default`), !absent, file);
        assert.match(source, /const pluginDefinitions: BuiltinUIPlugin\[\] = \[/, file);
        assert.match(source, /:plugins="pluginDefinitions"/, file);
      }
    }
  }
  for (const file of manifests) {
    const manifest = JSON.parse(result.get(file) ?? originals.get(file).toString());
    const prior = JSON.parse(originals.get(file).toString());
    const expected = structuredClone(prior);
    for (const section of ["dependencies", "devDependencies"]) {
      for (const plugin of plugins) {
        const version = removed.includes(plugin) ? undefined : prior[section]?.[plugin.package];
        assert.equal(manifest[section]?.[plugin.package], version, file);
      }
      for (const plugin of removed) if (expected[section]) delete expected[section][plugin.package];
    }
    assert.deepEqual(manifest, expected, file);
  }
  assert.deepEqual(originals, before, "备份字节不得被剥离操作改写");
  return [...result].sort(([a], [b]) => a.localeCompare(b));
}

for (const plugin of plugins) {
  test(`removability drill: 移除 ${plugin.target.id} 保留另一插件、共享装配与有效包清单`, () => {
    assertRemovedPlugins([plugin]);
  });
}

test("removability drill: 两插件共用文件累计剥离且与移除顺序无关", () => {
  assert.deepEqual(assertRemovedPlugins(plugins), assertRemovedPlugins([...plugins].reverse()));
});

test("removability drill: 同一计划在共享文件中的多条剥离累计生效", () => {
  const source = new Map([["App.vue", "import plugin from 'plugin';\nconst plugins = [plugin];\n"]]);
  const plan = { strips: [
    { file: "App.vue", pattern: "^import[^\\n]*\\n", flags: "m" },
    { file: "App.vue", pattern: "\\bplugin\\b", flags: "" },
  ] };
  assert.equal(applyRemovalStrips(source, [plan]).get("App.vue"), "const plugins = [];\n");
});

test("removability drill: 引用变更或缺失备份必须报错，不能空跑通过", () => {
  const plan = { strips: [{ file: "App.vue", pattern: "campusPlugin", flags: "g" }] };
  assert.throws(() => applyRemovalStrips(new Map(), [plan]), /未备份剥离目标/);
  assert.throws(() => applyRemovalStrips(new Map([["App.vue", "const plugins = [];"]]), [plan]), /未匹配到引用/);
});

test("removability drill: 依赖在清单首项、中间或末项均可移除", () => {
  const strip = plugins[1].target.removalPlan.strips.find((entry) => entry.file.endsWith("package.json"));
  const campus = [plugins[1].package, "workspace:*"];
  for (const entries of [
    [campus],
    [campus, ["vue", "3.5.43"]],
    [["vue", "3.5.43"], campus, ["zod", "4.6.7"]],
    [["vue", "3.5.43"], campus],
  ]) {
    const source = new Map([[strip.file, JSON.stringify({ dependencies: Object.fromEntries(entries) }, null, 2) + "\n"]]);
    const output = applyRemovalStrips(source, [{ strips: [strip] }]).get(strip.file);
    assert.deepEqual(JSON.parse(output).dependencies, Object.fromEntries(entries.filter(([name]) => name !== plugins[1].package)));
  }
});
