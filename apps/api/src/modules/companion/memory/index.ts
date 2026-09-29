import type { ModuleContext } from "../../context.js";
import { SqliteMemoryRepository, SqliteMemoryEmbeddingRepository } from "@aervox/repositories";
import { registerMemoryRoutes } from "./routes.js";
import { MemoryStoreTool } from "./memory-store-tool.js";
import { LocalFeatureHashEmbeddingProvider, type MemoryEmbeddingProvider } from "./embedding-provider.js";
import { createSqliteMemoryRecall } from "./recall.js";
import { contributeMemoryTool } from "./tool-contribution.js";

export type { MemoryRecallPort, RecalledMemory } from "./recall.js";
export type { MemoryEmbeddingProvider } from "./embedding-provider.js";
export type { MemoryWritePort } from "./tool-contribution.js";

export async function registerMemoryModule(ctx: ModuleContext, options: {
  embeddingProvider?: MemoryEmbeddingProvider | null;
  contributeTool?: boolean;
} = {}): Promise<void> {
  const { app, db, client } = ctx;
  const repo = new SqliteMemoryRepository(db, client);
  const embeddingProvider = options.embeddingProvider === undefined
    ? new LocalFeatureHashEmbeddingProvider() : options.embeddingProvider;
  ctx.memoryRecall = createSqliteMemoryRecall({ db, client, embeddingProvider });
  registerMemoryRoutes(app, repo);
  if (ctx.toolRuntime && options.contributeTool !== false) {
    const tool = new MemoryStoreTool({ memoryRepo: repo, embeddingRepo: new SqliteMemoryEmbeddingRepository(db), client, embeddingProvider });
    const release = await contributeMemoryTool(ctx.toolRuntime, { store: (context, input) => tool.run(context, input) });
    app.addHook("onClose", async () => release());
  }
}
