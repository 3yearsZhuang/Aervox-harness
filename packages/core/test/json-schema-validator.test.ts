import { describe, expect, it } from "vitest";
import { validateJsonSchema } from "../src/json-schema-validator.js";

describe("validateJsonSchema (Core Zero-dependency Schema Validator)", () => {
  it("无 schema 或空对象时通过任何参数", () => {
    expect(validateJsonSchema(undefined, { foo: "bar" }).valid).toBe(true);
    expect(validateJsonSchema(null, 123).valid).toBe(true);
    expect(validateJsonSchema({}, "hello").valid).toBe(true);
  });

  it("校验对象类型与必填字段", () => {
    const schema = {
      type: "object",
      properties: {
        noteTitle: { type: "string" },
        content: { type: "string" },
        importance: { type: "integer", minimum: 1, maximum: 5 },
      },
      required: ["noteTitle", "content"],
    };

    // 缺少必填字段
    const missingRes = validateJsonSchema(schema, { noteTitle: "My Note" });
    expect(missingRes.valid).toBe(false);
    expect(missingRes.errors?.[0]).toMatchObject({
      path: "content",
      keyword: "required",
    });

    // 字段类型错误
    const wrongTypeRes = validateJsonSchema(schema, {
      noteTitle: "My Note",
      content: 12345,
    });
    expect(wrongTypeRes.valid).toBe(false);
    expect(wrongTypeRes.errors?.[0]).toMatchObject({
      path: "content",
      keyword: "type",
    });

    // 数值范围校验
    const outOfRangeRes = validateJsonSchema(schema, {
      noteTitle: "My Note",
      content: "Hello",
      importance: 10,
    });
    expect(outOfRangeRes.valid).toBe(false);
    expect(outOfRangeRes.errors?.[0]).toMatchObject({
      path: "importance",
      keyword: "maximum",
    });

    // 合法参数
    const validRes = validateJsonSchema(schema, {
      noteTitle: "My Note",
      content: "Valid body",
      importance: 3,
    });
    expect(validRes.valid).toBe(true);
    expect(validRes.errors).toBeUndefined();
  });

  it("校验 enum 枚举约束", () => {
    const schema = {
      type: "object",
      properties: {
        action: { enum: ["create", "update", "delete"] },
      },
      required: ["action"],
    };

    expect(validateJsonSchema(schema, { action: "create" }).valid).toBe(true);
    const invalid = validateJsonSchema(schema, { action: "drop_database" });
    expect(invalid.valid).toBe(false);
    expect(invalid.errors?.[0].keyword).toBe("enum");
  });

  it("校验嵌套数组与 items 约束", () => {
    const schema = {
      type: "object",
      properties: {
        tags: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
        },
      },
      required: ["tags"],
    };

    expect(validateJsonSchema(schema, { tags: [] }).valid).toBe(false);
    expect(validateJsonSchema(schema, { tags: ["tech", "ai"] }).valid).toBe(true);
    expect(validateJsonSchema(schema, { tags: ["tech", 123] }).valid).toBe(false);
  });

  it("校验禁止额外属性 additionalProperties: false", () => {
    const schema = {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
      additionalProperties: false,
    };

    expect(validateJsonSchema(schema, { id: "1" }).valid).toBe(true);
    const extra = validateJsonSchema(schema, { id: "1", rogueField: true });
    expect(extra.valid).toBe(false);
    expect(extra.errors?.[0].keyword).toBe("additionalProperties");
  });
});
