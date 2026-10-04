import test from "node:test";
import assert from "node:assert/strict";
import { discoverPluginSourceDirs, inspectFileForDuplicateTypes } from "./check-type-boundary.mjs";

test("check-type-boundary: detects duplicate interface declaration", () => {
  const code = `
    export interface CreatePersonaRequest {
      name: string;
    }
  `;
  const exported = new Set(["CreatePersonaRequest"]);
  const duplicates = inspectFileForDuplicateTypes("apps/api/src/foo.ts", code, exported);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].name, "CreatePersonaRequest");
});

test("check-type-boundary: detects duplicate type alias declaration", () => {
  const code = `
    export type PersonaDto = { id: string };
  `;
  const exported = new Set(["PersonaDto"]);
  const duplicates = inspectFileForDuplicateTypes("packages/api-client/src/foo.ts", code, exported);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].name, "PersonaDto");
});

test("check-type-boundary: ignores non-conflicting types", () => {
  const code = `
    export interface LocalInternalState {
      loading: boolean;
    }
  `;
  const exported = new Set(["CreatePersonaRequest"]);
  const duplicates = inspectFileForDuplicateTypes("apps/web/src/foo.ts", code, exported);
  assert.equal(duplicates.length, 0);
});

test("check-type-boundary: inspects vue script blocks", () => {
  const vueCode = `
<script setup lang="ts">
interface SpritePetProps {
  name: string;
}
</script>
<template><div></div></template>
  `;
  const exported = new Set(["SpritePetProps"]);
  const duplicates = inspectFileForDuplicateTypes("packages/ui/src/Pet.vue", vueCode, exported);
  assert.equal(duplicates.length, 1);
  assert.equal(duplicates[0].name, "SpritePetProps");
});

test("check-type-boundary: 插件实现目录纳入扫描根（CR-060 覆盖缺陷回归）", () => {
  // 插件目录必须被发现，否则插件内重复声明 @aervox/contracts 导出类型会整体漏检
  const dirs = discoverPluginSourceDirs();
  assert.ok(dirs.length > 0, "应至少发现一个 plugins/<id>/src 目录");
  assert.ok(dirs.every((d) => d.startsWith("plugins/") && d.endsWith("/src")));
  assert.ok(dirs.includes("plugins/focus-mode/src"), `未发现 focus-mode 插件目录：${dirs.join(", ")}`);
});

test("check-type-boundary: 插件目录内的重复类型声明同样被判定为违规", () => {
  const code = `
    export interface CreateTurnRequest {
      message: string;
    }
  `;
  const duplicates = inspectFileForDuplicateTypes(
    "plugins/focus-mode/src/ui/foo.ts",
    code,
    new Set(["CreateTurnRequest"]),
  );
  assert.equal(duplicates.length, 1);
});
