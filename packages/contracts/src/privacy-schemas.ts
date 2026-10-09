import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
extendZodWithOpenApi(z);

/** Explicit targets are committed with the request; unsupported scopes stay denied. */
export const createDeletionRequestSchema = z.object({
  scope: z.string().min(1),
  ownerModule: z.string().min(1),
  idempotencyKey: z.string().min(1).optional(),
  targets: z.array(z.object({
    targetType: z.string().min(1), targetId: z.string().min(1), ownerModule: z.string().min(1),
  })).min(1).max(100).optional(),
});
