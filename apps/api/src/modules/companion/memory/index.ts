import type { ModuleDependencies } from "../../context.js";
import { SqliteMemoryRepository, SqliteMemoryEmbeddingRepository, SqlitePrivacyRepository } from "@aervox/repositories";
import { registerMemoryRoutes } from "./routes.js";
import { MemoryStoreTool } from "./memory-store-tool.js";
import {
  LocalFeatureHashEmbeddingProvider,
  OpenAiCompatibleEmbeddingProvider,
  resolveEmbeddingProvider,
  type MemoryEmbeddingProvider,
  type OpenAiCompatibleEmbeddingOptions,
} from "./embedding-provider.js";
import { createSqliteMemoryRecall } from "./recall.js";
import { contributeMemoryTool } from "./tool-contribution.js";
import { NativeMemoryVectorSearchAdapter, CachedMemoryVectorSearchAdapter, SqliteMemoryVectorSearchAdapter } from "@aervox/repositories";
import { nativeArtifactFromEnvironment, loadNativeArtifact } from "@aervox/native-runtime";
import { isAbsolute } from "node:path";

export type { MemoryRecallPort, RecalledMemory } from "./recall.js";
export type { MemoryEmbeddingProvider, OpenAiCompatibleEmbeddingOptions } from "./embedding-provider.js";
export { LocalFeatureHashEmbeddingProvider, OpenAiCompatibleEmbeddingProvider, resolveEmbeddingProvider } from "./embedding-provider.js";
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
    ? resolveEmbeddingProvider() : options.embeddingProvider;
  const engine = process.env.AERVOX_MEMORY_VECTOR_ENGINE;
  const artifact = engine === "rust" ? nativeArtifactFromEnvironment() ?? await loadNativeArtifact() : undefined;
  const databasePath = artifact || engine === "typed" ? String((await client.execute("PRAGMA database_list")).rows.find(r => r.name === "main")?.file ?? "") : "";
  const nativeVector = artifact && isAbsolute(databasePath) ? new NativeMemoryVectorSearchAdapter(
    new SqliteMemoryVectorSearchAdapter(new SqliteMemoryEmbeddingRepository(db), embeddingProvider?.modelId ?? "embedding-disabled"),
    { artifact, databasePath, modelId: embeddingProvider?.modelId ?? "embedding-disabled",
      onFallback: reason => app.log.warn({ reason }, "Native memory vector search fell back to SQLite") },
  ) : undefined;
  const vectorPort = engine === "typed" ? new CachedMemoryVectorSearchAdapter(
    new SqliteMemoryVectorSearchAdapter(new SqliteMemoryEmbeddingRepository(db), embeddingProvider?.modelId ?? "embedding-disabled"),
    { client, modelId: embeddingProvider?.modelId ?? "embedding-disabled", databasePath: isAbsolute(databasePath) ? databasePath : undefined },
  ) : nativeVector;
  if (vectorPort) app.addHook("onClose", async () => vectorPort.close());
  const memoryRecall = createSqliteMemoryRecall({
    vectorPort,
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
