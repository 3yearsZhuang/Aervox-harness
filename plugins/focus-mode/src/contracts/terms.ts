import { z } from 'zod';

export const extractedTermSchema = z.object({
  text: z.string().min(1),
  relation: z.enum(['background', 'related']),
  description: z.string().optional(),
});
export type ExtractedTerm = z.infer<typeof extractedTermSchema>;

// ============ 回合流事件：术语抽取 ============

/** Browser and server consume the same event and response schemas. */
export const termsExtractedEventDataSchema = z.object({
  turnId: z.string().min(1),
  messageId: z.string().optional(),
  terms: z.array(extractedTermSchema),
});

export type TermsExtractedEventData = z.infer<typeof termsExtractedEventDataSchema>;

/** 插件自有流事件类型（内核枚举之外，经登记表声明） */
export const TERMS_EXTRACTED_EVENT = "terms_extracted";

// ============ 概念探索端点契约 ============

/** 追问探索方向类型 */
export const termExploreKindSchema = z.enum([
  "child",   // 深挖下钻（原理/前置细节）
  "related", // 对比发散（异同/应用场景）
  "branch",  // 分支对话（创建独立分支会话）
]);

/** 追问探索请求体（POST `/v1/terms/explore` 与 POST `/v1/hierarchy/explore`） */
export const termExploreRequestSchema = z.object({
  term: z.string().min(1),
  kind: termExploreKindSchema.default("child"),
  context: z.string().optional(),
  sessionId: z.string().optional(),
});

/** 追问探索响应体 */
export const termExploreResponseSchema = z.object({
  term: z.string(),
  kind: termExploreKindSchema,
  content: z.string(),
  relatedQuestions: z.array(z.string()).default([]),
  childSessionId: z.string().optional(),
});

export type TermExploreKind = z.infer<typeof termExploreKindSchema>;
export type TermExploreRequest = z.infer<typeof termExploreRequestSchema>;
export type TermExploreResponse = z.infer<typeof termExploreResponseSchema>;

