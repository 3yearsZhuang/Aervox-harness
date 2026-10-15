import type { FastifyInstance, FastifyReply } from "fastify";
import { createBotConnectionRequestSchema, updateBotConnectionRequestSchema, confirmBotPairingRequestSchema } from "@aervox/contracts";
import { BotError, type BotManager } from "./manager.js";

export function registerBotRoutes(app: FastifyInstance, manager: BotManager) {
  const run = async (reply: FastifyReply, operation: () => Promise<unknown>) => {
    try { return await operation(); }
    catch (error) {
      return reply.code(error instanceof BotError ? error.statusCode : 500).send({
        code: error instanceof BotError ? error.message : "bot_operation_failed",
      });
    }
  };
  const invalid = (reply: FastifyReply) => reply.code(400).send({ code: "bot_invalid_request" });
  app.get("/v1/bot-adapters", async () => ({ adapters: manager.adapters() }));
  app.get("/v1/bot-connections", async (_req, reply) => run(reply, async () => ({ connections: await manager.list() })));
  app.post("/v1/bot-connections", async (req, reply) => {
    const parsed = createBotConnectionRequestSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply);
    return run(reply, async () => reply.code(201).send(await manager.create(parsed.data)));
  });
  app.patch<{ Params: { id: string } }>("/v1/bot-connections/:id", async (req, reply) => {
    const parsed = updateBotConnectionRequestSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply);
    return run(reply, () => manager.update(req.params.id, parsed.data));
  });
  app.delete<{ Params: { id: string } }>("/v1/bot-connections/:id", async (req, reply) => run(reply, async () => {
    await manager.remove(req.params.id); return reply.code(204).send();
  }));
  app.post<{ Params: { id: string } }>("/v1/bot-connections/:id/login", async (req, reply) => run(reply, () => manager.login(req.params.id, true)));
  app.get<{ Params: { id: string } }>("/v1/bot-connections/:id/login", async (req, reply) => run(reply, () => manager.login(req.params.id, false)));
  app.post<{ Params: { id: string } }>("/v1/bot-connections/:id/pairing", async (req, reply) => run(reply, () => manager.beginPairing(req.params.id)));
  app.get<{ Params: { id: string } }>("/v1/bot-connections/:id/pairing", async (req, reply) => run(reply, () => manager.pairing(req.params.id)));
  app.post<{ Params: { id: string } }>("/v1/bot-connections/:id/pairing/confirm", async (req, reply) => {
    const parsed = confirmBotPairingRequestSchema.safeParse(req.body);
    if (!parsed.success) return invalid(reply);
    return run(reply, () => manager.confirmPairing(req.params.id, parsed.data.senderId));
  });
  app.get<{ Params: { id: string } }>("/v1/bot-connections/:id/deliveries", async (req, reply) => run(reply, async () => ({ deliveries: await manager.deliveries(req.params.id) })));
  app.post<{ Params: { id: string; deliveryId: string } }>("/v1/bot-connections/:id/deliveries/:deliveryId/retry", async (req, reply) => run(reply, () => manager.retry(req.params.id, req.params.deliveryId)));
}
