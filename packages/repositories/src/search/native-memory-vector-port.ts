import { NativeRuntimeClient, type NativeArtifact } from "@aervox/native-runtime";
import { assertLocalContext, type LocalContext } from "../local-context.js";
import type { IVectorSearchPort, VectorItem, VectorSearchResult } from "./vector-port.js";

/** Native state is a disposable read-only projection of the writer's exact SQLite file. */
export class NativeMemoryVectorSearchAdapter implements IVectorSearchPort {
  private readonly runtime: NativeRuntimeClient;
  private openedEpoch = -1;
  private chain: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private closed = false;
  constructor(private readonly fallback: IVectorSearchPort, private readonly options: {
    databasePath: string; modelId: string; artifact: NativeArtifact; onFallback?: (reason: string) => void;
  }) { this.runtime = new NativeRuntimeClient(options.artifact); }
  upsert(ctx: LocalContext, items: VectorItem[]): Promise<void> { return this.fallback.upsert(ctx, items); }
  delete(ctx: LocalContext, id: string): Promise<void> { return this.fallback.delete(ctx, id); }
  clearAll(ctx: LocalContext): Promise<void> { return this.fallback.clearAll(ctx); }
  async search(ctx: LocalContext, queryVector: number[], topK: number, minScore = 0): Promise<VectorSearchResult[]> {
    assertLocalContext(ctx);
    if (this.closed) throw new Error("native_vector_port_closed");
    if (!Number.isSafeInteger(topK) || topK < 0 || topK > 200 || !Number.isFinite(minScore)
      || queryVector.length > 1024 || queryVector.some(v => !Number.isFinite(v))) throw new Error("native_vector_query_invalid");
    if (topK === 0) return [];
    if (this.queued >= 16) throw new Error("native_vector_port_busy");
    this.queued++;
    const result = this.chain.then(async () => {
      if (this.closed) throw new Error("native_vector_port_closed");
      try {
        await this.runtime.request("hello");
        if (this.openedEpoch !== this.runtime.epoch) {
          await this.runtime.request("vector.open", { path: this.options.databasePath });
          this.openedEpoch = this.runtime.epoch;
        }
        const result = await this.runtime.request<{ hits: VectorSearchResult[] }>("vector.search", {
          modelId: this.options.modelId, query: queryVector, topK, minScore,
        });
        if (!Array.isArray(result.hits) || result.hits.length > topK || result.hits.some(h => typeof h.id !== "string" || !Number.isFinite(h.score) || h.score < minScore)) throw new Error("native_vector_response_invalid");
        return result.hits;
      } catch (error) {
        await this.runtime.reset(); this.openedEpoch = -1;
        if (this.closed) throw error;
        this.options.onFallback?.("native_vector_unavailable");
        return this.fallback.search(ctx, queryVector, topK, minScore);
      }
    });
    this.chain = result.catch(() => undefined);
    try { return await result; } finally { this.queued--; }
  }
  async close(): Promise<void> { this.closed = true; await this.runtime.close(); await this.chain; }
}
