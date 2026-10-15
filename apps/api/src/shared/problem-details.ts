import { STATUS_CODES } from "node:http";
import type { FastifyInstance } from "fastify";
import type { ApiProblem } from "@aervox/contracts";

/** Normalize failed JSON responses, including direct replies and Fastify parser errors. */
export function registerProblemDetails(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    if (reply.statusCode < 400 || reply.statusCode > 599 || typeof payload !== "string") return payload;
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (!/application\/(?:json|problem\+json)(?:;|$)/i.test(contentType)) return payload;
    let value: unknown;
    try { value = JSON.parse(payload); } catch { return payload; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return payload;
    const received = value as Record<string, unknown>;
    // Legacy routes sometimes reply with an exception message directly instead of throwing.
    // A generic 500 must not turn that diagnostic into a public Problem Details message.
    const legacy: Record<string, unknown> = reply.statusCode === 500 ? {
      error: "Internal Server Error",
      code: typeof received.code === "string" ? received.code : "INTERNAL_ERROR",
      message: "Internal Server Error",
    } : received;
    const title = STATUS_CODES[reply.statusCode] ?? "HTTP Error";
    const message = typeof legacy.message === "string" ? legacy.message
      : typeof legacy.detail === "string" ? legacy.detail
      : typeof legacy.error === "string" ? legacy.error : title;
    const problem: ApiProblem = {
      ...legacy,
      type: typeof legacy.type === "string" ? legacy.type : "about:blank",
      title: typeof legacy.title === "string" ? legacy.title : title,
      status: reply.statusCode,
      detail: message,
      code: typeof legacy.code === "string" ? legacy.code : `HTTP_${reply.statusCode}`,
      message,
      requestId: request.id,
    };
    // URLs may contain query credentials or private text; a request id is the diagnostic handle.
    reply.header("Content-Type", "application/problem+json; charset=utf-8");
    return JSON.stringify(problem);
  });
}
