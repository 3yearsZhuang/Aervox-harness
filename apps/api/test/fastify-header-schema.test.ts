import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

describe("Fastify header-name schema normalization", () => {
  it.each([
    { enum: ["X-Debug-Override"] },
    { const: "X-Debug-Override" },
  ])("blocks canonical-case propertyNames constraints before dispatch: %j", async forbiddenName => {
    const app = Fastify();
    const handler = vi.fn(async () => ({ accepted: true }));
    app.get("/header-policy", {
      schema: { headers: { type: "object", propertyNames: { not: forbiddenName } } },
    }, handler);
    try {
      for (const header of ["X-Debug-Override", "x-debug-override", "X-DeBuG-OVERRIDE"]) {
        const response = await app.inject({ url: "/header-policy", headers: { [header]: "1" } });
        expect(response.statusCode).toBe(400);
      }
      expect(handler).not.toHaveBeenCalled();
      const allowed = await app.inject({ url: "/header-policy", headers: { "X-Allowed": "1" } });
      expect(allowed.statusCode).toBe(200);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
