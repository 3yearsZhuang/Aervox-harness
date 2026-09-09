/**
 * Aervox｜思隅 @aervox/database — 混合检索服务（T-02）
 *
 * 并行执行 FTS 粗筛与向量细筛，用纯 RRF（Reciprocal Rank Fusion）融合排序，
 * 避免两类分数尺度不可直接相加的问题；任一通道为空时降级返回另一通道结果。
 *
 * 设计依据：reference/baishou-next packages/ai/src/rag/hybrid-search.ts（AGPLv3，
 * 仅借鉴"RRF 融合 + 单通道降级 + 权重"的公开设计，融合公式为本项目自研：
 * 双侧纯 RRF，score = ftsWeight/(rank+K) + vectorWeight/(rank+K)）。
 *
 * 使用方式：按域（message/memory）构造 HybridSearchStorage，注入 FTS 与向量两个
 * 通道；服务本身与具体表/向量库解耦，后续切 pgvector 时仅替换通道实现。
 */
import { assertTenantContext, type TenantContext } from "../tenant.js";

/** 检索域：会话消息 / 记忆 */
export type HybridSearchDomain = "message" | "memory";

/** 单通道原始结果（FTS 侧；向量侧为 VectorSearchResult，字段对齐即可） */
export interface HybridChannelHit {
  readonly id: string;
  /** FTS: rank（越小越好，正数）；向量: 余弦相似度（越大越好，[-1,1]）。 */
  readonly score: number;
}

export interface HybridSearchInput {
  /** FTS 全文查询文本 */
  readonly queryText: string;
  /** 向量查询 */
  readonly queryVector: number[];
  readonly topK?: number;
  /** 最终返回的条数，默认 10 */
  readonly limit?: number;
  /** RRF 中 FTS 通道权重，默认 0.6 */
  readonly ftsWeight?: number;
  /** RRF 中向量通道权重，默认 0.4 */
  readonly vectorWeight?: number;
  /** 向量通道最低相似度过滤，默认 0 */
  readonly minVectorScore?: number;
}

export interface HybridSearchHit {
  readonly id: string;
  readonly domain: HybridSearchDomain;
  /** 融合分（FTS rank→RRF 分数；向量相似度→RRF 分数；单通道降级时为原分数带） */
  readonly score: number;
  /** 最终排序位置（0 起） */
  readonly rank: number;
  /** 命中来源：双通道融合 / 仅 FTS / 仅向量 */
  readonly source: "hybrid" | "fts" | "vector";
}

/** 混合检索所需的两个通道实现 */
export interface HybridSearchStorage {
  ftsSearch(tenant: TenantContext, queryText: string, topK: number): Promise<HybridChannelHit[]>;
  vectorSearch(
    tenant: TenantContext,
    queryVector: number[],
    topK: number,
    minScore?: number,
  ): Promise<HybridChannelHit[]>;
}

/** RRF 常数 K（抑制排名差异，越大排名影响越平缓） */
const RRF_K = 60;

/** 将通道内排名（0 起，越小越好）转为 RRF 分数 */
function rrfFromRank(rankIndex: number, weight: number): number {
  return weight / (rankIndex + RRF_K);
}

export class HybridSearchService {
  constructor(
    private readonly storage: HybridSearchStorage,
    private readonly domain: HybridSearchDomain,
  ) {}

  async search(tenant: TenantContext, input: HybridSearchInput): Promise<HybridSearchHit[]> {
    assertTenantContext(tenant);
    const topK = input.topK ?? 20;
    const limit = input.limit ?? 10;
    const ftsWeight = input.ftsWeight ?? 0.6;
    const vectorWeight = input.vectorWeight ?? 0.4;

    const ftsPromise = input.queryText.trim()
      ? this.storage.ftsSearch(tenant, input.queryText, topK)
      : Promise.resolve([]);
    const vectorPromise = this.storage.vectorSearch(
      tenant,
      input.queryVector,
      topK,
      input.minVectorScore,
    );

    const [ftsHits, vectorHits] = await Promise.all([ftsPromise, vectorPromise]);

    // 单通道降级：任一通道为空 → 直接返回另一通道结果
    if (ftsHits.length === 0 && vectorHits.length === 0) return [];
    if (ftsHits.length === 0) {
      return vectorHits
        .map((h, i) => ({
          id: h.id,
          domain: this.domain,
          score: h.score,
          rank: i,
          source: "vector" as const,
        }))
        .slice(0, limit);
    }
    if (vectorHits.length === 0) {
      return ftsHits
        .map((h, i) => ({
          id: h.id,
          domain: this.domain,
          score: rrfFromRank(i, 1),
          rank: i,
          source: "fts" as const,
        }))
        .slice(0, limit);
    }

    // 双通道 RRF 融合：score = Σ weight/(rank+K)
    const ftsRankById = new Map<string, number>();
    ftsHits.forEach((h, i) => {
      if (!ftsRankById.has(h.id)) ftsRankById.set(h.id, i);
    });
    const vectorRankById = new Map<string, number>();
    const vectorScoreById = new Map<string, number>();
    vectorHits.forEach((h, i) => {
      if (!vectorRankById.has(h.id)) vectorRankById.set(h.id, i);
      vectorScoreById.set(h.id, h.score);
    });

    const merged = new Map<string, { ftsScore: number; vectorScore: number }>();
    for (const id of ftsRankById.keys()) {
      merged.set(id, {
        ftsScore: rrfFromRank(ftsRankById.get(id)!, ftsWeight),
        vectorScore: vectorRankById.has(id)
          ? rrfFromRank(vectorRankById.get(id)!, vectorWeight)
          : 0,
      });
    }
    for (const id of vectorRankById.keys()) {
      if (!merged.has(id)) {
        merged.set(id, {
          ftsScore: 0,
          vectorScore: rrfFromRank(vectorRankById.get(id)!, vectorWeight),
        });
      }
    }

    const ranked = [...merged.entries()]
      .map(([id, s]) => ({
        id,
        ftsScore: s.ftsScore,
        vectorScore: s.vectorScore,
        total: s.ftsScore + s.vectorScore,
        cosine: vectorScoreById.get(id) ?? 0,
      }))
      .sort((a, b) => b.total - a.total);

    return ranked.slice(0, limit).map((r, i) => {
      const inFts = r.ftsScore > 0;
      const inVector = r.vectorScore > 0;
      return {
        id: r.id,
        domain: this.domain,
        // 同通道多命中排序由 total 决定；暴露融合分
        score: r.total,
        rank: i,
        source: inFts && inVector ? ("hybrid" as const) : inFts ? ("fts" as const) : ("vector" as const),
      } satisfies HybridSearchHit;
    });
  }
}

/**
 * 按域构造标准通道实现：FTS 走 SQLite FTS5（messages_fts / memories_fts），
 * 向量走 IVectorSearchPort。后续切换 pgvector 时替换 vectorSearch 即可。
 */
export function createHybridSearchStorage(opts: {
  domain: HybridSearchDomain;
  client: import("@libsql/client").Client;
  vectorPort: import("./vector-port.js").IVectorSearchPort;
}): HybridSearchStorage {
  const { domain, client, vectorPort } = opts;

  async function ftsSearch(
    tenant: TenantContext,
    queryText: string,
    topK: number,
  ): Promise<HybridChannelHit[]> {
    if (domain === "memory") {
      const { searchMemoriesFts } = await import("./fts.js");
      return searchMemoriesFts(client, tenant, queryText, topK);
    }
    const { searchMessagesFts } = await import("./fts.js");
    return searchMessagesFts(client, tenant, queryText, topK);
  }

  async function vectorSearch(
    tenant: TenantContext,
    queryVector: number[],
    topK: number,
    minScore?: number,
  ): Promise<HybridChannelHit[]> {
    const res = await vectorPort.search(tenant, queryVector, topK, minScore);
    return res.map((r) => ({ id: r.id, score: r.score }));
  }

  return { ftsSearch, vectorSearch };
}