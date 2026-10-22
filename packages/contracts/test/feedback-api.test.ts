import { describe, expect, it } from "vitest";
import { createFeedbackRequestSchema, feedbackApi, feedbackResponseSchema,
  feedbackListResponseSchema, feedbackListQuerySchema, buildOpenApiDocument } from "../src/index.js";

const input = { subjectType: "plugin:subject", subjectId: "subject", type: "plugin:feedback" };
const row = { ...input, id: "feedback", actorId: "server_actor", note: null, createdAt: "2026-10-22T00:00:00Z" };
describe("feedback public contract", () => {
  it("strips body ownership identifiers and keeps optional nullable notes and extension strings", () => {
    expect(createFeedbackRequestSchema.parse({ ...input, actorId: "forged", subjectUserId: "forged", note: null })).toEqual({ ...input, note: null });
    expect(createFeedbackRequestSchema.parse(input)).toEqual(input);
    expect(createFeedbackRequestSchema.parse({ ...input, note: "" }).note).toBe("");
    expect(createFeedbackRequestSchema.parse({ subjectType: " ", subjectId: "\t", type: "\n", note: "" })).toEqual({ subjectType: " ", subjectId: "\t", type: "\n", note: "" });
  });

  it("requires string fields and rejects malformed objects, arrays and notes", () => {
    for (const body of [[], [input], {}, null, { ...input, subjectType: {} }, { ...input, subjectId: [] },
      { ...input, type: 1 }, { ...input, note: false }, { ...input, note: {} }, { ...input, note: [] }]) {
      expect(createFeedbackRequestSchema.safeParse(body).success).toBe(false);
    }
  });

  it("requires every persisted row field and the list items envelope", () => {
    expect(feedbackResponseSchema.parse(row)).toEqual(row);
    for (const key of Object.keys(row)) {
      const missing = { ...row }; delete missing[key];
      expect(feedbackResponseSchema.safeParse(missing).success, key).toBe(false);
    }
    expect(feedbackListResponseSchema.parse({ items: [row] })).toEqual({ items: [row] });
    expect(feedbackListResponseSchema.safeParse({}).success).toBe(false);
    expect(feedbackListResponseSchema.safeParse({ items: [{}] }).success).toBe(false);
  });

  it("accepts missing, empty and single string query fields but rejects repeated arrays", () => {
    for (const query of [{}, { subjectType: "" }, { subjectId: "" }, { subjectType: "plugin" },
      { subjectId: "id" }, { subjectType: "plugin", subjectId: "id" }]) {
      expect(feedbackListQuerySchema.parse(query)).toEqual(query);
    }
    for (const query of [{ subjectType: ["a", "b"] }, { subjectId: ["a", "b"] }, { subjectType: {} }]) {
      expect(feedbackListQuerySchema.safeParse(query).success).toBe(false);
    }
  });

  it("publishes the same create/list descriptors and required authenticated request/response schemas", () => {
    const doc = buildOpenApiDocument(); const endpoint = doc.paths?.["/v1/feedback"];
    expect(endpoint?.post?.operationId).toBe(feedbackApi.create.operationId);
    expect(endpoint?.get?.operationId).toBe(feedbackApi.list.operationId);
    expect(endpoint?.post?.requestBody).toMatchObject({ required: true });
    expect(endpoint?.post?.responses?.[201]).toBeDefined(); expect(endpoint?.get?.responses?.[200]).toBeDefined();
    expect(doc.security).toEqual([{ bearerAuth: [] }]);
    expect(feedbackApi.create.body).toBe(createFeedbackRequestSchema);
    expect(feedbackApi.list.query).toBe(feedbackListQuerySchema);
  });
});
