import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const createMemoryNodeRequestSchema = z.object({
  label: z.string().trim().min(1),
  nodeType: z.string().min(1).optional(),
  canonicalParentId: z.string().min(1).nullable().optional(),
  confidence: z.number().int().optional(),
}).strict().openapi("CreateMemoryNodeRequest");

export const memoryNodeSchema = z.object({
  id: z.string().min(1), label: z.string(), nodeType: z.string(),
  canonicalParentId: z.string().nullable(), confidence: z.number().int(),
  status: z.string(), projectionVersion: z.number().int(),
  createdAt: z.string(), updatedAt: z.string(),
}).openapi("MemoryNode");

export const listMemoryNodesResponseSchema = z.object({ items: z.array(memoryNodeSchema) }).openapi("ListMemoryNodesResponse");
export type CreateMemoryNodeRequest = z.infer<typeof createMemoryNodeRequestSchema>;
export type MemoryNode = z.infer<typeof memoryNodeSchema>;
