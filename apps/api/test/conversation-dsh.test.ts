/**
 * Aervox｜思隅 @aervox/api — DSH 进程外 Adapter API 接线测试（ADR-010 阶段 6f）
 *
 * 覆盖：
 * - AERVOX_LOOP_DRIVER=dsh + 准入失败（非 git 仓库根）：fail-closed——error 事件
 *   （ADAPTER_UNAVAILABLE + dsh_probe_failed）+ Turn Failed，不静默回退 native Loop；
 * - 准入通过 + 本地 OpenAI 兼容端点（it.runIf：子模块就绪）：整 Turn 经 DSH Adapter
 *   执行，事件映射既有契约（message → delta → done Completed），SSE 契约零改动；
 * - resolver 进程内缓存语义：禁用态缓存后同进程重复 Turn 快速失败。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createInMemoryDatabase } from "@aervox/database";
import { buildApp } from "../src/app.js";
import { resetDshTurnAdapterForTests, resolveDshTurnAdapter } from "../src/modules/conversation/dsh-adapter.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import type { FastifyInstance } from "fastify";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
/** 非 git 根（fixtures 目录）：probeDSHReference 必然 submodule_missing */
const nonRepoRoot = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
/** 参考仓库子模块就绪（gitlink + package.json 存在）时才跑真 Turn 路径 */
const refSubmoduleReady = existsSync(join(repoRoot, "reference", "deepseek-harness", "package.json"));

const headers = {
  "x-workspace-id": "ws_dsh",
  "x-user-id": "usr_dsh",
} as const;

const turnPayload = {
  message: { content: "用一句话说明 Agent Harness 的价值", contentType: "text" },
  clientVersion: "it-dsh",
  references: [],
};

interface ParsedEvent {
  eventId: string;
  turnId: string;
  sequence: number;
  eventType: string;
  data: {
    status?: string;
    code?: string;
    text?: string;
    message?: string;
    isComplete?: boolean;
  };
}

const parseSse = (body: string): ParsedEvent[] =>
  body
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const data = block.split("\n").find((l) => l.startsWith("data: "));
      return data ? (JSON.parse(data.slice(6)) as ParsedEvent) : null;
    })
    .filter((x): x is ParsedEvent => x !== null);

describe("Agent Loop 阶段 6f：AERVOX_LOOP_DRIVER=dsh API 接线", () => {
  let app: FastifyInstance;
  let cleanup: (() => Promise<void>) | undefined;
  const closeFns: Array<() => Promise<void>> = [];

  const createTurn = async (sessionId = "ses_dsh") =>
    app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/turns`,
      headers,
      payload: turnPayload,
    });

  /** 轮询事件流直至出现 done/error（后台执行与子进程回合需要等待） */
  const pollEvents = async (turnId: string, timeoutMs = 20_000): Promise<ParsedEvent[]> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const res = await app.inject({ method: "GET", url: `/v1/turns/${turnId}/events`, headers });
      expect(res.statusCode).toBe(200);
      const parsed = parseSse(res.body);
      const last = parsed[parsed.length - 1];
      if (last && (last.eventType === "done" || last.eventType === "error")) return parsed;
      if (Date.now() > deadline) return parsed;
      await new Promise((r) => setTimeout(r, 150));
    }
  };

  beforeEach(async () => {
    process.env.AERVOX_LOOP_DRIVER = "dsh";
    process.env.AERVOX_DSH_REPO_ROOT = nonRepoRoot;
    resetDshTurnAdapterForTests();
    const res = await createInMemoryDatabase();
    cleanup = res.cleanup;
    const built = await buildApp({ db: res.db, client: res.client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_DRIVER;
    delete process.env.AERVOX_DSH_REPO_ROOT;
    delete process.env.DSH_LLM_BASE_URL;
    delete process.env.DEEPSEEK_API_KEY;
    resetDshTurnAdapterForTests();
    while (closeFns.length > 0) {
      await closeFns.pop()?.();
    }
    await app.close();
    await cleanup?.();
  });

  it("准入失败（非 git 根）→ fail-closed：ADAPTER_UNAVAILABLE error 事件 + 不回退 native", async () => {
    const created = await createTurn();
    expect(created.statusCode).toBe(201);
    const turnId = created.json().turnId as string;

    const parsed = await pollEvents(turnId);
    const errorEvent = parsed.find((e) => e.eventType === "error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.data.code).toBe("ADAPTER_UNAVAILABLE");
    expect(errorEvent?.data.message).toContain("dsh_probe_failed");
    // 不静默回退 native：无任何 delta（native replay 会产生 delta 事件流）
    expect(parsed.some((e) => e.eventType === "delta")).toBe(false);
  });

  it("禁用态进程内缓存：第二次 Turn 快速失败且 reason 一致（不重复准入探测）", async () => {
    const first = await createTurn("ses_dsh_cache_1");
    expect(first.statusCode).toBe(201);
    await pollEvents(first.json().turnId as string);

    const second = await createTurn("ses_dsh_cache_2");
    expect(second.statusCode).toBe(201);
    const parsed = await pollEvents(second.json().turnId as string);
    const errorEvent = parsed.find((e) => e.eventType === "error");
    expect(errorEvent?.data.code).toBe("ADAPTER_UNAVAILABLE");
    expect(errorEvent?.data.message).toContain("dsh_probe_failed");
  });

  it("resolver：非 git 根 → ok:false（dsh_probe_failed / submodule_missing）", async () => {
    const resolved = await resolveDshTurnAdapter({ repoRoot: nonRepoRoot });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.reason).toContain("dsh_probe_failed");
      expect(resolved.reason).toContain("submodule_missing");
    }
  });

  it.runIf(refSubmoduleReady)(
    "准入通过 + 本地兼容端点：整 Turn 经 DSH Adapter，message → delta → done Completed（SSE 契约不变）",
    async () => {
      const server: Server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [
                { message: { role: "assistant", content: "Agent Harness 的框架价值是把模型循环与安全边界分离。" } },
              ],
            }),
          );
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      closeFns.push(
        () => new Promise<void>((r) => server.close(() => r())),
      );
      const port = (server.address() as AddressInfo).port;

      process.env.AERVOX_DSH_REPO_ROOT = repoRoot;
      process.env.DSH_LLM_BASE_URL = `http://127.0.0.1:${port}`;
      resetDshTurnAdapterForTests();

      const created = await createTurn();
      expect(created.statusCode).toBe(201);
      const turnId = created.json().turnId as string;

      const parsed = await pollEvents(turnId, 30_000);
      const types = parsed.map((e) => e.eventType);
      expect(types[0]).toBe("message");
      expect(types).toContain("delta");
      const done = parsed.find((e) => e.eventType === "done");
      expect(done?.data.status).toBe("Completed");
      const delta = parsed.find((e) => e.eventType === "delta");
      expect(delta?.data.text).toContain("模型循环与安全边界分离");
    },
    40_000,
  );
});
