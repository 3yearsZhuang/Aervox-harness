import test from "node:test";
import assert from "node:assert/strict";
import { discoverPluginSourceDirs, inspectFileForDuplicateTypes, inspectDtoDerivations, DTO_ALIAS_CONTRACTS, SCOPED_DTO_ALIAS_CONTRACTS, SCHEMA_TYPE_CONTRACTS } from "./check-type-boundary.mjs";

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

test("check-type-boundary: 插件实现目录纳入扫描根", () => {
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


test("check-type-boundary: malformed sources cannot silently bypass DTO ownership", () => {
  assert.throws(() => inspectFileForDuplicateTypes("apps/cli/src/broken.ts", "export interface X {", new Set(["X"])), /Cannot parse governed type source/);
});


test("migrated DTO aliases reject renamed handwritten DTOs without pretending to compare arbitrary structures", () => {
  const file = "packages/api-client/src/useAervoxMcp.ts";
  const source = 'export type { McpPresetServer as McpPresetDto, McpServerConfig as McpServerConfigDto, McpServerToolEntry as McpServerToolDto } from "@aervox/contracts";';
  assert.deepEqual(inspectDtoDerivations(file, source), []);
  assert.ok(inspectDtoDerivations(file, source + ' export interface RenamedPresetDto { id: string }').some(value => value.name === "RenamedPresetDto"));
  assert.ok(inspectDtoDerivations(file, source.replace("McpPresetServer", "McpServerConfig")).some(value => value.name === "McpPresetDto"));
});

test("an explicit public Schema type must preserve the declared Schema and infer/input/output direction", () => {
  const file = "packages/contracts/src/mcp-schemas.ts";
  const source = 'import { z } from "zod"; export type McpPresetServer = z.infer<typeof mcpPresetServerSchema>; export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>; export type McpServerToolEntry = z.infer<typeof mcpServerToolEntrySchema>;';
  assert.deepEqual(inspectDtoDerivations(file, source), []);
  assert.ok(inspectDtoDerivations(file, source.replace("z.infer<typeof mcpPresetServerSchema>", "{ id: string }")).some(value => value.name === "McpPresetServer"));
  assert.ok(inspectDtoDerivations(file, source.replace("z.infer<typeof mcpPresetServerSchema>", "z.input<typeof mcpServerConfigSchema>")).some(value => value.name === "McpPresetServer"));
});

test("consumer type imports can alias Contracts while independent adapter, storage and view-model types stay independent", () => {
  const file = "packages/api-client/src/useAervoxMcp.ts";
  const aliases = Object.entries(DTO_ALIAS_CONTRACTS.get(file)).map(([alias, original]) => `${original} as ${alias}`).join(", ");
  assert.deepEqual(inspectDtoDerivations(file, `import type { ${aliases} } from "@aervox/contracts"; interface McpViewState { loading: boolean }`), []);
  for (const file of ["packages/repositories/src/repositories/types/mcp-server.ts", "packages/host-runtime/src/modules/ecosystem/mcp/client.ts", "packages/ui/src/view-model.ts"]) {
    assert.deepEqual(inspectDtoDerivations(file, "export interface IndependentDto { storageKey: string }"), []);
  }
});

test("Persona request and response contracts preserve their shared Schema direction", () => {
  const file = "packages/contracts/src/persona-api.ts";
  const types = SCHEMA_TYPE_CONTRACTS.get(file);
  const source = 'import { z } from "zod";\n' + Object.entries(types).map(([name, [direction, schema]]) => `export type ${name} = z.${direction}<typeof ${schema}>;`).join("\n");
  assert.deepEqual(inspectDtoDerivations(file, source), []);
  assert.ok(inspectDtoDerivations(file, source.replace('z.input<typeof createPersonaRequestSchema>', '{ name: string }')).some(value => value.name === 'CreatePersonaRequest'));
});

test("Persona mixed owner forbids redeclaring each migrated alias without widening the unconverted tool and skill scope", () => {
  const file = "packages/api-client/src/useAervoxPersonas.ts";
  const aliases = Object.entries(SCOPED_DTO_ALIAS_CONTRACTS.get(file));
  const source = `import type { ${aliases.map(([alias, original]) => `${original} as ${alias}`).join(", ")} } from "@aervox/contracts";`;
  assert.deepEqual(inspectDtoDerivations(file, source + " export interface ToolItemDto { id: string } export interface SkillItemDto { id: string }"), []);
  for (const [alias, original] of aliases) {
    const remaining = aliases.filter(([name]) => name !== alias).map(([name, target]) => `${target} as ${name}`).join(", ");
    const handwritten = `import type { ${remaining} } from "@aervox/contracts"; export interface ${alias} { name: string }`;
    assert.ok(inspectDtoDerivations(file, handwritten).some(value => value.name === alias));
    const wrongAlias = source.replace(`${original} as ${alias}`, `PersonaMemoryScope as ${alias}`);
    assert.ok(inspectDtoDerivations(file, wrongAlias).some(value => value.name === alias));
  }
});
