/**
 * Aervox｜思隅 @aervox/host-agent — CLI 控制台交互式人机回环审批策略 (CliInteractiveApprovalPolicy)
 *
 * 依据 aervox_core_decoupling_plan.md Phase 2：
 * 在 CLI / 终端等独立宿主环境下，无需启动 API 服务即可直接通过终端控制台进行权限审批 [y/N]。
 */

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type {
  ApprovalPolicyPort,
  ToolApprovalDecision,
  ToolApprovalRequest,
} from "@aervox/agent-loop";

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

    const argsFormatted = JSON.stringify(req.arguments, null, 2);
    const promptText = `\n\x1b[33m[权限审批请求]\x1b[0m 工具: \x1b[1m${req.toolName}\x1b[0m\n参数:\n${argsFormatted}\n是否允许执行此写操作? [y/N]: `;

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<string>((_, reject) => {
      timer = setTimeout(() => reject(new Error("approval_timeout")), this.timeoutMs);
      if (signal) {
        signal.addEventListener("abort", () => {
          if (timer) clearTimeout(timer);
          reject(new Error("approval_aborted"));
        }, { once: true });
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
          if (timer) clearTimeout(timer);
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

      if (timer) clearTimeout(timer);

      const trimmed = answer.trim().toLowerCase();
      if (trimmed === "y" || trimmed === "yes") {
        return { action: "allow" };
      }

      return {
        action: "deny",
        reason: "user_rejected",
      };
    } catch (err) {
      if (timer) clearTimeout(timer);
      return {
        action: "deny",
        reason: err instanceof Error ? err.message : "approval_failed",
      };
    }
  }
}
