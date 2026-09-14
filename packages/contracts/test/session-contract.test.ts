/**
 * CR-035 W1 会话管理契约测试
 */
import { describe, it, expect } from "vitest";
import {
  sessionItemSchema,
  listSessionsResponseSchema,
  createSessionRequestSchema,
  renameSessionRequestSchema,
  openApiDocument,
} from "../src/index.js";

describe("Session Management Contracts (CR-035 / W1)", () => {
  it("validates sessionItemSchema correctly", () => {
    const valid = {
      id: "ses_123",
      title: "微积分讨论",
      createdAt: "2026-09-14T10:00:00.000Z",
      updatedAt: "2026-09-14T10:05:00.000Z",
      isPinned: true,
      group: "高数",
    };
    expect(sessionItemSchema.parse(valid)).toEqual(valid);

    // Missing id or title
    expect(() => sessionItemSchema.parse({ title: "abc" })).toThrow();
    expect(() => sessionItemSchema.parse({ id: "ses_1" })).toThrow();
  });

  it("validates listSessionsResponseSchema correctly", () => {
    const empty = { items: [] };
    expect(listSessionsResponseSchema.parse(empty)).toEqual(empty);

    const populated = {
      items: [
        {
          id: "ses_1",
          title: "Session 1",
          createdAt: "2026-09-14T10:00:00.000Z",
          updatedAt: "2026-09-14T10:05:00.000Z",
        },
      ],
    };
    expect(listSessionsResponseSchema.parse(populated)).toEqual(populated);
  });

  it("validates createSessionRequestSchema properly", () => {
    expect(createSessionRequestSchema.parse({})).toEqual({});
    expect(createSessionRequestSchema.parse({ title: "新会话" })).toEqual({ title: "新会话" });
    expect(createSessionRequestSchema.parse({ id: "ses_custom", title: "自定义" })).toEqual({
      id: "ses_custom",
      title: "自定义",
    });
    // title too long
    expect(() => createSessionRequestSchema.parse({ title: "a".repeat(201) })).toThrow();
  });

  it("validates renameSessionRequestSchema properly", () => {
    expect(renameSessionRequestSchema.parse({ title: "重命名会话" })).toEqual({ title: "重命名会话" });
    expect(() => renameSessionRequestSchema.parse({ title: "" })).toThrow();
    expect(() => renameSessionRequestSchema.parse({ title: "a".repeat(201) })).toThrow();
  });

  it("registers session routes in openApiDocument", () => {
    const paths = openApiDocument.paths;
    expect(paths).toBeDefined();
    expect(paths?.["/v1/sessions"]?.get).toBeDefined();
    expect(paths?.["/v1/sessions"]?.post).toBeDefined();
    expect(paths?.["/v1/sessions/{sessionId}"]?.patch).toBeDefined();
    expect(paths?.["/v1/sessions/{sessionId}"]?.delete).toBeDefined();
  });
});
