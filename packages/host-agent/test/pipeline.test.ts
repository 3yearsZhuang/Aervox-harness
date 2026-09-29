import { describe, expect, it } from "vitest";
import { ControlContext, type ExecuteResult } from "@aervox/agent-loop";
import {
  ExecutionPipeline,
  createErrorRecoveryMiddleware,
  type TurnMiddlewareContext,
} from "../src/pipeline.js";

describe("ExecutionPipeline (Host Agent Pipeline Middleware)", () => {
  function createTestContext(options?: {
    deadlineEpochMs?: number;
    tokenBudget?: { maxTokens: number; usedTokens: number };
  }): TurnMiddlewareContext {
    return {
      turnId: "turn_test_1",
      sessionId: "session_test_1",
      attemptId: "atp_test_1",
      userMessage: "hello world",
      controlContext: new ControlContext({
        turnId: "turn_test_1",
        attemptId: "atp_test_1",
        deadlineEpochMs: options?.deadlineEpochMs,
        tokenBudget: options?.tokenBudget,
      }),
      attributes: new Map(),
    };
  }

  it("should execute middlewares in onion order and return core handler result", async () => {
    const trace: string[] = [];
    const pipeline = new ExecutionPipeline();

    pipeline.use(async (ctx, next) => {
      trace.push("mw1:before");
      ctx.attributes.set("step", 1);
      const res = await next();
      trace.push("mw1:after");
      return res;
    });

    pipeline.use(async (ctx, next) => {
      trace.push(`mw2:before(attr=${ctx.attributes.get("step")})`);
      const res = await next();
      trace.push("mw2:after");
      return res;
    });

    const context = createTestContext();
    const result = await pipeline.execute(context, async (ctx) => {
      trace.push("coreHandler");
      return {
        status: "completed",
        attemptId: ctx.attemptId,
        lastSequence: 1,
        stepsTaken: 1,
      };
    });

    expect(result.status).toBe("completed");
    expect(trace).toEqual([
      "mw1:before",
      "mw2:before(attr=1)",
      "coreHandler",
      "mw2:after",
      "mw1:after",
    ]);
  });

  it("should support short-circuiting without calling coreHandler", async () => {
    const trace: string[] = [];
    const pipeline = new ExecutionPipeline();

    pipeline.use(async (ctx, _next) => {
      trace.push("mw:intercept");
      return {
        status: "completed",
        attemptId: ctx.attemptId,
        lastSequence: 0,
        stepsTaken: 0,
      };
    });

    const context = createTestContext();
    const result = await pipeline.execute(context, async () => {
      trace.push("coreHandler_should_not_run");
      return { status: "failed", attemptId: "atp", reason: "error" };
    });

    expect(result.status).toBe("completed");
    expect(trace).toEqual(["mw:intercept"]);
  });

  it("should safely handle errors via createErrorRecoveryMiddleware", async () => {
    const pipeline = new ExecutionPipeline();
    pipeline.use(createErrorRecoveryMiddleware());
    pipeline.use(async () => {
      throw new Error("simulated_provider_crash");
    });

    const context = createTestContext();
    const result = await pipeline.execute(context, async () => {
      return { status: "completed", attemptId: "atp", lastSequence: 1, stepsTaken: 1 };
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toContain("unhandled_pipeline_error: simulated_provider_crash");
    }
  });

  it("should map to deadline_exceeded when error recovery catches expired context", async () => {
    const pipeline = new ExecutionPipeline();
    pipeline.use(createErrorRecoveryMiddleware());
    pipeline.use(async () => {
      throw new Error("aborted_by_deadline");
    });

    const context = createTestContext({ deadlineEpochMs: Date.now() - 100 });
    const result = await pipeline.execute(context, async () => {
      return { status: "completed", attemptId: "atp", lastSequence: 1, stepsTaken: 1 };
    });

    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.reason).toBe("deadline_exceeded");
    }
  });
});
