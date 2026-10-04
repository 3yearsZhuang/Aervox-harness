/**
 * Aervox｜思隅 plugins/focus-mode — 概念探索端点（CAP-007 / CAP-002）
 *
 * CR-060：自 `apps/api/src/modules/learning/terms/routes.ts` 迁入，改为
 * `PluginHttpEndpoint` 声明式贡献；宿主负责框架适配、本地上下文解析与鉴权。
 *
 * - 暴露 POST `/v1/terms/explore` 与 POST `/v1/hierarchy/explore`；
 * - 支持 child（深挖原理）、related（关联对比）与 branch（创建独立会话分支）；
 * - 分支创建经 `services.sessions` 窄端口，插件不接触会话仓储。
 */
import type { PluginHostServices, PluginHttpEndpoint } from "@aervox/host-plugin-api";
import { termExploreRequestSchema } from "./contracts.js";

let seq = 0;

type ExploreKind = "child" | "related" | "branch";

interface ExploreBody {
  term: string;
  kind: ExploreKind;
  context?: string;
  sessionId?: string;
}

function buildChildContent(term: string, context?: string): { content: string; related: string[] } {
  return {
    content:
      `### 深度拆解：${term}\n\n` +
      `**核心定义**：${term} 是当前知识网络中的关键概念。\n\n` +
      `**底层原理与推导**：\n` +
      `1. **前置基石**：依赖其基本数学/计算机原理规范，确保状态转移与边界收敛；\n` +
      `2. **关键机制**：通过确定性规则与启发式策略实现自适应处理；\n` +
      `3. **典型应用**：在实际工程与复杂问题求解中作为核心构建块。\n\n` +
      (context ? `> 关联上下文引用：${context}\n\n` : "") +
      `💡 *思考提示*：尝试思考该机制在边界异常情况下的表现。`,
    related: [
      `${term} 的时间复杂度与空间复杂度如何？`,
      `在实际工程中，${term} 最容易遇到的瓶颈是什么？`,
      `有哪些经典场景必须依赖 ${term}？`,
    ],
  };
}

function buildRelatedContent(term: string): { content: string; related: string[] } {
  return {
    content:
      `### 关联对比与发散：${term}\n\n` +
      `**横向技术对比**：\n` +
      `- **同类方案**：相较于常规实现，${term} 更加关注边界安全性与收敛速度；\n` +
      `- **优势特点**：降低耦合度、具备良好的可扩展性与模块化特征；\n` +
      `- **权衡 Trade-offs**：在内存开销与实现复杂度之间需要根据场景进行权衡。\n\n` +
      `💡 *对比建议*：建议结合具体业务规模选择是否引入 ${term}。`,
    related: [
      `${term} 与其替代方案的核心区别是什么？`,
      `在什么场景下不建议使用 ${term}？`,
      `如何从旧架构平滑迁移到 ${term}？`,
    ],
  };
}

async function handleTermExplore(
  body: unknown,
  services: PluginHostServices,
): Promise<{ status?: number; payload: unknown }> {
  const parsed = termExploreRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { status: 400, payload: { error: "Invalid explore request", details: parsed.error.issues } };
  }
  const { term, kind, context, sessionId } = parsed.data as ExploreBody;

  let content = "";
  let relatedQuestions: string[] = [];
  let childSessionId: string | undefined;

  if (kind === "child") {
    const built = buildChildContent(term, context);
    content = built.content;
    relatedQuestions = built.related;
  } else if (kind === "related") {
    const built = buildRelatedContent(term);
    content = built.content;
    relatedQuestions = built.related;
  } else if (kind === "branch") {
    if (sessionId) {
      const child = await services.sessions.createSession(`探索分支：${term}`);
      childSessionId = child.id;
      await services.sessions.createBranch({
        id: `br_${Date.now().toString(36)}_${(++seq).toString(36)}`,
        parentSessionId: sessionId,
        childSessionId: child.id,
        title: `探索：${term}`,
        reason: "term_drill",
      });
    }
    content = `已为你创建专属探索分支会话【探索：${term}】。你可以进入该分支进行独立多轮对话与深入推导，不污染主会话上下文。`;
    relatedQuestions = [`进入分支深入推导 ${term}`, `返回主会话继续学习`];
  }

  return {
    payload: { term, kind, content, relatedQuestions, childSessionId },
  };
}

/** 概念探索端点贡献 */
export const focusModeExploreEndpoints: PluginHttpEndpoint[] = [
  {
    method: "POST",
    path: "/v1/terms/explore",
    handler: (request, services) => handleTermExplore(request.body, services),
  },
  {
    method: "POST",
    path: "/v1/hierarchy/explore",
    handler: (request, services) => handleTermExplore(request.body, services),
  },
];
