import type { ModuleDependencies } from "../../context.js";
import { SqliteMemoryRepository, SqliteMemoryEmbeddingRepository, SqlitePrivacyRepository } from "@aervox/repositories";
import { registerMemoryRoutes } from "./routes.js";
import { MemoryStoreTool } from "./memory-store-tool.js";
import { LocalFeatureHashEmbeddingProvider, type MemoryEmbeddingProvider } from "./embedding-provider.js";
import { createSqliteMemoryRecall } from "./recall.js";
import { contributeMemoryTool } from "./tool-contribution.js";

export type { MemoryRecallPort, RecalledMemory } from "./recall.js";
export type { MemoryEmbeddingProvider } from "./embedding-provider.js";
export type { MemoryWritePort } from "./tool-contribution.js";

const local = { workspaceId: "local", subjectUserId: "local" } as const;

export async function registerMemoryModule(ctx: ModuleDependencies<"app" | "client" | "db" | "toolRuntime">, options: {
  embeddingProvider?: MemoryEmbeddingProvider | null;
  contributeTool?: boolean;
} = {}): Promise<import("./recall.js").MemoryRecallPort> {
  const { app, db, client } = ctx;
  const repo = new SqliteMemoryRepository(db, client);
  const privacyRepo = new SqlitePrivacyRepository(db);
  const embeddingProvider = options.embeddingProvider === undefined
    ? new LocalFeatureHashEmbeddingProvider() : options.embeddingProvider;
  const memoryRecall = createSqliteMemoryRecall({
    db,
    client,
    embeddingProvider,
    // 用途闸门（fail-closed）：无有效 memory_long 授权时不自动召回；历史保留/导出不受影响
    consentCheck: (purpose, scope) => privacyRepo.hasActiveConsent(local, purpose, scope),
  });
  registerMemoryRoutes(app, repo);
  if (ctx.toolRuntime && options.contributeTool !== false) {
    const tool = new MemoryStoreTool({ memoryRepo: repo, embeddingRepo: new SqliteMemoryEmbeddingRepository(db), client, embeddingProvider });
    const release = await contributeMemoryTool(ctx.toolRuntime, { store: (context, input) => tool.run(context, input) });
    app.addHook("onClose", async () => release());
  }
  return memoryRecall;
}
