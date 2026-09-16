/**
 * Aervox｜思隅 @aervox/repositories — 工具授权账本（待决/裁决/复用）Store
 */
import { eq, and, or, isNull, desc, notLike } from "drizzle-orm";
import type { AervoxDatabase } from "../../../client.js";
import { toolApprovals, turns } from "@aervox/schema";
import type { LocalContext } from "../../../local-context.js";
import type { ToolApprovalModel } from "../../types/index.js";

export class ApprovalStore {
  constructor(private readonly db: AervoxDatabase) {}

  /** 记录一条工具授权（阶段 3a） */
  async recordToolApproval(
    ctx: LocalContext,
    input: {
      turnId: string;
      attemptId: string;
      toolName: string;
      argumentsHash: string;
      requester: string;
      state: "pending" | "granted" | "denied";
      toolVersion?: string | null;
    },
  ): Promise<ToolApprovalModel> {
    // E1（§12.2「ToolInvocation + 授权快照 + 幂等预留」）：同 (toolName, argumentsHash) 已存在
    // 未决（pending）授权则复用既有行，不重复插入——授权匹配键跨 turn 复用（schema 注释约定），
    // 幂等预留语义：重复的写工具意图不会产生多行待决授权。granted/denied 后新请求才新建。
    if (input.state === "pending") {
      const [existing] = await this.db
        .select()
        .from(toolApprovals)
        .where(
          and(
            eq(toolApprovals.toolName, input.toolName),
            eq(toolApprovals.argumentsHash, input.argumentsHash),
            eq(toolApprovals.state, "pending"),
          ),
        )
        .orderBy(desc(toolApprovals.id))
        .limit(1);
      if (existing) return existing as ToolApprovalModel;
    }
    const [created] = await this.db
      .insert(toolApprovals)
      .values({
        id: `tapp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
        turnId: input.turnId,
        attemptId: input.attemptId,
        toolName: input.toolName,
        argumentsHash: input.argumentsHash,
        toolVersion: input.toolVersion ?? null,
        requester: input.requester,
        state: input.state,
      })
      .returning();
    return created as ToolApprovalModel;
  }

  /** 决定（grant/deny）一条待决授权 */
  async decideToolApproval(
    ctx: LocalContext,
    approvalId: string,
    decision: "granted" | "denied",
    decidedBy: string,
  ): Promise<ToolApprovalModel | null> {
    const [updated] = await this.db
      .update(toolApprovals)
      .set({
        state: decision,
        decidedBy,
        decidedAt: new Date().toISOString(),
      })
      .from(turns)
      .where(
        and(
          eq(toolApprovals.id, approvalId),
          eq(toolApprovals.turnId, turns.id),
        ),
      )
      .returning();
    return (updated as ToolApprovalModel) ?? null;
  }

  /** 3b：读单条授权记录（privileged 管理员校验预检用） */
  async getToolApproval(ctx: LocalContext, approvalId: string): Promise<ToolApprovalModel | null> {
    const [row] = await this.db
      .select()
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.id, approvalId),
        ),
      )
      .limit(1);
    return (row as ToolApprovalModel) ?? null;
  }

  /** 查询 Turn 的授权账本 */
  async listToolApprovalsByTurn(ctx: LocalContext, turnId: string): Promise<ToolApprovalModel[]> {
    const rows = await this.db
      .select()
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.turnId, turnId),
        ),
      )
      .orderBy(desc(toolApprovals.id));
    return rows as ToolApprovalModel[];
  }

  /** 匹配已授权记录（toolName + argumentsHash；跨 turn 复用，取最近一条） */
  async findGrantedToolApproval(
    ctx: LocalContext,
    input: {
      toolName: string;
      argumentsHash: string;
      excludeDecidedByPrefix?: string;
      excludeDecidedByPrefixes?: string[];
    },
  ): Promise<ToolApprovalModel | null> {
    const excludedPrefixes = [
      ...(input.excludeDecidedByPrefixes ?? []),
      ...(input.excludeDecidedByPrefix ? [input.excludeDecidedByPrefix] : []),
    ];
    const [found] = await this.db
      .select()
      .from(toolApprovals)
      .where(
        and(
          eq(toolApprovals.toolName, input.toolName),
          eq(toolApprovals.argumentsHash, input.argumentsHash),
          eq(toolApprovals.state, "granted"),
          excludedPrefixes.length > 0
            ? or(
                isNull(toolApprovals.decidedBy),
                and(...excludedPrefixes.map((prefix) => notLike(toolApprovals.decidedBy, `${prefix}%`))),
              )
            : undefined,
        ),
      )
      .orderBy(desc(toolApprovals.id));
    return (found as ToolApprovalModel) ?? null;
  }
}
