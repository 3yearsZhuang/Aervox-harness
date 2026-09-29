import { z } from "zod";
import { messageEventDataSchema, deltaEventDataSchema, reasoningDeltaEventDataSchema,
  doneEventDataSchema, errorEventDataSchema, redactedEventDataSchema, emoteEventDataSchema,
  userQuestionRequiredEventDataSchema, userQuestionAnsweredEventDataSchema,
  toolApprovalRequiredEventDataSchema, termsExtractedEventDataSchema } from "./schemas.js";

const publicSchemas: Record<string, z.ZodType> = {
  message: messageEventDataSchema.partial(), delta: deltaEventDataSchema.partial(),
  reasoning_delta: reasoningDeltaEventDataSchema.partial(),
  done: doneEventDataSchema.partial().extend({ status: z.string().optional(), reason: z.string().optional() }),
  error: errorEventDataSchema.partial().extend({ code: z.string().optional() }),
  redacted: redactedEventDataSchema.partial(), emote: emoteEventDataSchema,
  user_question_required: userQuestionRequiredEventDataSchema,
  user_question_answered: userQuestionAnsweredEventDataSchema,
  tool_approval_required: toolApprovalRequiredEventDataSchema,
  terms_extracted: termsExtractedEventDataSchema,
  // Tool implementation payloads stay in the owner ledger; public progress is minimal.
  tool_request: z.object({ invocationId: z.string(), executionId: z.string().optional(), name: z.string() }),
  tool_result: z.object({ invocationId: z.string(), executionId: z.string().optional(), name: z.string(), ok: z.boolean(), error: z.string().optional() }),
};

const practiceResultSchema = z.object({
  questionId: z.string(),
  attemptId: z.string(),
  judgement: z.enum(["correct", "incorrect", "partial"]),
  enteredMistakeNotebook: z.boolean(),
});

/** Schema allowlists apply identically to live events and persisted replay, including nested DTOs. */
export function projectSafeEventData(eventType: string, data: unknown): unknown {
  const result = Object.hasOwn(publicSchemas, eventType) ? publicSchemas[eventType]!.safeParse(data) : undefined;
  if (!result?.success) return {};
  if (eventType === "tool_result" && typeof data === "object" && data !== null) {
    const tool = data as Record<string, unknown>;
    if (tool.name === "record_practice_attempt") {
      const output = practiceResultSchema.safeParse(tool.output);
      if (output.success) return { ...result.data as object, output: output.data };
    }
  }
  return result.data;
}
