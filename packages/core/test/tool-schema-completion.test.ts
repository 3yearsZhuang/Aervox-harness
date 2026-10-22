import { describe, expect, it, vi } from "vitest";
import { HostToolRuntime, validateJsonSchema } from "../src/index.js";

describe("bounded tool schema assertions", () => {
  it.each([
    [{ const: { operation: "read" } }, { operation: "write" }, "const"],
    [{ anyOf: [{ type: "integer" }, { type: "boolean" }] }, "wrong", "anyOf"],
    [{ oneOf: [{ type: "integer" }, { type: "number" }] }, 1, "oneOf"],
    [{ allOf: [{ type: "number" }, { minimum: 1 }] }, 0, "allOf"],
    [{ not: { const: "forbidden" } }, "forbidden", "not"],
    [{ type: "number", exclusiveMinimum: 1 }, 1, "exclusiveMinimum"],
    [{ type: "number", exclusiveMaximum: 1 }, 1, "exclusiveMaximum"],
    [{ type: "number", multipleOf: 0.1 }, 0.15, "multipleOf"],
    [{ type: "array", uniqueItems: true }, [{ a: 1, b: 2 }, { b: 2, a: 1 }], "uniqueItems"],
    [{ type: "object", minProperties: 1 }, {}, "minProperties"],
    [{ type: "object", maxProperties: 0 }, { a: 1 }, "maxProperties"],
  ])("enforces %j against invalid input", (schema, data, keyword) => {
    expect(validateJsonSchema(schema, data)).toMatchObject({ valid: false, errors: [{ keyword }] });
  });

  it("accepts matching combinations, decimal multiples, annotations and extension metadata", () => {
    const schema = {
      title: "Tool arguments", description: "Supported subset", "x-origin": "host",
      type: "object", required: ["value"], additionalProperties: false,
      properties: { value: {
        allOf: [{ anyOf: [{ type: "number" }, { type: "null" }] }, { not: { const: null } }],
        oneOf: [{ multipleOf: 0.1 }, { const: "unused" }], exclusiveMinimum: 0,
      } },
    };
    expect(validateJsonSchema(schema, { value: 0.3 }).valid).toBe(true);
  });

  it("counts Unicode code points for string limits", () => {
    expect(validateJsonSchema({ type: "string", minLength: 1, maxLength: 1 }, "😀").valid).toBe(true);
    expect(validateJsonSchema({ type: "string", minLength: 2 }, "😀").valid).toBe(false);
  });

  it("checks decimal multiples without large-quotient tolerance or floating underflow", () => {
    expect(validateJsonSchema({ multipleOf: 1 }, 1_000_000_000_000_000.5).valid).toBe(false);
    expect(validateJsonSchema({ multipleOf: Number.MAX_VALUE }, Number.MIN_VALUE).valid).toBe(false);
    expect(validateJsonSchema({ multipleOf: 0.1 }, 0.30000000000000004).valid).toBe(false);
    expect(validateJsonSchema({ multipleOf: 1e-301 }, 1e-300).valid).toBe(true);
    expect(validateJsonSchema({ multipleOf: 0.1 }, -0.3).valid).toBe(true);
  });

  it.each(["2026-02-30", "1900-02-29", "2026-13-01", "2026-1-01"])("rejects invalid calendar date %s", date => {
    expect(validateJsonSchema({ type: "string", format: "date" }, date).valid).toBe(false);
  });

  it("accepts leap years for the date format used by integration tools", () => {
    expect(validateJsonSchema({ type: "string", format: "date" }, "2000-02-29").valid).toBe(true);
    expect(validateJsonSchema({ type: "string", format: "date" }, "2028-02-29").valid).toBe(true);
  });

  it.each([
    { pattern: "^safe$" }, { format: "email" }, { $ref: "#/definitions/value" },
    { anyOf: [{ type: "string" }, { pattern: "unselected" }] },
    { type: "object", properties: { unused: { pattern: "unselected" } } },
  ])("rejects unsupported assertions throughout schema %j", schema => {
    expect(validateJsonSchema(schema, {})).toMatchObject({ valid: false, errors: [{ keyword: "unsupported_schema" }] });
  });

  it.each([
    "not a schema", [], { type: "unknown" }, { type: [] }, { type: ["string", "string"] },
    { required: [1] }, { required: ["a", "a"] }, { properties: [] }, { properties: { a: null } },
    { items: null }, { anyOf: [] }, { enum: [] }, { enum: [{ a: 1 }, { a: 1 }] },
    { minLength: -1 }, { maxItems: 0.5 }, { uniqueItems: "true" }, { multipleOf: 0 },
  ])("rejects malformed schema %j", schema => {
    expect(validateJsonSchema(schema, {})).toMatchObject({ valid: false, errors: [{ keyword: "invalid_schema" }] });
  });

  it.each([undefined, NaN, Infinity, 1n, () => {}, new Date(), new Array(1), { value: undefined }])(
    "rejects non-JSON values even for an open schema: %s", data => {
      expect(validateJsonSchema({}, data)).toMatchObject({ valid: false, errors: [{ keyword: "json_value" }] });
    },
  );

  it("preserves the root no-schema convention and accepts plain null-prototype objects", () => {
    expect(validateJsonSchema(undefined, undefined).valid).toBe(true);
    expect(validateJsonSchema(null, undefined).valid).toBe(true);
    expect(validateJsonSchema(true, {}).valid).toBe(true);
    expect(validateJsonSchema({}, Object.assign(Object.create(null), { value: 1 })).valid).toBe(true);
  });

  it("rejects accessors without invoking them or a Symbol.toStringTag getter", () => {
    const get = vi.fn(() => "secret");
    const data = Object.defineProperty({}, "value", { enumerable: true, get });
    Object.defineProperty(data, Symbol.toStringTag, { get });
    expect(validateJsonSchema({}, data).valid).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects cycles but permits shared non-cyclic objects", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(validateJsonSchema({}, cyclic)).toMatchObject({ valid: false, errors: [{ keyword: "json_value" }] });
    expect(validateJsonSchema(cyclic, {})).toMatchObject({ valid: false, errors: [{ keyword: "json_value" }] });
    const shared = { value: 1 };
    expect(validateJsonSchema({}, { left: shared, right: shared }).valid).toBe(true);
  });

  it("bounds input depth, schema traversal, combinator evaluation and error output", () => {
    let nested: unknown = 1;
    let schema: unknown = {};
    for (let i = 0; i < 70; i++) {
      nested = { value: nested };
      schema = { properties: { value: schema } };
    }
    for (const result of [validateJsonSchema({}, nested), validateJsonSchema(schema, {})]) {
      expect(result).toMatchObject({ valid: false, errors: [{ keyword: "validation_limit" }] });
    }
    expect(validateJsonSchema({}, Array.from({ length: 20_001 }, () => 0)))
      .toMatchObject({ valid: false, errors: [{ keyword: "validation_limit" }] });
    for (const value of ['x'.repeat(20_001), { ['x'.repeat(20_001)]: 1 }]) {
      expect(validateJsonSchema({}, value))
        .toMatchObject({ valid: false, errors: [{ keyword: "validation_limit" }] });
    }
    expect(validateJsonSchema({ description: 'x'.repeat(20_001) }, {}))
      .toMatchObject({ valid: false, errors: [{ keyword: "validation_limit" }] });
    const exhaustive = { allOf: Array.from({ length: 200 }, () => ({ uniqueItems: true })) };
    expect(validateJsonSchema(exhaustive, Array.from({ length: 100 }, (_, i) => i)))
      .toMatchObject({ valid: false, errors: [{ keyword: "validation_limit" }] });
    const failures = validateJsonSchema({ items: false }, Array.from({ length: 200 }, () => 0));
    expect(failures.valid).toBe(false);
    expect(failures.errors).toHaveLength(100);
  });

  it.each([
    [{ type: "object", properties: { operation: { const: "read" } } }, { operation: "write" }],
    [{ type: "object", properties: { value: { anyOf: [{ type: "integer" }, { type: "null" }] } } }, { value: "bad" }],
    [{ type: "object", properties: { date: { type: "string", format: "date" } } }, { date: "2026-02-30" }],
    [{ type: "object", properties: { unused: { pattern: "^safe$" } } }, {}],
  ])("blocks registered handlers for invalid or unsupported schema %j", async (inputSchema, data) => {
    const runtime = new HostToolRuntime();
    const call = vi.fn(async () => "side effect");
    try {
      await runtime.registerContribution({ id: "strict", name: "strict", description: "strict", category: "test",
        safetyLevel: "write_with_approval", inputSchema }, { call });
      await expect(runtime.callTool({ workspaceId: "local", subjectUserId: "local" }, "strict", data, { approval: true }))
        .rejects.toMatchObject({ code: "SCHEMA_VALIDATION_FAILED" });
      expect(call).not.toHaveBeenCalled();
    } finally { await runtime.dispose(); }
  });
});
