/**
 * Aervox｜思隅 @aervox/host-agent — DSH/pi 进程外 Adapter（stdio JSON 行协议，阶段 6）
 *
 * 规则依据：ADR-010（进程外 Adapter + 版本锁定/契约测试/超时/配额/审计/kill switch；
 * 失败自动禁用）——本实现对每个子进程一次握手（hello → 准入复核），
 * 之后逐 Turn 请求-事件 ping-pong：
 * - 准入：hello 携带 AdapterManifest，host 以 expected（adapterId + 固定 SHA）复核，
 *   失配/许可证/策略异常 → kill 并抛 adapter_admission_failed（TC-CONTRACT-STREAM-001）；
 * - 超时：握手与每 Turn 请求均有限时，超时 kill（失败自动禁用，后续 run 抛 adapter_unavailable）；
 * - kill switch：close() 幂等终止子进程；意外退出标记失效；
 * - 事件行按 requestId 分发到对应 Turn 的异步迭代器；batch 事件交由 drainAdapterDriver 收紧。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import {
  decodeAdapterLine,
  encodeAdapterLine,
  verifyAdapterManifest,
} from "@aervox/agent-loop";
import type {
  AdapterDriverId,
  AdapterDriverPort,
  AdapterEvent,
  AdapterManifest,
  AdapterRequest,
  AdapterWireMessage,
} from "@aervox/agent-loop";

export interface StdioAdapterDriverDeps {
  /** 适配器可执行（fixture 可为 `node <path>/sim-adapter.mjs`） */
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** host 期望的准入键（固定 SHA 复核；缺 sha 则仅校验 adapterId+许可证+策略） */
  expected: { adapterId: AdapterDriverId; sha256?: string };
  /** 握手（hello）超时，缺省 2000ms */
  handshakeTimeoutMs?: number;
  /** 单 Turn 请求总超时，缺省 10000ms */
  requestTimeoutMs?: number;
}

export interface StdioAdapterDriverHandle {
  driver: AdapterDriverPort;
  /** kill switch：终止子进程（幂等）；关闭后 run 抛 adapter_unavailable */
  close(): Promise<void>;
}

/** 简单超时辅助（promise 竞速；到期抛 timeout） */
const withTimeout = <T>(promise: Promise<T>, ms: number, reason: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(reason)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

/** 从子进程 stdout 逐行构造消息流（按 requestId 分发到活跃 Turn） */
export async function createStdioAdapterDriver(
  deps: StdioAdapterDriverDeps,
): Promise<StdioAdapterDriverHandle> {
  const handshakeTimeoutMs = deps.handshakeTimeoutMs ?? 2000;
  const requestTimeoutMs = deps.requestTimeoutMs ?? 10000;

  const child: ChildProcess = spawn(deps.command, deps.args ?? [], {
    cwd: deps.cwd,
    env: { ...process.env, ...deps.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const readline = createInterface({ input: child.stdout! });

  let admitted = false;
  let closed = false;
  /** requestId → 该 Turn 的续读回调（null = 已结束） */
  const streams = new Map<string, {
    /** 事件入队并唤醒等待者；done 到达后丢弃新事件（防御） */
    onEvent: (ev: AdapterEvent) => void;
    onDone: () => void;
    onError: (message: string) => void;
  }>();

  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(`[adapter-stderr] ${chunk.toString()}`);
  });

  const failUnavailable = () => {
    closed = true;
    for (const s of streams.values()) s.onError("adapter_unavailable");
    streams.clear();
  };
  child.on("exit", () => failUnavailable());
  child.on("error", () => failUnavailable());

  /** 返回已准入的 manifest（hello 行解析；超时/失配 → 抛错并 kill） */
  const handshake = (): Promise<AdapterManifest> =>
    withTimeout(
      new Promise<AdapterManifest>((resolve, reject) => {
        const onLine = (line: string) => {
          try {
            const msg = decodeAdapterLine(line);
            if (msg.kind !== "hello") {
              throw new Error(`adapter_protocol_invalid: expected hello, got ${msg.kind}`);
            }
            const verification = verifyAdapterManifest(msg.manifest, {
              adapterId: deps.expected.adapterId,
              sha256: deps.expected.sha256,
            });
            if (!verification.ok) {
              reject(new Error(`adapter_admission_failed: ${verification.error}`));
              return;
            }
            resolve(msg.manifest);
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return; // 不再消费该行
          }
        };
        readline.once("line", onLine);
        readline.once("close", () => reject(new Error("adapter_handshake_eof")));
      }),
      handshakeTimeoutMs,
      "adapter_handshake_timeout",
    );

  const onLine = (line: string): void => {
    if (!admitted) return; // 握手行已由 handshake 消费
    let msg: AdapterWireMessage;
    try {
      msg = decodeAdapterLine(line);
    } catch {
      failUnavailable();
      return;
    }
    if (msg.kind === "error") {
      streams.get(msg.id)?.onError(msg.message);
      streams.delete(msg.id);
      return;
    }
    if (msg.kind === "done") {
      streams.get(msg.id)?.onDone();
      streams.delete(msg.id);
      return;
    }
    if (msg.kind === "event" || msg.kind === "batch") {
      streams.get(msg.id)?.onEvent(
        msg.kind === "event"
          ? msg.event
          : { type: "batch", concludes: msg.concludes },
      );
    }
  };
  readline.on("line", onLine);

  const manifest = await handshake();
  admitted = true;

  const run = async function* (request: AdapterRequest): AsyncIterable<AdapterEvent> {
    if (!admitted || closed) {
      throw new Error("adapter_unavailable");
    }
    const requestId = `${request.attemptId}:${Date.now().toString(36)}`;
    /** 统一事件队列 + 等待者 pump：事件入队 → 唤醒消费者依次出队；
     *  done 仅是「无更多事件」标记，已入队事件全部消费后才返回——杜绝竞态吞事件 */
    const queue: AdapterEvent[] = [];
    let doneArrived = false;
    let errorArrived: string | undefined;
    let waiter:
      | { resolve: (ev: AdapterEvent | "done") => void; reject: (e: Error) => void }
      | undefined;

    const pump = () => {
      if (!waiter) return;
      if (queue.length > 0) {
        const w = waiter;
        waiter = undefined;
        w.resolve(queue.shift() as AdapterEvent);
      } else if (errorArrived !== undefined) {
        const w = waiter;
        waiter = undefined;
        w.reject(new Error(errorArrived));
      } else if (doneArrived) {
        const w = waiter;
        waiter = undefined;
        w.resolve("done");
      }
    };

    streams.set(requestId, {
      onEvent: (ev) => {
        if (doneArrived || errorArrived !== undefined) return; // done/error 后丢弃防御
        queue.push(ev);
        pump();
      },
      onDone: () => {
        doneArrived = true;
        pump();
      },
      onError: (message) => {
        errorArrived = message;
        pump();
      },
    });

    child.stdin?.write(`${encodeAdapterLine({ kind: "request", id: requestId, request })}\n`);

    try {
      // 每次请求整体超时：超时 kill（失败自动禁用）
      const timeout = setTimeout(() => {
        void (async () => {
          const s = streams.get(requestId);
          if (s) s.onError(new Error("adapter_request_timeout").message);
          child.kill();
          closed = true;
        })();
      }, requestTimeoutMs);

      for (;;) {
        const ev = await new Promise<AdapterEvent | "done">((resolve, reject) => {
          waiter = { resolve, reject };
          pump(); // 事件可能在设置 waiter 前已到达（入队）→ 立即补发
        });
        if (ev === "done") break;
        yield ev;
      }
      clearTimeout(timeout);
    } finally {
      streams.delete(requestId);
    }
  };

  return {
    driver: {
      id: deps.expected.adapterId,
      manifest,
      run,
    },
    close: async () => {
      closed = true;
      child.kill();
    },
  };
}

export type { AdapterDriverPort, AdapterManifest } from "@aervox/agent-loop";