import { describe, expect, it } from "vitest";
import { openApiDocument } from "@aervox/contracts";

describe("复习 API 契约", () => {
  it("声明复习列表、汇总与幂等完成接口", () => {
    expect(openApiDocument.paths).toMatchObject({
      "/v1/review-items": { get: expect.any(Object) },
      "/v1/review-items/summary": { get: expect.any(Object) },
      "/v1/review-items/history": { get: expect.any(Object) },
      "/v1/review-items/{reviewId}/complete": {
        post: {
          responses: {
            200: expect.any(Object),
            400: expect.any(Object),
            404: expect.any(Object),
            409: expect.any(Object),
          },
        },
      },
    });
  });
});
