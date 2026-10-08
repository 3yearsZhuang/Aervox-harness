import { abortableStream } from "./abortable.js";
import type { ExecutionStorePort, ModelProviderPort } from "./ports.js";
import type { ContextManifestRecord } from "./types.js";

/** One immutable input snapshot per actual call, including retries and failed streams.
 * Diagnostic writes remain best effort; they are not a recovery or authorization ledger.
 */
export function createRecordingProvider(
  provider: ModelProviderPort,
  store: Pick<ExecutionStorePort, "recordModelRun" | "recordContextManifest">,
  meta?: { provider?: string; modelId?: string; purpose?: string },
): ModelProviderPort {
  let callNumber = 0;
  return {
    id: provider.id,
    async *stream(request) {
      const runId = `mr_${request.attemptId}_${request.step}_${++callNumber}`;
      const startedAt = Date.now();
      let completed = false;
      let abnormal = false;
      // Copy at the dispatch boundary, before the provider or next Step can mutate input.
      const manifest: ContextManifestRecord = {
        manifestId: `mcm_${runId}`, modelRunId: runId,
        turnId: request.turnId, sessionId: request.context.sessionId,
        attemptId: request.attemptId, stepId: request.step,
        purpose: meta?.purpose ?? "agent.loop",
        snapshot: structuredClone(request.context.messages),
        requestSnapshot: structuredClone({
          tools: request.tools ?? [],
          maxOutputTokens: request.maxOutputTokens,
          temperature: request.temperature,
        }),
      };
      try {
        for await (const chunk of abortableStream(provider.stream(request), request.signal)) {
          if (chunk.stopReason && chunk.stopReason !== "stop" && chunk.stopReason !== "tool_calls") abnormal = true;
          yield chunk;
        }
        completed = !abnormal && !request.signal?.aborted;
      } finally {
        try {
          await store.recordModelRun({
            runId, turnId: request.turnId, sessionId: request.context.sessionId,
            attemptId: request.attemptId, stepId: request.step,
            provider: meta?.provider ?? provider.id, modelId: meta?.modelId ?? "n/a",
            purpose: manifest.purpose, status: completed ? "completed" : "failed",
            latencyMs: Date.now() - startedAt,
          });
          await store.recordContextManifest(manifest);
        } catch {
          // Preserve execution semantics when the diagnostic store is unavailable.
        }
      }
    },
  };
}
