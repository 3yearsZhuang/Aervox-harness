/**
 * Aervox｜思隅 @aervox/api — DSH MCP 桥接器单元与集成测试（CAP-020 / ADR-010 方案一）
 *
 * 覆盖：
 * - JSON-RPC 2.0 协议一致性（initialize / notifications / tools/list / 错误码）；
 * - 6 项 DSH 工具执行（probe_runtime / read_file / list_dir / search_code / str_replace / run_command）；
 * - 路径越界沙箱防护（禁止 ../ 逃逸）；
 * - Fastify 端点挂载（GET /v1/mcp/dsh 与 POST /v1/mcp/dsh）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DshMcpBridge, resolveSafePath } from "../src/modules/mcp/dsh-bridge.js";
import { buildApp } from "../src/app.js";
import { createInMemoryDatabase, initDatabaseSchema } from "@aervox/repositories";
import type { FastifyInstance } from "fastify";

describe("DSH MCP 桥接器 (DshMcpBridge)", () => {
  let sandboxDir: string;
  let bridge: DshMcpBridge;

  beforeEach(() => {
    sandboxDir = mkdtempSync(join(tmpdir(), "aervox-dsh-bridge-"));
    writeFileSync(join(sandboxDir, "sample.txt"), "Line 1: Alpha\nLine 2: Beta\nLine 3: Gamma\n", "utf-8");
    bridge = new DshMcpBridge({ repoRoot: sandboxDir });
  });

  afterEach(() => {
    rmSync(sandboxDir, { recursive: true, force: true });
  });

  it("沙箱路径解析 resolveSafePath：正常相对路径通过，越界路径抛出拒绝", () => {
    expect(resolveSafePath(sandboxDir, "sample.txt")).toBe(join(sandboxDir, "sample.txt"));
    expect(resolveSafePath(sandboxDir, ".")).toBe(sandboxDir);

    expect(() => resolveSafePath(sandboxDir, "../escape.txt")).toThrow("路径越界受阻");
    expect(() => resolveSafePath(sandboxDir, "/etc/passwd")).toThrow("路径越界受阻");
    expect(() => resolveSafePath(sandboxDir, "sub/../../escape.txt")).toThrow("路径越界受阻");
  });

  it("JSON-RPC 协议校验：非法请求与未知方法", async () => {
    const nonObj = await bridge.handleRpc("not an object");
    expect((nonObj as { error: { code: number } }).error.code).toBe(-32600);

    const badVersion = await bridge.handleRpc({ jsonrpc: "1.0", id: 1, method: "test" });
    expect((badVersion as { error: { code: number } }).error.code).toBe(-32600);

    const unknown = await bridge.handleRpc({ jsonrpc: "2.0", id: 2, method: "nonexistent_method" });
    expect((unknown as { error: { code: number } }).error.code).toBe(-32601);
  });

  it("握手与通知：initialize 返回协议版本与能力，notifications/initialized 静默处理", async () => {
    const initRes = await bridge.handleRpc({
      jsonrpc: "2.0",
      id: 10,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(initRes).toMatchObject({
      jsonrpc: "2.0",
      id: 10,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "dsh-mcp-server", version: "1.0.0" },
      },
    });

    const notifRes = await bridge.handleRpc({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notifRes).toBeUndefined();
  });

  it("tools/list：列出 6 项 DSH 核心研发工具", async () => {
    const listRes = await bridge.handleRpc({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/list",
      params: {},
    });
    const tools = (listRes as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain("dsh_probe_runtime");
    expect(names).toContain("dsh_read_file");
    expect(names).toContain("dsh_list_dir");
    expect(names).toContain("dsh_search_code");
    expect(names).toContain("dsh_str_replace");
    expect(names).toContain("dsh_run_command");
  });

  it("dsh_read_file：正常按行切片读取与越界防护", async () => {
    const readFull = await bridge.handleRpc({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "dsh_read_file",
        arguments: { path: "sample.txt", startLine: 2, endLine: 3 },
      },
    });
    const content = (readFull as { result: { content: Array<{ text: string }>; isError: boolean } }).result;
    expect(content.isError).toBe(false);
    expect(content.content[0].text).toContain("2: Line 2: Beta");
    expect(content.content[0].text).toContain("3: Line 3: Gamma");
    expect(content.content[0].text).not.toContain("1: Line 1: Alpha");

    // 越界读取返回 isError
    const escapeRead = await bridge.handleRpc({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "dsh_read_file",
        arguments: { path: "../outside.txt" },
      },
    });
    const escapeContent = (escapeRead as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
    expect(escapeContent.isError).toBe(true);
    expect(escapeContent.content[0].text).toContain("路径越界受阻");
  });

  it("dsh_list_dir 与 dsh_search_code：目录遍历与文本检索", async () => {
    const listRes = await bridge.handleRpc({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "dsh_list_dir",
        arguments: { path: "." },
      },
    });
    const listContent = (listRes as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
    expect(listContent.isError).toBe(false);
    expect(listContent.content[0].text).toContain("sample.txt");

    const searchRes = await bridge.handleRpc({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "dsh_search_code",
        arguments: { query: "Beta" },
      },
    });
    const searchContent = (searchRes as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
    expect(searchContent.isError).toBe(false);
    expect(searchContent.content[0].text).toContain("Line 2: Beta");
  });

  it("dsh_str_replace：单次唯一精确替换，非唯一或不存在均报错", async () => {
    // 成功替换
    const replaceRes = await bridge.handleRpc({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "dsh_str_replace",
        arguments: { path: "sample.txt", oldStr: "Line 2: Beta", newStr: "Line 2: Bravo" },
      },
    });
    const replaceContent = (replaceRes as { result: { isError: boolean } }).result;
    expect(replaceContent.isError).toBe(false);
    expect(readFileSync(join(sandboxDir, "sample.txt"), "utf-8")).toContain("Line 2: Bravo");

    // 不存在时报错
    const notFound = await bridge.handleRpc({
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: {
        name: "dsh_str_replace",
        arguments: { path: "sample.txt", oldStr: "NonExistent", newStr: "Foo" },
      },
    });
    expect((notFound as { result: { isError: boolean } }).result.isError).toBe(true);

    // 多次匹配非唯一报错
    writeFileSync(join(sandboxDir, "multi.txt"), "repeat\nrepeat\n", "utf-8");
    const multi = await bridge.handleRpc({
      jsonrpc: "2.0",
      id: 18,
      method: "tools/call",
      params: {
        name: "dsh_str_replace",
        arguments: { path: "multi.txt", oldStr: "repeat", newStr: "once" },
      },
    });
    expect((multi as { result: { isError: boolean; content: Array<{ text: string }> } }).result.isError).toBe(true);
    expect((multi as { result: { content: Array<{ text: string }> } }).result.content[0].text).toContain("must be unique");
  });

  it("dsh_run_command：本地命令受控执行与状态码返回", async () => {
    const runRes = await bridge.handleRpc({
      jsonrpc: "2.0",
      id: 19,
      method: "tools/call",
      params: {
        name: "dsh_run_command",
        arguments: { command: "node -e 'console.log(\"dsh_test_ok\")'" },
      },
    });
    const runContent = (runRes as { result: { isError: boolean; content: Array<{ text: string }> } }).result;
    expect(runContent.isError).toBe(false);
    expect(runContent.content[0].text).toContain("dsh_test_ok");

    // 非零退出码标记 isError
    const failCmd = await bridge.handleRpc({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "dsh_run_command",
        arguments: { command: "node -e 'process.exit(2)'" },
      },
    });
    expect((failCmd as { result: { isError: boolean } }).result.isError).toBe(true);
  });
});

describe("DSH MCP Fastify 端点集成 (/v1/mcp/dsh)", () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const res = await createInMemoryDatabase();
    cleanup = res.cleanup;
    await initDatabaseSchema(res.client);
    const built = await buildApp({ db: res.db, client: res.client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await cleanup();
  });

  it("GET /v1/mcp/dsh 返回健康探测状态", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/mcp/dsh" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "ok",
      server: "dsh-mcp-server",
      protocolVersion: "2025-06-18",
    });
  });

  it("POST /v1/mcp/dsh 处理 initialize 与 tools/list", async () => {
    const initRes = await app.inject({
      method: "POST",
      url: "/v1/mcp/dsh",
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    expect(initRes.statusCode).toBe(200);
    expect(initRes.json().result.serverInfo.name).toBe("dsh-mcp-server");

    const listRes = await app.inject({
      method: "POST",
      url: "/v1/mcp/dsh",
      payload: { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().result.tools).toHaveLength(6);
  });
});
