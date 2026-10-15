import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ApiEndpoint } from "@aervox/contracts";
import { ApiError } from "./errors.js";

/** Register a JSON endpoint from its shared descriptor, validating both boundaries. */
export function registerContractRoute(
  app: FastifyInstance,
  endpoint: ApiEndpoint,
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>,
): void {
  app.route({
    method: endpoint.method.toUpperCase() as "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: endpoint.path.replace(/\{([^}]+)\}/g, ":$1"),
    config: { operationId: endpoint.operationId },
    async handler(request, reply) {
      for (const field of ["params", "body"] as const) {
        const schema = endpoint[field];
        if (!schema) continue;
        const parsed = schema.safeParse(request[field]);
        if (!parsed.success) {
          return reply.code(400).send({
            code: endpoint.validationErrorCode ?? "VALIDATION_FAILED", message: `Invalid ${field}`, details: parsed.error.issues,
          });
        }
        request[field] = parsed.data;
      }
      const result = await handler(request, reply);
      if (reply.sent || reply.statusCode >= 400) return result;
      const parsed = endpoint.response.safeParse(result);
      if (!parsed.success) throw new ApiError("INTERNAL_ERROR", 500, "API response does not match its contract");
      return reply.code(endpoint.status ?? 200).send(parsed.data);
    },
  });
}
