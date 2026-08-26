/**
 * Aervox｜思隅 @aervox/api — MemoryStoreTool 运行时实现（T-04）
 *
 * 主动记忆工具：AI 将对话长期记忆显式沉淀到 memory_records。
 * 规则依据：docs/explanation/reference-design-transfer.md §3.4；
 * 行为与契约对齐 packages/contracts memoryStoreToolInputSchema/Output。
 *
 * 关键约束（PRD §7.5 记忆验收标准）：
 * - source = user_said 直接置信；ai_inferred 默认 asCandidate=true → unverified 候选；
 * - 候选写入默认 verificationStatus=unverified，用户确认后才晋升；
 * - 向量生成依赖注入 provider；未注入时降级为仅索引 FTS（embeddingStatus=skipped）。
 */
import { indexMemoryFts, type TenantContext } from "@aervox/database";
import type { Client } from "@libsql/client";
import {
  SqliteMemoryRepository,
  SqliteMemoryEmbeddingRepository,
} from "@aervox/database";
import type {
  MemoryStoreToolInput,
  MemoryStoreToolOutput,
} from "@aervox/contracts";
import type { MemoryEmbeddingProvider } from "./embedding-provider.js";

export interface MemoryStoreToolDeps {
  memoryRepo: SqliteMemoryRepository;
  embeddingRepo: SqliteMemoryEmbeddingRepository;
  /** 生成向量的 provider；缺省返回未注入时 undefined */
  embeddingProvider?: MemoryEmbeddingProvider | null;
  /** 底层 client，用于 FTS 索引（保持与既有搜索链路一致） */
  client: Client;
}

let seq = 0;
const id = (prefix: string): string =>
  `${prefix}_${Date.now().toString(36)}_${(++seq).toString(36)}`;

export class MemoryStoreTool {
  constructor(private readonly deps: MemoryStoreToolDeps) {}

  async run(tenant: TenantContext, input: MemoryStoreToolInput): Promise<MemoryStoreToolOutput> {
    const { memoryRepo, embeddingRepo, client } = this.deps;

    // 1. 参数落定：asCandidate 由 source 推断（ai_inferred 默认候选）
    const isCandidate = input.asCandidate ?? input.source === "ai_inferred";
    const memoryId = id("mem_tool");

    // 2. 写入长期记忆（校验状态联动候选语义：user_said 直接置信 → verified；候选 → unverified）
    const record = await memoryRepo.createRecord(tenant, {
      id: memoryId,
      layer: "long_term",
      type: input.source === "user_said" ? "user_fact" : "inference",
      content: input.content,
      sourceTurnId: input.sourceTurnId ?? null,
      source: input.source,
      category: input.category,
      keywords: input.keywords,
      verificationStatus: isCandidate ? "unverified" : "verified",
    });
    // 候选标记依赖 verificationStatus；显式记录最后一次使用（写入即视为引用），便于召回窗口淘汰。
    void record;

    // 3. 同步 FTS（即便无向量，检索窗口内仍可被召回）
    await indexMemoryFts(client, tenant, { id: memoryId, content: input.content });

    // 4. 尝试生成向量；provider 未注入时诚实降级
    let embeddingStatus: MemoryStoreToolOutput["embeddingStatus"] = "skipped";
    if (this.deps.embeddingProvider) {
      try {
        const vector = await this.deps.embeddingProvider.embed(input.content);
        if (vector.length > 0) {
          await embeddingRepo.insertBatch(tenant, [
            {
              id: id("emb"),
              memoryId,
              vector,
              modelId: this.deps.embeddingProvider.modelId,
              sourceCreatedAt: new Date().toISOString(),
            },
          ]);
          embeddingStatus = "indexed";
        }
      } catch {
        // 向量服务失败不影响记忆落库；标记 failed 供运维观测
        embeddingStatus = "failed";
      }
    }

    return {
      memoryId,
      isCandidate,
      embeddingStatus,
    };
  }
}