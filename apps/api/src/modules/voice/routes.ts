/**
 * Aervox｜思隅 @aervox/api — 语音服务 HTTP 路由
 */
import type { FastifyInstance } from "fastify";
import { voiceSynthesisRequestSchema } from "@aervox/contracts";
import type { VoiceService } from "./service.js";

function asBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

export function registerVoiceRoutes(app: FastifyInstance, service: VoiceService): void {
  app.get("/v1/voice/models", async () => {
    const models = await service.listModels();
    return { models };
  });

  app.post("/v1/voice/synthesize", async (request, reply) => {
    const parsed = voiceSynthesisRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        code: "INVALID_VOICE_REQUEST",
        message: "Invalid voice synthesis request",
        details: parsed.error.issues,
      });
    }
    if (!service.hasProvider(parsed.data.providerId)) {
      return reply.code(503).send({
        code: "VOICE_PROVIDER_UNAVAILABLE",
        message: `Voice provider ${parsed.data.providerId} is unavailable`,
      });
    }
    try {
      const artifact = await service.synthesize(parsed.data.providerId, parsed.data);
      return {
        providerId: artifact.providerId,
        modelId: artifact.modelId,
        contentType: artifact.contentType,
        audioBase64: asBase64(artifact.bytes),
      };
    } catch (error) {
      return reply.code(503).send({
        code: "VOICE_PROVIDER_UNAVAILABLE",
        message: error instanceof Error ? error.message : "Voice synthesis failed",
      });
    }
  });
}
