import { describe, expect, it } from "vitest";
import { HostToolRuntime, InMemoryToolRegistry, HostToolValidationError, validateJsonSchema } from "../src/index.js";

describe("tool schema regression boundaries", () => {
  it("accepts structural object and array enum values but rejects extra members", () => {
    const schema = { enum: [{ action: "save", payload: { content: "ok", tags: [1, "two"] } }] };
    expect(validateJsonSchema(schema, { payload: { tags: [1, "two"], content: "ok" }, action: "save" }).valid).toBe(true);
    expect(validateJsonSchema(schema, { action: "save", payload: { content: "ok", tags: [1, "two", 3] } }).valid).toBe(false);
    expect(validateJsonSchema({ enum: [[{ value: 1 }]] }, JSON.parse('[[{"value":1}]]')[0]).valid).toBe(true);
  });

  it.each(["constructor", "toString", "__proto__"])("treats %s as undeclared unless explicitly owned by properties", key => {
    const value = JSON.parse(`{"${key}":"injected"}`);
    expect(validateJsonSchema({ type: "object", properties: {}, additionalProperties: false }, value).valid).toBe(false);
    expect(validateJsonSchema({ type: "object", required: [key] }, {}).valid).toBe(false);
    const properties = JSON.parse(`{"${key}":{"type":"string"}}`);
    expect(validateJsonSchema({ type: "object", properties, required: [key], additionalProperties: false }, value).valid).toBe(true);
  });

  it("enforces boolean schemas and dictionary value schemas", () => {
    expect(validateJsonSchema(false, {}).valid).toBe(false);
    expect(validateJsonSchema({ type: "object", properties: { forbidden: false } }, { forbidden: 1 }).valid).toBe(false);
    expect(validateJsonSchema({ type: "array", items: false }, [1]).valid).toBe(false);
    const schema = { type: "object", additionalProperties: { type: "integer" } };
    expect(validateJsonSchema(schema, { a: 1 }).valid).toBe(true);
    expect(validateJsonSchema(schema, { a: "1" }).valid).toBe(false);
  });

  it("rejects non-finite JavaScript numbers as JSON numbers", () => {
    expect(validateJsonSchema({ type: "number" }, Infinity).valid).toBe(false);
    expect(validateJsonSchema({ type: "number" }, NaN).valid).toBe(false);
  });

  it("dispatches a real registered handler for a structurally equal enum argument", async () => {
    const registry = new InMemoryToolRegistry();
    const runtime = new HostToolRuntime({ registry });
    await registry.registerTool({ id: "enum-tool", name: "enum_tool", description: "enum", category: "test", safetyLevel: "read_only",
      inputSchema: { type: "object", properties: { value: { enum: [{ action: "save" }] } }, required: ["value"], additionalProperties: false } });
    let calls = 0;
    runtime.registerHandler("enum-tool", { async call(_ctx, args) { calls++; return args; } });
    const args = JSON.parse('{"value":{"action":"save"}}');
    await expect(runtime.callTool({workspaceId:"local",subjectUserId:"local"}, "enum-tool", args)).resolves.toEqual(args);
    await expect(runtime.callTool({workspaceId:"local",subjectUserId:"local"}, "enum-tool", {value:{action:"delete"}}))
      .rejects.toThrow(HostToolValidationError);
    expect(calls).toBe(1);
    await runtime.dispose();
  });
});
