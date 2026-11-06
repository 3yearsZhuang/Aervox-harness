import type { AskUserQuestionPortRequest, AskUserQuestionPortResult, UserQuestionPort } from "@aervox/core/browser";
import type { ConversationStreamEventRow } from "./conversation-execution-repository-port.js";

export interface QuestionIdentity { turnId: string; attemptId: string; invocationId: string; step: number }
export interface QuestionExecutionOwner { turnId: string; attemptId: string; expectedFencingToken: number; leaseId: string }
export interface DurablePendingQuestion {
  turnId: string; attemptId: string; invocationId: string | null; step: number;
  questions: AskUserQuestionPortRequest["questions"]; timeoutMs: number; expiresAt: string; createdAt: string;
  identityStatus: "available" | "identity_unavailable";
}
export interface QuestionAnswerReceipt extends QuestionIdentity {
  accepted: true; answers: AskUserQuestionPortResult["answers"]; event: ConversationStreamEventRow;
}
export interface UserQuestionCommands<Context> {
  require(ctx: Context, input: QuestionIdentity & Omit<QuestionExecutionOwner, "turnId" | "attemptId"> & {
    questions: AskUserQuestionPortRequest["questions"]; timeoutMs: number;
  }): Promise<{ event: ConversationStreamEventRow; pending: DurablePendingQuestion | null; receipt: QuestionAnswerReceipt | null }>;
  getPending(ctx: Context, turnId: string): Promise<DurablePendingQuestion | null>;
  getReceipt(ctx: Context, identity: QuestionIdentity): Promise<QuestionAnswerReceipt | null>;
  answer(ctx: Context, identity: QuestionIdentity, answers: AskUserQuestionPortResult["answers"]): Promise<QuestionAnswerReceipt>;
  cancel(ctx: Context, input: Omit<QuestionIdentity, "invocationId"> & { invocationId: string | null; reason: "cancelled" | "expired";
    proof?: Pick<QuestionExecutionOwner, "expectedFencingToken" | "leaseId"> }): Promise<boolean>;
}
interface Waiter<Context> {
  ctx: Context;
  requestFingerprint: string;
  identity: QuestionIdentity; owner: QuestionExecutionOwner; registered: boolean; ending: boolean;
  promise: Promise<AskUserQuestionPortResult>;
  resolve(result: AskUserQuestionPortResult): void; reject(error: Error): void;
  timer?: ReturnType<typeof setTimeout>; poll?: ReturnType<typeof setInterval>; detach?(): void;
  cancellation?: Error;
}

/** Process-local waiting only. All durable authority belongs to injected commands. */
export class UserQuestionWaiter<Context> {
  private readonly waiters = new Map<string, Waiter<Context>>();
  constructor(private readonly commands: UserQuestionCommands<Context>, private readonly options: {
    publish?(event: ConversationStreamEventRow): void; defaultTimeoutMs?: number;
  } = {}) {}

  createPort(ctx: Context, owner: QuestionExecutionOwner | ((request: AskUserQuestionPortRequest) => QuestionExecutionOwner | undefined)): UserQuestionPort {
    return { ask: request => {
      const proof = typeof owner === "function" ? owner(request) : owner;
      if (!request.invocationId || !proof || proof.turnId !== request.turnId || proof.attemptId !== request.attemptId) {
        return Promise.reject(new Error("QUESTION_EXECUTION_IDENTITY_REQUIRED"));
      }
      const identity = { turnId: request.turnId, attemptId: request.attemptId, invocationId: request.invocationId, step: request.step };
      const timeoutMs = request.timeoutMs ?? this.options.defaultTimeoutMs ?? 60000;
      const requestFingerprint = JSON.stringify({ questions: request.questions, timeoutMs });
      const existing = this.waiters.get(request.turnId);
      if (existing) {
        if (existing.identity.invocationId !== identity.invocationId || existing.identity.attemptId !== identity.attemptId || existing.identity.step !== identity.step) {
          return Promise.reject(new Error("QUESTION_PENDING"));
        }
        return existing.requestFingerprint === requestFingerprint ? existing.promise : Promise.reject(new Error("QUESTION_IDENTITY_CONFLICT"));
      }
      let resolve!: Waiter<Context>["resolve"], reject!: Waiter<Context>["reject"];
      const promise = new Promise<AskUserQuestionPortResult>((yes, no) => { resolve = yes; reject = no; });
      const entry: Waiter<Context> = { ctx, requestFingerprint, identity, owner: { ...proof }, registered: false, ending: false, promise, resolve, reject };
      this.waiters.set(identity.turnId, entry);
      const onAbort = () => {
        entry.cancellation = new Error("QUESTION_CANCELLED");
        if (entry.registered) void this.end(entry, "cancelled", entry.cancellation);
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      entry.detach = () => request.signal?.removeEventListener("abort", onAbort);
      if (request.signal?.aborted) onAbort();
      const snapshot = { ...request, questions: JSON.parse(JSON.stringify(request.questions)) as AskUserQuestionPortRequest["questions"], timeoutMs };
      void this.register(entry, snapshot).catch(error => this.settle(entry, undefined, error instanceof Error ? error : new Error(String(error))));
      return promise;
    } };
  }

  getPending(ctx: Context, turnId: string) { return this.commands.getPending(ctx, turnId); }
  async submit(ctx: Context, identity: QuestionIdentity, answers: AskUserQuestionPortResult["answers"]): Promise<QuestionAnswerReceipt> {
    const receipt = await this.commands.answer(ctx, identity, answers);
    try { this.options.publish?.(receipt.event); } catch { /* Receipt remains durable if delivery fails. */ }
    const entry = this.waiters.get(identity.turnId);
    if (entry && entry.identity.invocationId === identity.invocationId && entry.identity.attemptId === identity.attemptId && entry.identity.step === identity.step) {
      this.settle(entry, { answers: receipt.answers });
    }
    return receipt;
  }

  async cancel(reason = "QUESTION_CANCELLED") {
    await Promise.all([...this.waiters.values()].map(async entry => {
      entry.cancellation = new Error(reason);
      if (entry.registered) await this.end(entry, "cancelled", entry.cancellation);
      await entry.promise.catch(() => undefined);
    }));
  }

  private async register(entry: Waiter<Context>, request: AskUserQuestionPortRequest) {
    if (entry.cancellation) { this.settle(entry, undefined, entry.cancellation); return; }
    const required = await this.commands.require(entry.ctx, { ...entry.identity, expectedFencingToken: entry.owner.expectedFencingToken,
      leaseId: entry.owner.leaseId, questions: request.questions, timeoutMs: request.timeoutMs ?? this.options.defaultTimeoutMs ?? 60000 });
    entry.registered = true;
    if (entry.cancellation) { await this.end(entry, "cancelled", entry.cancellation); return; }
    if (required.receipt) { this.settle(entry, { answers: required.receipt.answers }); return; }
    if (!required.pending) throw new Error("QUESTION_CLOSED");
    try { this.options.publish?.(required.event); } catch { /* Consumers can replay the committed event. */ }
    entry.timer = setTimeout(() => { void this.end(entry, "expired", new Error("QUESTION_TIMEOUT")); }, Math.max(0, Date.parse(required.pending.expiresAt) - Date.now()));
    let polling = false;
    const poll = async () => {
      if (polling || entry.ending || this.waiters.get(entry.identity.turnId) !== entry) return;
      polling = true;
      try {
        const receipt = await this.commands.getReceipt(entry.ctx, entry.identity);
        if (receipt) { this.settle(entry, { answers: receipt.answers }); return; }
        const current = await this.commands.getPending(entry.ctx, entry.identity.turnId);
        if (!current || current.invocationId !== entry.identity.invocationId || current.attemptId !== entry.identity.attemptId || current.step !== entry.identity.step) {
          // An answer can commit between the first receipt read and pending read.
          const committed = await this.commands.getReceipt(entry.ctx, entry.identity);
          this.settle(entry, committed ? { answers: committed.answers } : undefined,
            committed ? undefined : new Error("QUESTION_CLOSED"));
        }
      } catch (error) { this.settle(entry, undefined, error instanceof Error ? error : new Error(String(error))); }
      finally { polling = false; }
    };
    entry.poll = setInterval(() => { void poll(); }, 100);
    await poll();
  }

  private async end(entry: Waiter<Context>, reason: "cancelled" | "expired", error: Error) {
    if (entry.ending || this.waiters.get(entry.identity.turnId) !== entry) return;
    entry.ending = true;
    try {
      const removed = await this.commands.cancel(entry.ctx, { ...entry.identity, reason,
        proof: { expectedFencingToken: entry.owner.expectedFencingToken, leaseId: entry.owner.leaseId } });
      const receipt = removed ? null : await this.commands.getReceipt(entry.ctx, entry.identity);
      this.settle(entry, receipt ? { answers: receipt.answers } : undefined, receipt ? undefined : error);
    } catch (failure) { this.settle(entry, undefined, failure instanceof Error ? failure : new Error(String(failure))); }
  }

  private settle(entry: Waiter<Context>, result?: AskUserQuestionPortResult, error?: Error) {
    if (this.waiters.get(entry.identity.turnId) !== entry) return;
    this.waiters.delete(entry.identity.turnId);
    clearTimeout(entry.timer); clearInterval(entry.poll); entry.detach?.();
    if (result) entry.resolve(result); else entry.reject(error ?? new Error("QUESTION_CLOSED"));
  }
}
