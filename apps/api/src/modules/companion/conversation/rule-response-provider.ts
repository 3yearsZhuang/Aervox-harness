/**
 * Aervox｜思隅 @aervox/api — 对话侧 L2 确定性规则回应 Provider (CR-044 / N2b)
 *
 * 针对系统在无可用模型（L0 与 L1 皆不可达）时的零模型兜底，实现「断网不哑火」：
 * - 纯离线纯函数规则模板，覆盖问候、状态说明、离线提示与基础安全兜底；
 * - 产生符合 AgentLoopProviderPort 契约的流式输出（ModelChunk）；
 * - 诚实标记离线规则输出来源。
 */
import type { ModelProviderPort } from "@aervox/agent-loop";
import type { ModelChunk, ModelRequest } from "@aervox/agent-loop";
import type { ModelRoutingSnapshot } from "@aervox/contracts";

export interface RuleResponseProviderOptions {
  personaName?: string;
  reason?: string;
}

export class RuleResponseProvider implements ModelProviderPort {
  readonly id = "rule_response_l2";
  readonly routingSnapshot: ModelRoutingSnapshot = {
    tier: "L2",
    capabilityTier: "minimal",
    presetId: null,
    presetName: null,
    providerType: null,
    modelId: null,
    baseUrl: null,
    isLocal: true,
    localAttestation: true,
    reason: "rule_offline_deterministic",
    configRevision: "1",
    healthRevision: "0",
    stickySession: false,
    evaluatedAt: new Date().toISOString(),
  };

  constructor(private readonly options?: RuleResponseProviderOptions) {}

  async *stream(req: ModelRequest): AsyncIterable<ModelChunk> {
    const messages = req.context.messages;
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const userContent = lastUserMsg?.content.trim() ?? "";

    const responseText = this.generateRuleReply(userContent);

    // 模拟流式输出：先输出文本内容，随后输出结束标记
    yield {
      text: responseText,
      isFinal: false,
    };

    yield {
      text: "",
      isFinal: true,
    };
  }

  private generateRuleReply(input: string): string {
    const lower = input.toLowerCase();
    const persona = this.options?.personaName ? `我是${this.options.personaName}` : "我是思隅";

    // 1. 问候分支
    if (/^(你好|您好|hi|hello|嗨|在吗|早安|晚上好|哈喽)/i.test(lower)) {
      return `你好！${persona}。当前处于纯本地确定性离线模式（L2 级），未连接云端或本地大模型。我可以为你整理本地日记、查看复习安排或使用基础只读工具。`;
    }

    // 2. 状态查询分支
    if (/(状态|降级|离线|网络|模型|在线吗|连通性)/i.test(lower)) {
      const reason = this.options?.reason ? `（原因：${this.options.reason}）` : "";
      return `【思隅本地运行状态】当前系统模型降级阶梯处于 L2（确定性规则兜底）${reason}。云端与本地大模型均不可达，已自动启用零模型保护，确保核心本地数据主权与基础响应可用。`;
    }

    // 3. 帮助与功能引导分支
    if (/(帮助|help|功能|你能做什么|怎么用)/i.test(lower)) {
      return `${persona}当前处于离线模式，支持以下核心本地功能：\n1. 会话浏览与本地项目管理；\n2. 间隔复习与错题本查看；\n3. 每日日记本地草稿；\n待网络恢复或启动本地模型后，即可恢复全量自主思考与学习答疑。`;
    }

    // 4. 默认通用离线兜底
    return `【离线规则回应】${persona}收到了你的消息：“${input.slice(0, 30)}${input.length > 30 ? "..." : ""}”。当前系统处于离线规则兜底状态（L2 级），高级大模型对话暂未接通。待网络或本地模型端点恢复后，我将自动恢复智能问答！`;
  }
}

export function createRuleResponseProvider(
  options?: RuleResponseProviderOptions,
): RuleResponseProvider {
  return new RuleResponseProvider(options);
}
