/**
 * Aervox｜思隅 @aervox/core — 用户提问负载类型结构兼容测试（ADR-021 内核提纯修订）
 *
 * 内核本地声明 AskUserQuestion* 负载类型（不再 type-import @aervox/contracts）后，
 * 以编译期类型断言锁定与 @aervox/contracts zod schema 推导类型的结构兼容：
 * contracts（SSE 侧，字段经 default 收窄）可赋给内核类型（Port 契约消费方向）。
 * 任一侧字段漂移时此处编译失败，防止双源分叉。
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  AskUserQuestionAnswerItem as ContractsAnswerItem,
  AskUserQuestionIntent as ContractsIntent,
  AskUserQuestionItem as ContractsItem,
  AskUserQuestionOption as ContractsOption,
} from "@aervox/contracts";
import type {
  AskUserQuestionAnswerItem,
  AskUserQuestionIntent,
  AskUserQuestionItem,
  AskUserQuestionOption,
} from "../src/types.js";

describe("UQ-01 负载类型与 @aervox/contracts 结构兼容（单向可赋值）", () => {
  it("contracts AskUserQuestionItem 可赋给内核类型", () => {
    expectTypeOf<ContractsItem>().toExtend<AskUserQuestionItem>();
    expectTypeOf<ContractsOption>().toExtend<AskUserQuestionOption>();
    expectTypeOf<ContractsIntent>().toExtend<AskUserQuestionIntent>();
    expectTypeOf<ContractsAnswerItem>().toExtend<AskUserQuestionAnswerItem>();
  });

  it("AnswerItem 为精确同构（双向可赋值）", () => {
    expectTypeOf<AskUserQuestionAnswerItem>().toExtend<ContractsAnswerItem>();
  });

  it("数组面兼容：contracts 负载可直接进入内核 Port 契约", () => {
    expectTypeOf<ContractsItem[]>().toExtend<AskUserQuestionItem[]>();
    expectTypeOf<ContractsAnswerItem[]>().toExtend<AskUserQuestionAnswerItem[]>();
  });
});
