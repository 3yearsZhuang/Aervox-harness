/**
 * Aervox｜思隅 @aervox/api — 预设 MCP 服务器清单（CAP-020）
 *
 * 预设 = 出厂内置的远程 MCP 服务器接入档案：用户只需补 Token/凭据即可一键接入，
 * 无需手填端点与协议。首个预设为麦当劳中国官方 MCP（open.mcd.cn）。
 *
 * 信息来源（2026-08-29 核对）：麦当劳 MCP Server 官方仓库 README
 * https://github.com/M-China/mcd-mcp-server 与文档站 https://open.mcd.cn/mcp/doc。
 */
export const MCP_PRESET_TRANSPORT = {
  /** Streamable HTTP（MCP 2025-06-18 规范；麦当劳官方要求） */
  streamableHttp: "streamable_http",
} as const;

export type McpPresetTransport = (typeof MCP_PRESET_TRANSPORT)[keyof typeof MCP_PRESET_TRANSPORT];

export interface McpPresetDefinition {
  /** 服务器标识（同时作为同步工具的命名空间：mcp__<id>__<tool>） */
  id: string;
  name: string;
  description: string;
  transport: McpPresetTransport;
  endpointUrl: string;
  /** bearer = Authorization: Bearer <token>；none = 无鉴权 */
  authType: "bearer" | "none";
  /** MCP 协议版本（上游支持上限） */
  protocolVersion: string;
  /** 官方主页 / 文档 / Token 申请入口 */
  homepage: string;
  docsUrl: string;
  tokenApplyUrl: string;
  /** 使用范围与限流提示（展示给用户） */
  regionNote?: string;
  rateLimitNote?: string;
  /** 预设档案来源（可追溯性） */
  sourceUrl: string;
}

export const MCP_PRESETS: McpPresetDefinition[] = [
  {
    id: "mcd-mcp",
    name: "麦当劳 MCP",
    description:
      "麦当劳中国官方 MCP 服务：覆盖麦乐送点餐、到店取餐、团餐、门店查询、优惠券与积分商城、活动日历等业务场景（餐品营养、点餐下单、领券兑换等工具）。需在官方平台申请 MCP Token 后接入。",
    transport: MCP_PRESET_TRANSPORT.streamableHttp,
    endpointUrl: "https://mcp.mcd.cn",
    authType: "bearer",
    protocolVersion: "2025-06-18",
    homepage: "https://open.mcd.cn/mcp",
    docsUrl: "https://open.mcd.cn/mcp/doc",
    tokenApplyUrl: "https://open.mcd.cn/mcp",
    regionNote: "仅面向中国大陆地区（不含港澳台）",
    rateLimitNote: "每个 Token 每分钟最多 600 次请求，超限返回 429",
    sourceUrl: "https://github.com/M-China/mcd-mcp-server",
  },
];

export function findMcpPreset(id: string): McpPresetDefinition | undefined {
  return MCP_PRESETS.find((preset) => preset.id === id);
}
