/**
 * Aervox｜思隅 @aervox/api — llama.cpp（llama-server）子进程生命周期管理（CR-054）
 *
 * 职责：
 * - 可执行文件解析：环境变量 `AERVOX_LLAMA_SERVER_PATH` 优先，否则探测 PATH 中
 *   的 `llama-server`（探测结果短时缓存，避免每次状态查询都 spawn）；
 * - 启动：以 `-m <模型> --port <port> -c <ctx> -ngl <gpuLayers> -t <threads> --jinja`
 *   构造参数并 spawn，随后轮询 `/health` 直至 ready 或超时；
 * - 停止：SIGTERM → 3s 兜底 SIGKILL；子进程异常退出（非 stop 触发）置为 error；
 * - 全链路注入式 `spawn`（测试可注入假实现），避免状态查询与真实端口耦合。
 */
import { spawn as nodeSpawn, spawnSync, type ChildProcess } from "node:child_process";
import type { LlamaRuntimeParams, LlamaRuntimeStatus, LocalModel } from "@aervox/contracts";
import type { ModelRuntimeDriver, ModelRuntimeDriverHandle } from "./driver.js";

export type LlamaServerHandle = ModelRuntimeDriverHandle;

export interface LlamaServerManagerDeps {
  /** 可执行文件解析器（缺省走 AERVOX_LLAMA_SERVER_PATH / PATH 探测） */
  resolveBin?: () => string | null;
  /** spawn 注入点（测试替换） */
  spawn?: typeof nodeSpawn;
  /** 健康端点的 fetch 注入点（测试替换） */
  fetchImpl?: typeof fetch;
  /** 健康探测间隔 / 总超时 */
  probeIntervalMs?: number;
  probeTimeoutMs?: number;
  /** SIGTERM 后强杀宽限 */
  killGraceMs?: number;
}

const HEALTH_CHECK_PATH = "/health";

export class LlamaServerManager implements ModelRuntimeDriver {
  readonly id = "llama-server";
  readonly name = "llama.cpp server";

  private child: ChildProcess | null = null;
  private status: LlamaRuntimeStatus = "idle";
  private port: number | null = null;
  private modelId: string | null = null;
  private startedAt: string | null = null;
  private error: string | null = null;
  private stopping = false;
  /** start() 超时收尾触发的强制终止：终止进程但保持当前 status，由调用方随后回写错误语义 */
  private forceTerminating = false;

  private readonly spawnFn: typeof nodeSpawn;
  private readonly fetchFn: typeof fetch;
  private readonly probeIntervalMs: number;
  private readonly probeTimeoutMs: number;
  private readonly killGraceMs: number;
  private resolvedBin: string | null | undefined = undefined;
  /** stderr 环形缓冲（单条上限免超长行刷爆内存） */
  private readonly logs: string[] = [];
  private static readonly MAX_LOGS = 60;
  private static readonly MAX_LINE_LENGTH = 800;

  constructor(private readonly deps: LlamaServerManagerDeps = {}) {
    this.spawnFn = deps.spawn ?? nodeSpawn;
    this.fetchFn = deps.fetchImpl ?? fetch;
    this.probeIntervalMs = deps.probeIntervalMs ?? 600;
    this.probeTimeoutMs = deps.probeTimeoutMs ?? 30_000;
    this.killGraceMs = deps.killGraceMs ?? 3_000;
  }

  /** 解析 llama-server 可执行路径（env 覆盖 → PATH 探测 → null） */
  resolveBinary(): string | null {
    if (this.resolvedBin !== undefined) return this.resolvedBin;
    this.resolvedBin = (this.deps.resolveBin?.() ?? this.detectBinary()) as string | null;
    return this.resolvedBin;
  }

  private detectBinary(): string | null {
    const envPath = process.env.AERVOX_LLAMA_SERVER_PATH;
    if (envPath && envPath.trim()) return envPath.trim();
    try {
      const probe = spawnSync("llama-server", ["--version"], {
        stdio: "ignore",
        timeout: 5_000,
        shell: false,
      });
      if (probe.error === undefined || probe.status === 0 || probe.signal === null) {
        // 能找到命令（spawnSync 未报 ENOENT）即视为可用；status 非零也允许（版本打印差异）
        if (probe.error === undefined) return "llama-server";
      }
    } catch {
      // ignore
    }
    return null;
  }

  /** 当前句柄状态快照 */
  getHandle(): LlamaServerHandle {
    return {
      pid: this.child?.pid ?? null,
      status: this.status,
      port: this.port,
      modelId: this.modelId,
      startedAt: this.startedAt,
      error: this.error,
      logs: [...this.logs],
    };
  }

  /** 追加一行 stderr（环形裁剪：超长截断 + 超量淘汰最旧） */
  private pushLog(line: string): void {
    const trimmed = line.replace(/\s+$/u, "").slice(0, LlamaServerManager.MAX_LINE_LENGTH);
    if (!trimmed) return;
    this.logs.push(trimmed);
    if (this.logs.length > LlamaServerManager.MAX_LOGS) {
      this.logs.splice(0, this.logs.length - LlamaServerManager.MAX_LOGS);
    }
  }

  get running(): boolean {
    return this.status === "running";
  }

  /**
   * 采样运行指标（llama.cpp /metrics，Prometheus 文本；需 server 启用 --metrics）。
   * 解析 llama_tokens_per_second / llama_prompt_tokens_per_second；端点不可用返回 null。
   */
  async sampleMetrics(): Promise<{ at: string; tokensPerSec?: number; promptTokensPerSec?: number } | null> {
    if (!this.running || this.port === null) return null;
    try {
      const res = await this.fetchFn(`http://127.0.0.1:${this.port}/metrics`);
      if (!res.ok) return null;
      const text = await res.text();
      const parse = (name: string): number | undefined => {
        const m = new RegExp(`^${name} ([0-9.]+)`, "m").exec(text);
        if (!m || m[1] === undefined) return undefined;
        return Number.parseFloat(m[1]);
      };
      return {
        at: new Date().toISOString(),
        tokensPerSec: parse("llama_tokens_per_second"),
        promptTokensPerSec: parse("llama_prompt_tokens_per_second"),
      };
    } catch {
      return null;
    }
  }

  /** 已配置（可执行文件可解析） */
  get configured(): boolean {
    return this.resolveBinary() !== null;
  }

  /**
   * 启动单个本地模型：spawn llama-server 并等待 /health 就绪。
   * @throws 启动超时 / 可执行文件缺失 / 模型文件不存在
   */
  async start(model: LocalModel, params: LlamaRuntimeParams): Promise<LlamaServerHandle> {
    const bin = this.resolveBinary();
    if (!bin) {
      throw new Error(
        "llama_server_binary_missing: 未找到 llama-server。请安装 llama.cpp 或设置 AERVOX_LLAMA_SERVER_PATH 指向可执行文件",
      );
    }
    this.throwIfBusy();

    const args = [
      "-m",
      model.path,
      "--port",
      String(params.port),
      "-c",
      String(params.ctxSize),
      "-ngl",
      String(params.gpuLayers),
      "-t",
      String(params.threads),
      "--jinja",
    ];

    this.status = "starting";
    this.port = params.port;
    this.modelId = model.id;
    this.startedAt = new Date().toISOString();
    this.error = null;
    this.stopping = false;
    this.forceTerminating = false;

    const child = this.spawnFn(bin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    this.child = child;

    const stderrChunks: Buffer[] = [];
    let stderrPartial = ""; // 未换行残片
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrPartial += chunk.toString("utf8");
      let newlineIndex: number;
      while ((newlineIndex = stderrPartial.indexOf("\n")) >= 0) {
        const line = stderrPartial.slice(0, newlineIndex);
        stderrPartial = stderrPartial.slice(newlineIndex + 1);
        this.pushLog(line);
      }
    });
    child.stdout?.on("data", () => undefined);

    child.on("exit", (code, signal) => {
      if (this.stopping) {
        // stop() 主动停止：转入 idle
        this.status = "idle";
      } else if (this.forceTerminating) {
        // start() 超时收尾强杀：保持当前 status（starting），错误语义由调用方回写
      } else if (this.status === "starting" || this.status === "running") {
        this.status = "error";
        this.error = `llama-server 意外退出 (code=${code ?? "null"} signal=${signal ?? "null"}): ${
          Buffer.concat(stderrChunks.slice(-4)).toString("utf8").slice(-400) || "无 stderr 输出"
        }`;
      }
      this.child = null;
    });
    child.on("error", (err) => {
      if (!this.stopping && !this.forceTerminating) {
        this.status = "error";
        this.error = `llama-server 启动失败: ${err.message}`;
      }
      this.child = null;
    });

    // 健康探测：轮询 http://127.0.0.1:<port>/health 直至 ok 或超时
    const deadline = Date.now() + this.probeTimeoutMs;
    while (Date.now() < deadline) {
      if (this.stopping || !this.child) break;
      try {
        const res = await this.fetchFn(`http://127.0.0.1:${params.port}${HEALTH_CHECK_PATH}`);
        if (res.ok && this.child) {
          this.status = "running";
          return this.getHandle();
        }
      } catch {
        // 服务尚未就绪，继续轮询
      }
      await new Promise((resolve) => setTimeout(resolve, this.probeIntervalMs));
    }

    // 循环退出：进程已崩溃（exit/error 已置 status=error 并清空 child）→ 终结进程后抛错；
    // 否则视为健康探测超时 → 强杀后抛错。统一以启动失败收尾（调用方按错误处理）。
    if (this.child) {
      await this.forceStop();
    }
    if (this.status === "starting" || this.status === "running") {
      const tail = Buffer.concat(stderrChunks.slice(-4)).toString("utf8").slice(-400);
      this.status = "error";
      this.error = `llama-server 健康检查超时（${this.probeTimeoutMs}ms）: ${tail || "无 stderr 输出"}`;
    }
    throw new Error(this.error ?? "llama-server 启动失败");
  }

  /** 停止（幂等）：SIGTERM → 宽限 → SIGKILL */
  async stop(): Promise<LlamaServerHandle> {
    const child = this.child;
    if (!child || this.status === "idle") return this.getHandle();
    this.stopping = true;
    this.status = "stopping";
    try {
      child.kill("SIGTERM");
    } catch {
      // kill 失败（进程可能已退出）继续
    }
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, this.killGraceMs)),
    ]);
    if (this.child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    this.status = "idle";
    this.child = null;
    this.port = null;
    this.modelId = null;
    return this.getHandle();
  }

  private throwIfBusy(): void {
    const child = this.child;
    if (child && this.status !== "idle" && this.status !== "error") {
      throw new Error(`llama_server_busy: 运行时已处于 ${this.status}（PID ${child.pid ?? "?"}）`);
    }
  }

  /** 超时/失败时强制收尾（保持当前 status，由调用方回写错误语义） */
  private async forceStop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.forceTerminating = true;
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, this.killGraceMs)),
    ]);
    if (this.child) {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    this.child = null;
    this.forceTerminating = false;
  }
}