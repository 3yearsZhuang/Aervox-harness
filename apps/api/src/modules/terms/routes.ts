/**
 * Aervox｜思隅 @aervox/api — 术语抽取与概念探索模块路由（CAP-007 / CAP-002）
 *
 * 遵循 ADR-014 演进式模块化单体与 AVX-PLUG-001 插件规范：
 * - 暴露独立 POST /v1/terms/explore 与 POST /v1/hierarchy/explore
 * - 支持 child (深挖原理)、related (关联对比) 与 branch (创建独立会话分支)
 * - 仅在专注模式 / 学习上下文中被激活调用
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { SqliteConversationRepository } from "@aervox/database";
import { termExploreRequestSchema } from "@aervox/contracts";
import { resolveTenant } from "../../shared/tenant.js";

let seq = 0;

export function registerTermsRoutes(
  app: FastifyInstance,
  conversationRepo: SqliteConversationRepository,
): void {
  const handleTermExplore = async (req: FastifyRequest, reply: FastifyReply) => {
    const tenant = resolveTenant(req);
    const parsed = termExploreRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "Invalid explore request", details: parsed.error.issues });
    }
    const { term, kind, context, sessionId } = parsed.data;

    let content = "";
    let relatedQuestions: string[] = [];
    let childSessionId: string | undefined;

    if (kind === "child") {
      content =
        `### 深度拆解：${term}\n\n` +
        `**核心定义**：${term} 是当前知识网络中的关键概念。\n\n` +
        `**底层原理与推导**：\n` +
        `1. **前置基石**：依赖其基本数学/计算机原理规范，确保状态转移与边界收敛；\n` +
        `2. **关键机制**：通过确定性规则与启发式策略实现自适应处理；\n` +
        `3. **典型应用**：在实际工程与复杂问题求解中作为核心构建块。\n\n` +
        (context ? `> 关联上下文引用：${context}\n\n` : "") +
        `💡 *思考提示*：尝试思考该机制在边界异常情况下的表现。`;
      relatedQuestions = [
        `${term} 的时间复杂度与空间复杂度如何？`,
        `在实际工程中，${term} 最容易遇到的瓶颈是什么？`,
        `有哪些经典场景必须依赖 ${term}？`,
      ];
    } else if (kind === "related") {
      content =
        `### 关联对比与发散：${term}\n\n` +
        `**横向技术对比**：\n` +
        `- **同类方案**：相较于常规实现，${term} 更加关注边界安全性与收敛速度；\n` +
        `- **优势特点**：降低耦合度、具备良好的可扩展性与模块化特征；\n` +
        `- **权衡 Trade-offs**：在内存开销与实现复杂度之间需要根据场景进行权衡。\n\n` +
        `💡 *对比建议*：建议结合具体业务规模选择是否引入 ${term}。`;
      relatedQuestions = [
        `${term} 与其替代方案的核心区别是什么？`,
        `在什么场景下不建议使用 ${term}？`,
        `如何从旧架构平滑迁移到 ${term}？`,
      ];
    } else if (kind === "branch") {
      if (sessionId) {
        const child = await conversationRepo.createSession(tenant, `探索分支：${term}`);
        childSessionId = child.id;
        await conversationRepo.createConversationBranch(tenant, {
          id: `br_${Date.now().toString(36)}_${(++seq).toString(36)}`,
          parentSessionId: sessionId,
          childSessionId: child.id,
          title: `探索：${term}`,
          branchReason: "term_drill",
        });
      }
      content = `已为你创建专属探索分支会话【探索：${term}】。你可以进入该分支进行独立多轮对话与深入推导，不污染主会话上下文。`;
      relatedQuestions = [
        `进入分支深入推导 ${term}`,
        `返回主会话继续学习`,
      ];
    }

    return reply.send({
      term,
      kind,
      content,
      relatedQuestions,
      childSessionId,
    });
  };

  app.post("/v1/terms/explore", handleTermExplore);
  app.post("/v1/hierarchy/explore", handleTermExplore);
}
