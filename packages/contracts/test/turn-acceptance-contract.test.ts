import { describe, expect, it } from "vitest";
import { buildOpenApiDocument, createTurnResponseSchema, replayTurnResponseSchema, turnStatusSchema } from "../src/index.js";

const resources = { turnId: "turn", eventsUrl: "/v1/turns/turn/events", cancelUrl: "/v1/turns/turn/cancel" };
describe("Turn acceptance response contracts", () => {
  it("keeps 201 fixed to Created while replay accepts the persisted lifecycle status", () => {
    for (const status of turnStatusSchema.options) {
      expect(replayTurnResponseSchema.parse({ ...resources, status })).toEqual({ ...resources, status });
      expect(createTurnResponseSchema.safeParse({ ...resources, status }).success).toBe(status === "Created");
    }
    expect(replayTurnResponseSchema.safeParse({ ...resources, status: "unknown" }).success).toBe(false);
    expect(replayTurnResponseSchema.safeParse({ turnId: "turn", status: "Completed" }).success).toBe(false);
  });

  it("documents replay separately from new acceptance and an intent conflict", () => {
    const responses = buildOpenApiDocument().paths["/v1/sessions/{sessionId}/turns"]?.post?.responses;
    expect(responses?.[200]).toMatchObject({ content: { "application/json": { schema: {
      required: ["turnId", "status", "eventsUrl", "cancelUrl"],
      properties: { status: { enum: [...turnStatusSchema.options] } },
    } } } });
    expect(responses?.[201]).toMatchObject({ content: { "application/json": { schema: {
      properties: { status: { enum: ["Created"] } },
    } } } });
    expect(responses?.[409]).toBeDefined();
  });
});
