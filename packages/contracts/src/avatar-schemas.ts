/**
 * Aervox｜思隅 @aervox/contracts — 桌宠虚拟形象包规范（Avatar Bundle Specification, CAP-018）
 *
 * 核心目标：
 * - 统一 Live2D（Cubism 3/4）、3D VRM（v1）、2D Sprite Sheet 等不同表现引擎的虚拟形象打包规范；
 * - 抽象语义动作映射（Semantic Motion Mapping）：将高层交互意图（greet, happy, think, nod, farewell 等）
 *   与具体底层模型的 motion/expression/clip 解耦；
 * - 声明交互触碰区域（Hit Areas）、气泡挂载锚点（Bubble Anchor）及表现层渲染器适配要求。
 */
import { z } from "zod";
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";

extendZodWithOpenApi(z);

export const avatarEngineTypeSchema = z.enum([
  "live2d-v3",
  "vrm-v1",
  "sprite-2d",
]);

export const avatarSemanticMotionKindSchema = z.enum([
  "idle",
  "greet",
  "happy",
  "farewell",
  "think",
  "nod",
  "shake",
  "forward",
  "tilthead",
  "sad",
  "expand",
  "collapse",
  "celebrate",
  "comfort",
]);

export const avatarPoseSchema = z.object({
  motion: z.string().optional(),
  expression: z.string().optional(),
  description: z.string().optional(),
});

export const avatarHitAreaSchema = z.object({
  name: z.string().min(1),
  id: z.string().min(1),
  reactionKind: avatarSemanticMotionKindSchema.optional(),
});

export const avatarAnchorSchema = z.object({
  x: z.number(),
  y: z.number(),
});

export const avatarManifestSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().default("1.0.0"),
  engine: avatarEngineTypeSchema,
  entrypoint: z.string().min(1),
  author: z.string().optional(),
  description: z.string().optional(),
  previewImage: z.string().optional(),
  scale: z.number().positive().default(1.0),
  bubbleAnchor: avatarAnchorSchema.optional(),
  hitAreas: z.array(avatarHitAreaSchema).optional(),
  semanticMotions: z.record(z.string(), z.array(z.string())).default({}),
  semanticExpressions: z.record(z.string(), z.array(z.string())).optional(),
  poses: z.record(z.string(), z.array(avatarPoseSchema)).optional(),
});

export type AvatarEngineType = z.infer<typeof avatarEngineTypeSchema>;
export type AvatarSemanticMotionKind = z.infer<typeof avatarSemanticMotionKindSchema>;
export type AvatarPose = z.infer<typeof avatarPoseSchema>;
export type AvatarHitArea = z.infer<typeof avatarHitAreaSchema>;
export type AvatarManifest = z.infer<typeof avatarManifestSchema>;
