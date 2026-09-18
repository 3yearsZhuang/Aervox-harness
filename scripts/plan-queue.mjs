#!/usr/bin/env node
/**
 * Aervox｜思隅 — 当前迭代队列的真源、渲染与校验。
 *
 * 分工（与治理规范 §3.1「当前迭代计划的唯一入口」一致）：
 * - `docs/_meta/plan-queue.json` 是队列的**机器真源**（条目、批次、状态、依赖、验收）；
 * - `plan.md` §2 的表格是**派生视图**，由本模块渲染，禁止手改；
 * - 校验项与强制级别来自 `document-policy.json` 的 `currentIterationPlan.queue`
 *   （当前 `enforcement: error`：结构与纪律违规阻断，仅依赖次序保持提示；
 *   `warning` 为观察期语义——全部按提示报告、不阻断门禁）。
 *
 * 用法：`mise tasks run plan-render`（写回）/ `mise tasks run plan-check`（只校验）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const QUEUE_PATH = path.join(ROOT_DIR, "docs", "_meta", "plan-queue.json");
export const POLICY_PATH = path.join(ROOT_DIR, "docs", "_meta", "document-policy.json");
export const PLAN_PATH = path.join(ROOT_DIR, "plan.md");

const BLOCK_BEGIN_PREFIX = "<!-- plan-queue:begin";
const BLOCK_END_PREFIX = "<!-- plan-queue:end";
const BEGIN_LINE = `${BLOCK_BEGIN_PREFIX} · 本区由 \`mise tasks run plan-render\` 从 docs/_meta/plan-queue.json 生成，请勿手改 -->`;
const END_LINE = `${BLOCK_END_PREFIX} -->`;
const TABLE_HEADER = "| 条目 / 状态 | 最小交付与依据 | 依赖及 CR 门槛 | 完成判定 | 建议责任（待认领） |";

const DEFAULT_POLICY = { source: "docs/_meta/plan-queue.json", target: "plan.md", wipLimit: 3, enforcement: "warning" };

export function loadQueue(queuePath = QUEUE_PATH) {
  return JSON.parse(fs.readFileSync(queuePath, "utf8"));
}

/** 读取队列策略（真源路径、在制上限、强制级别），缺失时回退到观察期默认值。 */
export function loadQueuePolicy(policyPath = POLICY_PATH) {
  const policy = JSON.parse(fs.readFileSync(policyPath, "utf8"));
  return { ...DEFAULT_POLICY, ...(policy.currentIterationPlan?.queue ?? {}) };
}

function renderResponsibility(item) {
  const detail = [];
  if (item.branch) detail.push(`分支 \`${item.branch}\``);
  if (item.statusNote) detail.push(item.statusNote);
  return item.owner + (detail.length > 0 ? `（${detail.join("；")}）` : "");
}

function renderAcceptance(item) {
  const text = item.acceptance.join("；");
  return item.checks && item.checks.length > 0 ? `${text}（校验：${item.checks.join("；")}）` : text;
}

export function renderItemRow(item) {
  return [
    `| <a id="${item.id.toLowerCase()}"></a>${item.id} · ${item.status}`,
    item.delivery,
    item.gate,
    renderAcceptance(item),
    renderResponsibility(item),
  ].join(" | ") + " |";
}

/** 渲染整个生成区（含 begin/end 标记行），供写回与比对使用。 */
export function renderQueueRegion(queue) {
  const lines = [BEGIN_LINE];
  for (const batch of queue.batches) {
    lines.push("", `### ${batch.title}`, "", TABLE_HEADER, "|---|---|---|---|---|");
    for (const item of queue.items.filter((entry) => entry.batch === batch.id)) {
      lines.push(renderItemRow(item));
    }
  }
  lines.push("", END_LINE);
  return `${lines.join("\n")}\n`;
}

/** 从 plan.md 中切出生成区（含标记行）；缺少标记时返回 null。 */
export function extractQueueRegion(markdown) {
  const lines = markdown.split("\n");
  const begin = lines.findIndex((line) => line.startsWith(BLOCK_BEGIN_PREFIX));
  const end = lines.findIndex((line) => line.startsWith(BLOCK_END_PREFIX));
  if (begin < 0 || end < 0 || end < begin) return null;
  return { begin, end, text: `${lines.slice(begin, end + 1).join("\n")}\n` };
}

/** 用渲染结果替换生成区，保留其余手写内容。 */
export function applyQueueRegion(markdown, region) {
  const current = extractQueueRegion(markdown);
  if (!current) throw new Error("plan.md 缺少 plan-queue 生成区标记，无法写回");
  const lines = markdown.split("\n");
  return [...lines.slice(0, current.begin), ...region.trimEnd().split("\n"), ...lines.slice(current.end + 1)].join("\n");
}

function findCycles(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const cycles = [];
  const visiting = new Set();
  const done = new Set();

  function walk(id, trail) {
    if (done.has(id) || !byId.has(id)) return;
    if (visiting.has(id)) {
      cycles.push([...trail.slice(trail.indexOf(id)), id].join(" → "));
      return;
    }
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn ?? []) walk(dependency, [...trail, id]);
    visiting.delete(id);
    done.add(id);
  }

  for (const item of items) walk(item.id, []);
  return cycles;
}

/**
 * 升级为 `error` 后仍保持提示的规则：依赖次序允许"可并行的前置设计与测试夹具"
 * （`plan.md` §2 明确保留这一并行空间），是否放行需人工判断，不适合机械阻断。
 * 其余规则（H1–H6 结构性 + S1 在制并发、S2 执行中缺分支、S3 已移交缺证据、
 * S4 暂停缺阻碍）在 `error` 级别下一律阻断。
 */
const ADVISORY_RULES = new Set(["S5"]);

/**
 * 队列结构与纪律校验。
 *
 * H1–H6 是"真源自身不合法"，S1–S5 是计划纪律（在制并发、分支、证据、阻碍、依赖次序）。
 * 强制级别由策略控制：`warning`（观察期）全部提示不阻断；`error` 时除 ADVISORY_RULES
 * 之外的规则都阻断。
 */
export function validateQueue(queue, { wipLimit = DEFAULT_POLICY.wipLimit, enforcement = DEFAULT_POLICY.enforcement } = {}) {
  const findings = [];
  const severityFor = (rule) => (enforcement === "error" && !ADVISORY_RULES.has(rule) ? "error" : "warning");
  const report = (rule, message) => findings.push({ severity: severityFor(rule), rule, message });

  const statuses = new Set(queue.statuses ?? []);
  const batchIds = new Set((queue.batches ?? []).map((batch) => batch.id));
  const seenIds = new Set();

  for (const item of queue.items ?? []) {
    if (!/^ITER-\d{3}$/.test(item.id)) report("H1", `${item.id}: 编号必须为 ITER-<三位数字>`);
    if (seenIds.has(item.id)) report("H1", `${item.id}: 编号重复`);
    seenIds.add(item.id);

    if (!statuses.has(item.status)) {
      report("H2", `${item.id}: 状态「${item.status}」不在枚举 ${[...statuses].join("/")} 内`);
    }
    if (!batchIds.has(item.batch)) report("H2", `${item.id}: 批次「${item.batch}」未在 batches 中声明`);
    if (!Array.isArray(item.acceptance) || item.acceptance.length === 0) {
      report("H5", `${item.id}: 缺少完成判定（acceptance 不能为空）`);
    }
    for (const dependency of item.dependsOn ?? []) {
      if (dependency === item.id) report("H3", `${item.id}: 依赖自身`);
      else if (!(queue.items ?? []).some((entry) => entry.id === dependency)) {
        report("H3", `${item.id}: 依赖的 ${dependency} 不存在`);
      }
    }
    if (!item.owner) report("S0", `${item.id}: 缺少建议责任`);
  }

  for (const cycle of findCycles(queue.items ?? [])) report("H4", `依赖成环：${cycle}`);

  const wip = (queue.items ?? []).filter((item) => item.status === "执行中");
  if (wip.length > wipLimit) {
    report("S1", `在制条目 ${wip.length} 个，超过上限 ${wipLimit}：${wip.map((item) => item.id).join("、")}`);
  }
  for (const item of wip) {
    if (!item.branch) report("S2", `${item.id}: 状态为执行中但未标注分支`);
  }
  for (const item of queue.items ?? []) {
    if (item.status === "已移交" && (!item.links || item.links.length === 0)) {
      report("S3", `${item.id}: 状态为已移交但未给出 §4.2/PR 证据链接`);
    }
    if (item.status === "暂停" && !item.blocker) report("S4", `${item.id}: 状态为暂停但未写明阻碍`);
    if (item.status === "执行中" || item.status === "已移交") {
      const pending = (item.dependsOn ?? []).filter((id) => {
        const dependency = (queue.items ?? []).find((entry) => entry.id === id);
        return dependency && dependency.status !== "已移交";
      });
      if (pending.length > 0) {
        report("S5", `${item.id}: 已进入 ${item.status}，但依赖 ${pending.join("、")} 尚未移交（确认是否属可并行的前置设计/夹具）`);
      }
    }
  }

  return findings;
}

/** 生成区与真源的一致性校验（渲染即校验）。 */
export function checkQueueSync(queue, planMarkdown, enforcement = DEFAULT_POLICY.enforcement) {
  const current = extractQueueRegion(planMarkdown);
  if (!current) {
    return [{ severity: enforcement === "error" ? "error" : "warning", rule: "H6", message: "plan.md 缺少 plan-queue 生成区标记" }];
  }
  const expected = renderQueueRegion(queue);
  if (current.text === expected) return [];

  const currentLines = current.text.trimEnd().split("\n");
  const expectedLines = expected.trimEnd().split("\n");
  const firstDiff = currentLines.findIndex((line, index) => line !== expectedLines[index]);
  return [
    {
      severity: enforcement === "error" ? "error" : "warning",
      rule: "H6",
      message: `plan.md §2 生成区与 docs/_meta/plan-queue.json 不一致（首个差异在第 ${firstDiff + 1} 行）；运行 \`mise tasks run plan-render\` 同步`,
    },
  ];
}

function formatFindings(findings) {
  return findings.map((finding) => `  - [${finding.rule}] ${finding.message}`).join("\n");
}

function main() {
  const render = process.argv.includes("--render");
  const queue = loadQueue();
  const policy = loadQueuePolicy();
  const targetPath = path.resolve(ROOT_DIR, policy.target);

  if (render) {
    const plan = fs.readFileSync(targetPath, "utf8");
    const updated = applyQueueRegion(plan, renderQueueRegion(queue));
    const changed = updated !== plan;
    if (changed) fs.writeFileSync(targetPath, updated, "utf8");
    console.log(`[plan-queue] ${changed ? "已更新" : "无需变更"} ${policy.target}（真源 ${policy.source}）`);
  }

  const findings = [
    ...validateQueue(queue, { wipLimit: policy.wipLimit, enforcement: policy.enforcement }),
    ...checkQueueSync(queue, fs.readFileSync(targetPath, "utf8"), policy.enforcement),
  ];

  const errors = findings.filter((finding) => finding.severity === "error");
  const warnings = findings.filter((finding) => finding.severity === "warning");

  if (findings.length === 0) {
    console.log(`[plan-queue] 队列校验通过（${queue.items.length} 个条目，在制 ${queue.items.filter((item) => item.status === "执行中").length}/${policy.wipLimit}，强制级别 ${policy.enforcement}）`);
    return;
  }

  console.log(`[plan-queue] 发现 ${warnings.length} 条提示、${errors.length} 条错误（强制级别 ${policy.enforcement}）：`);
  console.log(formatFindings(findings));
  if (errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
