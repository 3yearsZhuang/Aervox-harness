import type { FastifyReply, FastifyRequest } from "fastify";

/** A normal request-body close is not a cancellation; a premature response close is. */
export async function withRequestSignal<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const close = () => { if (!reply.raw.writableFinished) abort(); };
  request.raw.once("aborted", abort);
  reply.raw.once("close", close);
  if (request.raw.aborted || reply.raw.destroyed) abort();
  try { return await operation(controller.signal); }
  finally {
    request.raw.off("aborted", abort);
    reply.raw.off("close", close);
  }
}
