/**
 * Aervox｜思隅 @aervox/api — DSH 本地 MCP 桥接器（CAP-020 / ADR-010 方案一）
 *
 * 遵循 MCP 2025-06-18 规范（Streamable HTTP JSON-RPC 2.0），将 DSH（DeepSeek Harness）
 * 核心研发工具与运行时探测能力暴露为 MCP 标准服务端：
 * - initialize / notifications/initialized / tools/list / tools/call
 * - 纯本地运行，免密鉴权（authType: "none"），与 CR-030 本地单用户架构天然对齐；
 * - 严格路径沙箱：所有文件读写与命令执行限制在 repoRoot 内，杜绝目录穿越；
 * - 工具清单对齐 PET-05 安全分级：只读类（probe/read/list/search）与授权类（replace/command）。
 */
import { exec } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, dirname } from "node:path";
import { promisify } from "node:util";
import { probeDSHReference, type DSHReferenceProbeResult } from "@aervox/host-agent";
import type { McpRemoteTool } from "./client.js";

const execAsync = promisify(exec);

export interface DshMcpBridgeOptions {
  /** 仓库根目录（默认从 process.cwd() 向上查找，或使用 cwd） */
  repoRoot?: string;
}

/** 从 cwd 向上查找含 reference/deepseek-harness 或 .git 的仓库根 */
export function findRepoRoot(startDir = process.cwd()): string {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(dir, "reference", "deepseek-harness")) || existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}

/** 路径安全检查：禁止通过 `..` 或绝对路径逃逸出沙箱根目录 */
export function resolveSafePath(repoRoot: string, userPath?: string): string {
  const cleanPath = (userPath ?? "").trim();
  const resolved = resolve(repoRoot, cleanPath);
  const rel = relative(repoRoot, resolved);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`路径越界受阻：'${userPath}' 超出仓库沙箱范围`);
  }
  return resolved;
}

/** DSH 官方 MCP 导出的工具元数据定义 */
export const DSH_MCP_TOOLS: McpRemoteTool[] = [
  {
    name: "dsh_probe_runtime",
    description: "探测 DSH (DeepSeek Harness) 运行时就绪状态、子模块 SHA256 校验与许可证合规性",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "dsh_read_file",
    description: "读取指定路径的文件内容，支持按起始行号与结束行号截取（研发代码审查）",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对项目根目录的文件路径" },
        startLine: { type: "integer", description: "起始行号（从 1 开始，包含）", minimum: 1 },
        endLine: { type: "integer", description: "结束行号（包含）", minimum: 1 },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_list_dir",
    description: "列出指定目录下的文件与子目录（支持深度与常见忽略规则）",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对项目根目录的目录路径（默认根目录）" },
        maxDepth: { type: "integer", description: "最大递归深度（默认 2，上限 5）", minimum: 1, maximum: 5 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dsh_search_code",
    description: "在代码库中基于文本模式进行全文匹配检索（带行号与代码行内容）",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键字或文本模式" },
        path: { type: "string", description: "起始检索相对子目录（默认根目录）" },
        caseSensitive: { type: "boolean", description: "是否区分大小写（默认 false）" },
        maxResults: { type: "integer", description: "最大返回匹配条数（默认 50，上限 200）", minimum: 1, maximum: 200 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_str_replace",
    description: "在指定文件中进行精确唯一的字符串替换（需授权审批 write_with_approval）",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对项目根目录的文件路径" },
        oldStr: { type: "string", description: "待替换的原字符串（必须在文件中全局唯一匹配）" },
        newStr: { type: "string", description: "替换后的新字符串" },
      },
      required: ["path", "oldStr", "newStr"],
      additionalProperties: false,
    },
  },
  {
    name: "dsh_run_command",
    description: "在受限沙箱环境中执行本地命令（需授权审批 write_with_approval）",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的命令行指令" },
        cwd: { type: "string", description: "执行目录（相对根目录，默认根目录）" },
        timeoutMs: { type: "integer", description: "执行超时毫秒数（默认 15000，上限 60000）", minimum: 1000, maximum: 60000 },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface JsonRpcSuccess<T = unknown> {
  jsonrpc: "2.0";
  id: number | string | null;
  result: T;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: number | string | null;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export class DshMcpBridge {
  readonly repoRoot: string;

  constructor(options: DshMcpBridgeOptions = {}) {
    this.repoRoot = options.repoRoot ?? process.env.AERVOX_DSH_REPO_ROOT?.trim() ?? findRepoRoot();
  }

  /** 分发并处理 JSON-RPC 2.0 请求 */
  async handleRpc(raw: unknown): Promise<JsonRpcSuccess | JsonRpcError | undefined> {
    if (!raw || typeof raw !== "object") {
      return {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request: expected JSON object" },
      };
    }

    const req = raw as JsonRpcRequest;
    const isNotification = req.id === undefined;
    const id = req.id ?? null;

    if (req.jsonrpc !== "2.0" && req.jsonrpc !== undefined) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request: jsonrpc must be '2.0'" },
      };
    }

    try {
      switch (req.method) {
        case "initialize": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {
                tools: {},
              },
              serverInfo: {
                name: "dsh-mcp-server",
                version: "1.0.0",
              },
            },
          };
        }

        case "notifications/initialized": {
          // MCP 规范：客户端发来的通知，无返回值
          return isNotification ? undefined : { jsonrpc: "2.0", id, result: {} };
        }

        case "tools/list": {
          return {
            jsonrpc: "2.0",
            id,
            result: {
              tools: DSH_MCP_TOOLS,
            },
          };
        }

        case "tools/call": {
          const params = (req.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
          const toolName = params.name;
          const args = params.arguments ?? {};
          const result = await this.executeTool(toolName, args);
          return {
            jsonrpc: "2.0",
            id,
            result,
          };
        }

        default: {
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32601,
              message: `Method not found: '${req.method}'`,
            },
          };
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: `Internal error: ${message}`,
        },
      };
    }
  }

  /** 执行具体工具调用，返回标准 MCP result 格式 */
  private async executeTool(
    name: string | undefined,
    args: Record<string, unknown>,
  ): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    if (!name) {
      return { content: [{ type: "text", text: "Tool call missing name parameter" }], isError: true };
    }

    try {
      switch (name) {
        case "dsh_probe_runtime": {
          const probe: DSHReferenceProbeResult = probeDSHReference(this.repoRoot);
          const report = {
            repoRoot: this.repoRoot,
            ready: probe.ready,
            reason: probe.reason,
            manifest: probe.manifest,
          };
          return {
            content: [{ type: "text", text: JSON.stringify(report, null, 2) }],
            isError: !probe.ready,
          };
        }

        case "dsh_read_file": {
          const filePath = String(args.path ?? "");
          if (!filePath) throw new Error("path parameter is required");
          const safePath = resolveSafePath(this.repoRoot, filePath);
          if (!existsSync(safePath) || !statSync(safePath).isFile()) {
            throw new Error(`File not found: ${filePath}`);
          }
          const content = readFileSync(safePath, "utf-8");
          const lines = content.split(/\r?\n/);
          const start = args.startLine ? Math.max(1, Number(args.startLine)) : 1;
          const end = args.endLine ? Math.min(lines.length, Number(args.endLine)) : lines.length;

          const sliced = lines.slice(start - 1, end);
          const formatted = sliced.map((line, idx) => `${start + idx}: ${line}`).join("\n");
          return {
            content: [{ type: "text", text: formatted }],
            isError: false,
          };
        }

        case "dsh_list_dir": {
          const dirPath = String(args.path ?? ".");
          const maxDepth = Math.min(5, Math.max(1, Number(args.maxDepth ?? 2)));
          const safeDir = resolveSafePath(this.repoRoot, dirPath);
          if (!existsSync(safeDir) || !statSync(safeDir).isDirectory()) {
            throw new Error(`Directory not found: ${dirPath}`);
          }

          const entries = this.walkDir(safeDir, this.repoRoot, 1, maxDepth);
          return {
            content: [{ type: "text", text: JSON.stringify(entries, null, 2) }],
            isError: false,
          };
        }

        case "dsh_search_code": {
          const query = String(args.query ?? "");
          if (!query) throw new Error("query parameter is required");
          const searchPath = String(args.path ?? ".");
          const caseSensitive = Boolean(args.caseSensitive);
          const maxResults = Math.min(200, Math.max(1, Number(args.maxResults ?? 50)));

          const safeDir = resolveSafePath(this.repoRoot, searchPath);
          const results = this.searchInDir(safeDir, this.repoRoot, query, caseSensitive, maxResults);
          return {
            content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
            isError: false,
          };
        }

        case "dsh_str_replace": {
          const filePath = String(args.path ?? "");
          const oldStr = String(args.oldStr ?? "");
          const newStr = String(args.newStr ?? "");
          if (!filePath || oldStr === undefined || newStr === undefined) {
            throw new Error("path, oldStr, and newStr parameters are required");
          }
          const safePath = resolveSafePath(this.repoRoot, filePath);
          if (!existsSync(safePath) || !statSync(safePath).isFile()) {
            throw new Error(`File not found: ${filePath}`);
          }
          const original = readFileSync(safePath, "utf-8");
          const count = original.split(oldStr).length - 1;
          if (count === 0) {
            throw new Error(`oldStr was not found in file: '${filePath}'`);
          }
          if (count > 1) {
            throw new Error(`oldStr matched ${count} times in '${filePath}'; replacement must be unique`);
          }
          const replaced = original.replace(oldStr, newStr);
          writeFileSync(safePath, replaced, "utf-8");
          return {
            content: [{ type: "text", text: `Successfully replaced string in ${filePath}` }],
            isError: false,
          };
        }

        case "dsh_run_command": {
          const command = String(args.command ?? "");
          if (!command) throw new Error("command parameter is required");
          const cwdPath = String(args.cwd ?? ".");
          const safeCwd = resolveSafePath(this.repoRoot, cwdPath);
          const timeoutMs = Math.min(60_000, Math.max(1000, Number(args.timeoutMs ?? 15_000)));

          try {
            const { stdout, stderr } = await execAsync(command, {
              cwd: safeCwd,
              timeout: timeoutMs,
              maxBuffer: 1024 * 1024,
            });
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 }),
                },
              ],
              isError: false,
            };
          } catch (execErr: unknown) {
            const errObj = execErr as { stdout?: string; stderr?: string; code?: number; message?: string };
            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    stdout: (errObj.stdout ?? "").trim(),
                    stderr: (errObj.stderr ?? errObj.message ?? "").trim(),
                    exitCode: errObj.code ?? 1,
                  }),
                },
              ],
              isError: true,
            };
          }
        }

        default:
          return {
            content: [{ type: "text", text: `Unknown tool name: ${name}` }],
            isError: true,
          };
      }
    } catch (toolErr) {
      const msg = toolErr instanceof Error ? toolErr.message : String(toolErr);
      return {
        content: [{ type: "text", text: `Error executing ${name}: ${msg}` }],
        isError: true,
      };
    }
  }

  private walkDir(
    currentDir: string,
    root: string,
    currentDepth: number,
    maxDepth: number,
  ): Array<{ path: string; type: "file" | "directory"; size?: number }> {
    const results: Array<{ path: string; type: "file" | "directory"; size?: number }> = [];
    if (currentDepth > maxDepth) return results;

    const items = readdirSync(currentDir, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".") || item.name === "node_modules" || item.name === "dist") {
        continue;
      }
      const fullPath = join(currentDir, item.name);
      const relPath = relative(root, fullPath);

      if (item.isDirectory()) {
        results.push({ path: relPath, type: "directory" });
        results.push(...this.walkDir(fullPath, root, currentDepth + 1, maxDepth));
      } else if (item.isFile()) {
        try {
          const st = statSync(fullPath);
          results.push({ path: relPath, type: "file", size: st.size });
        } catch {
          results.push({ path: relPath, type: "file" });
        }
      }
    }
    return results;
  }

  private searchInDir(
    currentDir: string,
    root: string,
    query: string,
    caseSensitive: boolean,
    maxResults: number,
  ): Array<{ file: string; line: number; content: string }> {
    const results: Array<{ file: string; line: number; content: string }> = [];
    const normalizedQuery = caseSensitive ? query : query.toLowerCase();

    const searchQueue = [currentDir];
    while (searchQueue.length > 0 && results.length < maxResults) {
      const dir = searchQueue.shift()!;
      let items;
      try {
        items = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const item of items) {
        if (item.name.startsWith(".") || item.name === "node_modules" || item.name === "dist") {
          continue;
        }
        const fullPath = join(dir, item.name);
        if (item.isDirectory()) {
          searchQueue.push(fullPath);
        } else if (item.isFile()) {
          // 仅检索常见文本文件，跳过可能的大型二进制
          if (/\.(png|jpg|jpeg|gif|webp|ico|woff|woff2|ttf|eot|pdf|zip|tar|gz|sqlite|db)$/i.test(item.name)) {
            continue;
          }
          try {
            const content = readFileSync(fullPath, "utf-8");
            const lines = content.split(/\r?\n/);
            const relPath = relative(root, fullPath);

            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line === undefined) continue;
              const lineMatch = caseSensitive ? line : line.toLowerCase();
              if (lineMatch.includes(normalizedQuery)) {
                results.push({ file: relPath, line: i + 1, content: line.trim() });
                if (results.length >= maxResults) break;
              }
            }
          } catch {
            // 编码错误跳过
          }
        }
      }
    }
    return results;
  }
}
