import { z } from "zod";
import type { ApiEndpoint } from "./http-api.js";

/** Subject and feedback types remain extensible; the host owns the audit actor. */
export const createFeedbackRequestSchema = z.object({
  subjectType: z.string().min(1),
  subjectId: z.string().min(1),
  type: z.string().min(1),
  note: z.string().nullable().optional(),
});

/** Preserve historical row strings and the database's nullable note. */
export const feedbackResponseSchema = z.object({
  id: z.string(),
  actorId: z.string(),
  subjectType: z.string(),
  subjectId: z.string(),
  type: z.string(),
  note: z.string().nullable(),
  createdAt: z.string(),
});
export const feedbackListResponseSchema = z.object({ items: z.array(feedbackResponseSchema) });
export const feedbackListQuerySchema = z.object({ subjectType: z.string().optional(), subjectId: z.string().optional() });

export const feedbackApi = {
  create: {
    method: "post", path: "/v1/feedback", operationId: "post_v1_feedback",
    summary: "记录本地质量反馈", tags: ["Feedback"],
    body: createFeedbackRequestSchema, bodyRequired: true, response: feedbackResponseSchema, status: 201,
    validationErrorMessage: "subjectType, subjectId and type are required",
    errors: { 400: "subjectType, subjectId and type are required" },
  },
  list: {
    method: "get", path: "/v1/feedback", operationId: "get_v1_feedback",
    summary: "查询本地质量反馈", tags: ["Feedback"],
    query: feedbackListQuerySchema,
    response: feedbackListResponseSchema, errors: { 400: "Invalid query" },
  },
} as const satisfies Record<string, ApiEndpoint>;

export type CreateFeedbackRequest = z.input<typeof createFeedbackRequestSchema>;
export type FeedbackResponse = z.output<typeof feedbackResponseSchema>;
export type FeedbackListQuery = z.input<typeof feedbackListQuerySchema>;
