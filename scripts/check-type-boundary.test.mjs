import test from "node:test";
import assert from "node:assert/strict";
import { inspectFileForDuplicateTypes } from "./check-type-boundary.mjs";

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
