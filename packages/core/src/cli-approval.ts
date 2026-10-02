/**
 * Aervox｜思隅 @aervox/core — CLI 控制台交互式人机回环审批策略 (CliInteractiveApprovalPolicy)
 *
 * 依据 ADR-021 自 packages/host-agent 迁入（消除 libsql 依赖拖拽）：
 * 在 CLI / 终端等独立宿主环境下，无需启动 API 服务即可直接通过终端控制台进行权限审批 [y/N]。
 */

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type {
  ApprovalPolicyPort,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "./ports.js";

export interface CliInteractiveApprovalPolicyOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  /** 自定义控制台提问回调（如复用外部已有 readline 句柄或 GUI 弹窗） */
  promptUser?: (promptText: string) => Promise<string>;
  /** 是否自动放行（非 TTY 或指定全自动模式时） */
  autoApprove?: boolean;
  /** 询问超时（毫秒），默认 30_000ms */
  timeoutMs?: number;
}

/**
 * CLI 控制台交互审批策略实现
 */
export class CliInteractiveApprovalPolicy implements ApprovalPolicyPort {
  private readonly input: NodeJS.ReadableStream;
  private readonly output: NodeJS.WritableStream;
  private readonly promptUser?: (promptText: string) => Promise<string>;
  private readonly autoApprove: boolean;
  private readonly timeoutMs: number;

  constructor(options: CliInteractiveApprovalPolicyOptions = {}) {
    this.input = options.input ?? stdin;
    this.output = options.output ?? stdout;
    this.promptUser = options.promptUser;
    this.autoApprove = options.autoApprove ?? false;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async evaluate(req: ToolApprovalRequest, signal?: AbortSignal): Promise<ToolApprovalDecision> {
    if (req.safetyLevel === "read_only") {
      return { action: "allow" };
    }

    if (this.autoApprove) {
      return { action: "allow" };
    }

    // 快速失败：signal 在进入审批前已中止（如 Turn 已取消/超时），不再等待超时
    if (signal?.aborted) {
      return {
        action: "deny",
        reason: "approval_aborted",
      };
    }

    const argsFormatted = JSON.stringify(req.arguments, null, 2);
    const promptText = `\n\x1b[33m[权限审批请求]\x1b[0m 工具: \x1b[1m${req.toolName}\x1b[0m\n参数:\n${argsFormatted}\n是否允许执行此写操作? [y/N]: `;

    let timer: NodeJS.Timeout | undefined;
    let detachAbortListener: (() => void) | undefined;
    /** 统一清理：清除超时定时器并解绑 abort 监听（同一 turn signal 复用时不累积监听器） */
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      detachAbortListener?.();
    };
    const timeoutPromise = new Promise<string>((_, reject) => {
      timer = setTimeout(() => reject(new Error("approval_timeout")), this.timeoutMs);
      if (signal) {
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          reject(new Error("approval_aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        detachAbortListener = () => signal!.removeEventListener("abort", onAbort);
      }
    });

    try {
      let answer: string;
      if (this.promptUser) {
        answer = await Promise.race([this.promptUser(promptText), timeoutPromise]);
      } else {
        // 检查是否具备 TTY 交互能力
        const isTTY = Boolean((this.input as { isTTY?: boolean }).isTTY);
        if (!isTTY) {
          cleanup();
          return {
            action: "deny",
            reason: `cli_non_interactive: tool ${req.toolName} requires interactive approval but stdin is not a TTY`,
          };
        }

        const rl = readline.createInterface({
          input: this.input,
          output: this.output,
        });

        try {
          answer = await Promise.race([rl.question(promptText), timeoutPromise]);
        } finally {
          rl.close();
          if (typeof (this.input as { resume?: () => void }).resume === "function") {
            (this.input as { resume: () => void }).resume();
          }
        }
      }

      cleanup();

      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "y" || trimmed === "yes") {
        return { action: "allow" };
      }

      return {
        action: "deny",
        reason: "user_rejected",
      };
    } catch (err) {
      cleanup();
      return {
        action: "deny",
        reason: err instanceof Error ? err.message : "approval_failed",
      };
    }
  }
}
