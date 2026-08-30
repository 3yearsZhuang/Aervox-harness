/**
 * Aervox｜思隅 @aervox/api — MCP 客户端（Streamable HTTP，自研轻量实现）
 *
 * 与 tools/mcp.ts（对外 MCP 形态适配）对偶：这里是**客户端侧**，经 JSON-RPC
 * 调用远程 MCP 服务器的 initialize / tools/list / tools/call。遵循 T-04 定位
 * 「自研轻量协议层，不引入第三方 MCP SDK」。
 *
 * 传输按 MCP Streamable HTTP 规范：单端点 POST，Accept 同时声明
 * application/json 与 text/event-stream；响应可能是 JSON，也可能是 SSE 流
 * （本实现不需要增量事件，缓冲全量后按 data: 行提取匹配 id 的 JSON-RPC 响应）。
 */
export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

/** 上游错误：携带 HTTP 状态码与 JSON-RPC 错误码（401=Token 失效 / 429=限流） */
export class McpUpstreamError extends Error {
  readonly status?: number;
  readonly rpcCode?: number | string;

  constructor(message: string, options?: { status?: number; rpcCode?: number | string }) {
    super(message);
    this.name = "McpUpstreamError";
    this.status = options?.status;
    this.rpcCode = options?.rpcCode;
  }
}

export interface McpHttpClientOptions {
  endpointUrl: string;
  token?: string | null;
  /** MCP 协议版本（默认 2025-06-18，麦当劳官方支持上限） */
  protocolVersion?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  clientInfo?: { name: string; version: string };
}

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number | string; message?: string; data?: unknown };
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const ACCEPT = "application/json, text/event-stream";

/** 从 SSE 文本中提取与请求 id 匹配的 JSON-RPC 响应（无匹配返回 undefined） */
export function extractRpcResponse(text: string, id: number): JsonRpcResponse | undefined {
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as JsonRpcResponse;
      if (parsed.jsonrpc === "2.0" && parsed.id === id) return parsed;
    } catch {
      // 非 JSON data 行（心跳/注释等）忽略
    }
  }
  return undefined;
}

function describeHttpError(status: number): string {
  if (status === 401) return "上游返回 401：MCP Token 无效、已过期或未提供，请检查 Authorization 配置";
  if (status === 429) return "上游返回 429：触发限流，请降低请求频率后重试";
  return `上游 MCP 服务器返回 HTTP ${status}`;
}

export class McpHttpClient {
  private readonly fetchImpl: typeof fetch;
  private nextId = 0;
  private initialized?: Promise<void>;

  constructor(private readonly options: McpHttpClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 端点或凭据是否与当前实例一致（不一致时调用方应换新实例） */
  matches(endpointUrl: string, token: string | null | undefined): boolean {
    return this.options.endpointUrl === endpointUrl && (this.options.token ?? null) === (token ?? null);
  }

  /** 发起一次 JSON-RPC 调用；notification 无 id、不等待响应体 */
  private async rpc<T = unknown>(
    method: string,
    params?: unknown,
    opts?: { notification?: boolean },
  ): Promise<T> {
    const isNotification = opts?.notification === true;
    const id = isNotification ? undefined : ++this.nextId;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: ACCEPT,
    };
    if (this.options.token) {
      headers.Authorization = `Bearer ${this.options.token}`;
    }

    let res: Response;
    try {
      res = await this.fetchImpl(this.options.endpointUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
        signal: AbortSignal.timeout(this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new McpUpstreamError(`无法连接 MCP 服务器（${this.options.endpointUrl}）：${reason}`);
    }

    if (!res.ok) {
      throw new McpUpstreamError(describeHttpError(res.status), { status: res.status });
    }
    if (isNotification) {
      // 通知无需响应体（202 Accepted 或空体均可）
      return undefined as T;
    }

    const contentType = res.headers.get("content-type") ?? "";
    let rpc: JsonRpcResponse | undefined;
    if (contentType.includes("text/event-stream")) {
      rpc = extractRpcResponse(await res.text(), id as number);
    } else {
      rpc = (await res.json().catch(() => undefined)) as JsonRpcResponse | undefined;
    }
    if (!rpc) {
      throw new McpUpstreamError("上游响应不是合法的 JSON-RPC 消息");
    }
    if (rpc.error) {
      throw new McpUpstreamError(
        `MCP JSON-RPC 错误 ${rpc.error.code ?? ""}: ${rpc.error.message ?? "unknown"}`,
        { rpcCode: rpc.error.code },
      );
    }
    return rpc.result as T;
  }

  /** initialize 握手 + notifications/initialized 通知（每实例仅握手一次） */
  async initialize(): Promise<void> {
    this.initialized ??= (async () => {
      await this.rpc("initialize", {
        protocolVersion: this.options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: this.options.clientInfo ?? { name: "aervox", version: "0.1.0" },
      });
      await this.rpc("notifications/initialized", undefined, { notification: true });
    })();
    try {
      await this.initialized;
    } catch (err) {
      // 握手失败不缓存：下次调用重试
      this.initialized = undefined;
      throw err;
    }
  }

  /** tools/list：拉取远程工具清单 */
  async listTools(): Promise<McpRemoteTool[]> {
    const result = await this.rpc<{ tools?: McpRemoteTool[] }>("tools/list", {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /** tools/call：调用远程工具，返回 MCP result（content 数组 / isError 等） */
  async callTool(name: string, args: unknown): Promise<unknown> {
    return this.rpc("tools/call", { name, arguments: args ?? {} });
  }
}
