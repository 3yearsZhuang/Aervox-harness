/**
 * Aervox｜思隅 @aervox/api — 学习规划集成测试（CAP-017 重构：OpenMAIC 单次结构化生成）
 *
 * 覆盖：
 * - 生成核心：JSON 提取 / 结构校验 / hydrate / 带 gaps 定向重试 / 模板降级
 * - 路由：generate → list → get → patch 任务勾选（里程碑推进）→ archive
 * - 租户隔离与入参校验
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInMemoryDatabase,
  initDatabaseSchema,
  SqliteLearningRepository,
  type AervoxDatabase,
  type TenantContext,
} from "@aervox/database";
import { buildApp } from "../src/app.js";
import {
  LearningPlanGenerationService,
  extractJsonObject,
  validatePlanOutput,
  hydratePlan,
  renderTemplatePlan,
  type PlanModelPort,
} from "../src/modules/learning/plan-generation.js";
import type { FastifyInstance } from "fastify";
import type { Client } from "@libsql/client";

const headers = {
  "x-workspace-id": "ws_plan_it",
  "x-user-id": "usr_plan_it",
} as const;

const otherHeaders = {
  "x-workspace-id": "ws_other",
  "x-user-id": "usr_other",
} as const;

const tenant: TenantContext = { workspaceId: "ws_plan_it", subjectUserId: "usr_plan_it" };

/** 一份可通过结构校验的最小合法规划输出 */
const validPlanOutput = {
  title: "Vue 番茄钟项目学习",
  description: "通过实现一个番茄钟应用掌握 Vue 组件化开发。",
  learningObjective: "独立完成一个 Vue 小应用",
  gains: ["组件化思维", "状态管理基础", "调试排错能力"],
  milestones: [
    {
      title: "阶段一：认识与准备",
      description: "了解 Vue 核心概念。",
      briefing: "先弄清楚要学什么。",
      completionCriteria: "能说清组件与响应式。",
      debrief: "回顾模糊概念。",
      tasks: [
        { title: "调研 Vue 核心概念", description: "整理概念清单", hints: ["看官方入门指南"] },
        { title: "搭建开发环境", description: "安装工具", hints: [] },
      ],
    },
    {
      title: "阶段二：整合收尾",
      description: "串联所学产出成果。",
      briefing: "整合为完整作品。",
      completionCriteria: "产出可运行番茄钟。",
      debrief: "总结收获。",
      tasks: [
        { title: "整合完整成果", description: "完成番茄钟", hints: [] },
        { title: "自评与下一步", description: "对照 gains 自评", hints: [] },
      ],
    },
  ],
};

// ============ 纯函数：解析 / 校验 / hydrate ============

describe("规划生成纯函数", () => {
  it("extractJsonObject：剥离代码围栏并截取平衡对象", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJsonObject('前置说明 {"a":{"b":2}} 后置说明')).toEqual({ a: { b: 2 } });
    expect(extractJsonObject('{"a":"含}花括号的字符串"}')).toEqual({ a: "含}花括号的字符串" });
    expect(extractJsonObject("不是 JSON")).toBeNull();
    expect(extractJsonObject("{truncated")).toBeNull();
  });

  it("validatePlanOutput：合法输出无 gaps，缺字段逐项报出", () => {
    expect(validatePlanOutput(validPlanOutput)).toEqual([]);
    const gaps = validatePlanOutput({ ...validPlanOutput, title: " ", milestones: [{ title: "孤立里程碑", tasks: [] }] });
    expect(gaps).toContain("title 为空");
    expect(gaps.some((gap) => gap.includes("必须是 2-6 个"))).toBe(true);
    expect(gaps.some((gap) => gap.includes("任务数量必须是 2-4 个"))).toBe(true);
  });

  it("hydratePlan：分配 id 与 order，首个里程碑 active 其余 locked，任务 todo", () => {
    const hydrated = hydratePlan(validPlanOutput, { topic: "Vue", level: "beginner", dailyMinutes: 25 });
    expect(hydrated.id).toBeTruthy();
    expect(hydrated.topic).toBe("Vue");
    expect(hydrated.dailyAvailableMinutes).toBe(25);
    expect(hydrated.milestones).toHaveLength(2);
    hydrated.milestones.forEach((m, i) => {
      expect(m.id).toBeTruthy();
      expect(m.title).toBe(validPlanOutput.milestones[i].title);
      m.tasks.forEach((t) => expect(t.id).toBeTruthy());
    });
  });

  it("renderTemplatePlan：模板满足结构校验（非 LLM 模式诚实降级）", () => {
    expect(validatePlanOutput(renderTemplatePlan({ topic: "任意主题", level: "beginner", dailyMinutes: 25 }))).toEqual([]);
  });
});

// ============ 生成服务（注入 fake PlanModelPort） ============

describe("LearningPlanGenerationService", () => {
  let db: AervoxDatabase;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "llm";
    const res = await createInMemoryDatabase();
    await initDatabaseSchema(res.client);
    db = res.db;
    cleanup = res.cleanup;
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await cleanup();
  });

  function makeService(rawOutputs: string[]) {
    const calls: string[] = [];
    const model: PlanModelPort = {
      async generate({ user }) {
        calls.push(user);
        const raw = rawOutputs[Math.min(calls.length - 1, rawOutputs.length - 1)];
        if (raw instanceof Error) throw raw;
        return raw;
      },
    };
    const learningRepo = new SqliteLearningRepository(db);
    const service = new LearningPlanGenerationService({ db, learningRepo, model });
    return { service, calls };
  }

  it("首次输出合法：直接落库，generatedBy=llm", async () => {
    const { service, calls } = makeService([JSON.stringify(validPlanOutput)]);
    const { plan, generatedBy } = await service.generate(tenant, { topic: "Vue 番茄钟" });

    expect(generatedBy).toBe("llm");
    expect(calls).toHaveLength(1);
    expect(plan.title).toBe("Vue 番茄钟项目学习");
    expect(plan.milestones).toHaveLength(2);
    expect(plan.milestones[0].status).toBe("active");
    expect(plan.milestones[1].status).toBe("locked");
  });

  it("首次输出带围栏/缺字段：带 gaps 定向重试一次后成功", async () => {
    const broken = { ...validPlanOutput, gains: ["只有一条"] };
    const { service, calls } = makeService([
      `说明文字\n\`\`\`json\n${JSON.stringify(broken)}\n\`\`\``,
      JSON.stringify(validPlanOutput),
    ]);
    const { plan, generatedBy } = await service.generate(tenant, { topic: "Vue 番茄钟" });

    expect(generatedBy).toBe("llm");
    expect(calls).toHaveLength(2);
    // 重试提示词包含具体 gaps
    expect(calls[1]).toContain("gains 必须是 3-5 条非空的能力收获");
    expect(plan.gains).toHaveLength(3);
  });

  it("重试后仍不合法：抛 plan_generation_failed", async () => {
    const { service, calls } = makeService(["完全不是 JSON", "还是不是 JSON"]);
    await expect(service.generate(tenant, { topic: "Vue" })).rejects.toThrow(/plan_generation_failed/);
    expect(calls).toHaveLength(2);
  });

  it("非 LLM 模式：模板降级，generatedBy=template", async () => {
    process.env.AERVOX_LOOP_PROVIDER = "replay";
    const { service, calls } = makeService([]);
    const { plan, generatedBy } = await service.generate(tenant, { topic: "番茄钟" });

    expect(generatedBy).toBe("template");
    expect(calls).toHaveLength(0);
    expect(plan.milestones).toHaveLength(3);
    expect(plan.milestones.every((m) => m.tasks.length === 2)).toBe(true);
  });
});

// ============ 路由集成（template 模式，确定性输出） ============

describe("学习规划路由（/v1/learning-plans）", () => {
  let app: FastifyInstance;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    process.env.AERVOX_LOOP_PROVIDER = "replay";
    const res = await createInMemoryDatabase();
    cleanup = res.cleanup;
    const built = await buildApp({ db: res.db, client: res.client });
    app = built.app;
    await app.ready();
  });

  afterEach(async () => {
    delete process.env.AERVOX_LOOP_PROVIDER;
    await app.close();
    await cleanup();
  });

  it("generate：生成规划并落库（201，含里程碑+任务路线图）", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/learning-plans/generate",
      headers,
      payload: { topic: "用 Vue 写番茄钟", level: "beginner", dailyMinutes: 25 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.generatedBy).toBe("template");
    expect(body.id).toBeTruthy();
    expect(body.topic).toBe("用 Vue 写番茄钟");
    expect(body.status).toBe("active");
    expect(body.milestones.length).toBeGreaterThanOrEqual(2);
    expect(body.milestones[0].status).toBe("active");
    expect(body.milestones.slice(1).every((m: { status: string }) => m.status === "locked")).toBe(true);
    expect(body.milestones[0].tasks.length).toBeGreaterThanOrEqual(2);
  });

  it("generate：topic 为空返回 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/learning-plans/generate",
      headers,
      payload: { topic: "  " },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Validation failed");
  });

  it("list / get：查询生成的规划", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/learning-plans/generate",
      headers,
      payload: { topic: "SQL 入门" },
    });
    const planId = created.json().id;

    const listRes = await app.inject({ method: "GET", url: "/v1/learning-plans", headers });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items).toHaveLength(1);
    expect(listRes.json().items[0].id).toBe(planId);

    const getRes = await app.inject({ method: "GET", url: `/v1/learning-plans/${planId}`, headers });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().topic).toBe("SQL 入门");
  });

  it("patch 任务勾选：里程碑完成后自动解锁下一阶段", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/learning-plans/generate",
      headers,
      payload: { topic: "Rust 基础" },
    });
    const plan = created.json();
    const firstMilestone = plan.milestones[0];
    const secondMilestone = plan.milestones[1];

    // 勾选首个里程碑的全部任务
    for (const task of firstMilestone.tasks) {
      const patchRes = await app.inject({
        method: "PATCH",
        url: `/v1/plan-tasks/${task.id}`,
        headers,
        payload: { status: "done" },
      });
      expect(patchRes.statusCode).toBe(200);
    }

    const updated = await app.inject({
      method: "GET",
      url: `/v1/learning-plans/${plan.id}`,
      headers,
    });
    const milestones = updated.json().milestones;
    expect(milestones[0].status).toBe("completed");
    expect(milestones[0].tasks.every((t: { status: string }) => t.status === "done")).toBe(true);
    expect(milestones[1].status).toBe("active");
    expect(secondMilestone.id).toBe(milestones[1].id);
  });

  it("archive：归档后列表不可见，includeArchived 可查回", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/learning-plans/generate",
      headers,
      payload: { topic: "归档测试" },
    });
    const planId = created.json().id;

    const archiveRes = await app.inject({
      method: "POST",
      url: `/v1/learning-plans/${planId}/archive`,
      headers,
    });
    expect(archiveRes.statusCode).toBe(200);
    expect(archiveRes.json().status).toBe("archived");

    const listRes = await app.inject({ method: "GET", url: "/v1/learning-plans", headers });
    expect(listRes.json().items).toHaveLength(0);

    const withArchived = await app.inject({
      method: "GET",
      url: "/v1/learning-plans?includeArchived=true",
      headers,
    });
    expect(withArchived.json().items).toHaveLength(1);
  });

  it("租户隔离：其他工作区不可访问规划的详情、任务与归档", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/learning-plans/generate",
      headers,
      payload: { topic: "隔离测试" },
    });
    const plan = created.json();
    const taskId = plan.milestones[0].tasks[0].id;

    const otherGet = await app.inject({
      method: "GET",
      url: `/v1/learning-plans/${plan.id}`,
      headers: otherHeaders,
    });
    expect(otherGet.statusCode).toBe(404);

    const otherPatch = await app.inject({
      method: "PATCH",
      url: `/v1/plan-tasks/${taskId}`,
      headers: otherHeaders,
      payload: { status: "done" },
    });
    expect(otherPatch.statusCode).toBe(404);

    const otherArchive = await app.inject({
      method: "POST",
      url: `/v1/learning-plans/${plan.id}/archive`,
      headers: otherHeaders,
    });
    expect(otherArchive.statusCode).toBe(404);

    // 其他租户列表为空
    const otherList = await app.inject({ method: "GET", url: "/v1/learning-plans", headers: otherHeaders });
    expect(otherList.json().items).toHaveLength(0);
  });
});
