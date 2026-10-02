/**
 * Aervox｜思隅 宿主领域纯净性守卫（Host Domain Purity Ratchet）
 *
 * 机器事实源：CR-060「专注模式宿主去领域化与插件实现内聚」与
 * AVX-PLUG-001 §0.3 契约冻结。
 *
 * 规则：
 * 1. 宿主根目录（HOST_ROOTS）内不得出现插件领域标识：插件 id、领域驼峰标识、
 *    中文领域文案、插件专属协议字段、插件配置键、插件专属样式类。
 * 2. 领域实现的唯一合法落点是 plugins/<id>/（本守卫不扫描该目录）。
 * 3. 迁移期豁免集中在 scripts/host-domain-purity-exceptions.json，逐条登记
 *    owner 与 removeWhen；**豁免项一旦不再命中即判定过期并失败**，
 *    以此形成只减不增的棘轮，避免"清单长存"。
 *
 * 范围外（不在本守卫职责内，理由见 CR-060 §3）：
 *   packages/schema、packages/repositories —— CAP-003/004/006 学习事实真源。
 *
 * 用法：
 *   node scripts/check-host-domain-purity.mjs            # 全量检查，违规退出码 1
 *   node scripts/check-host-domain-purity.mjs --list     # 打印规则清单
 */

import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 必须保持领域纯净的宿主根目录。
 * `packages/host-plugin-api` 为 CR-060 新增的宿主扩展契约包（缺失时静默跳过）。
 */
export const HOST_ROOTS = [
  "apps/api/src",
  "apps/worker/src",
  "apps/web/src",
  "apps/desktop/src",
  "apps/cli/src",
  "packages/ui/src",
  "packages/api-client/src",
  "packages/contracts/src",
  "packages/core/src",
  "packages/agent-loop/src",
  "packages/host-plugin-api/src",
  "packages/practice-review/src",
];

/**
 * 领域标识规则。每条规则是 CR-060 的一条可机器验证的不变量。
 * 注意：`study` 单独出现属通用英文词（如学习资料模块 study-materials），
 * 故只覆盖带 mode/插件语义的组合形态，避免误伤 CAP-003/004/006 学习资料。
 */
export const DOMAIN_PATTERNS = [
  {
    id: "plugin-id",
    label: "插件 id 字面量",
    pattern: /\bfocus-mode\b|\bstudy-mode\b|\bquiz-mode\b/,
  },
  {
    id: "camel-ident",
    label: "领域驼峰标识",
    pattern: /\b[Ff]ocusMode[A-Za-z]*|\b[Ss]tudyMode[A-Za-z]*|\b[Qq]uizMode[A-Za-z]*|\b[Ff]ocusStudyCard[A-Za-z]*/,
  },
  {
    id: "domain-copy",
    label: "中文领域文案",
    pattern: /专注模式|陪学讲解|刷题|苏格拉底/,
  },
  {
    id: "term-pipeline",
    label: "术语抽取管线",
    pattern: /\bterms_extracted\b|\bTermsExtracted[A-Za-z]*|\bextractTerms\b|\bcurrentExtractedTerms\b|\bextractFocusTerms\b|\bextractStudyTerms\b|\bTermExplore[A-Za-z]*|\bexploreTerm\b|\bselectedTerm\b/,
  },
  {
    id: "quiz-protocol",
    label: "刷题私有协议标志",
    pattern: /\ballowQuizTrigger\b|\bquizActive\b|\bisQuizTriggered\b|\bisQuizModeMessage\b|\bQUIZ_TRIGGER_KEYWORDS\b|\bQUIZ_MODE_SYSTEM_PROMPT\b|\bisFocusModeMessage\b|\bisStudyModeMessage\b|\bFOCUS_MODE_SYSTEM_PROMPT\b|\bSTUDY_MODE_SYSTEM_PROMPT\b|\bbuildFocusModePrompt\b|\bbuildStudyModePrompt\b/,
  },
  {
    id: "practice-tool",
    label: "刷题落库工具与端口",
    pattern: /\brecord_practice_attempt\b|\bRECORD_PRACTICE_ATTEMPT[A-Za-z]*|\bPracticeAttemptPort[A-Za-z]*|\bcreatePracticeAttemptTool[A-Za-z]*/,
  },
  {
    id: "focus-config",
    label: "插件配置键",
    pattern: /\bautoEnableFocusMode\b|\bautoEnableStudyMode\b|\bstrictAntiSpoiler\b|\bscaffoldingSteps\b|\bmaxExtractedTerms\b|\benableJudgePass\b|\bdefaultExploreKind\b|\bDEFAULT_FOCUS_MODE_CONFIG\b|\bDEFAULT_STUDY_MODE_CONFIG\b|\bparseFocusConfig\b|\bparseStudyConfig\b|\bloadFocusModeRuntimeConfig\b|\bloadStudyModeRuntimeConfig\b/,
  },
  {
    id: "study-surface",
    label: "学习闭环界面与工具入口",
    // 注：不含 `learningPlans` —— 它属宿主 CAP-017 学习规划（本提案明确保留主仓），
    // 把它当作插件领域标识会误伤宿主自身能力。
    pattern: /\bapplyStudyCardLayout\b|\brestoreStudyCardLayout\b|\blearningNavItems\b|\bactiveLearningView\b|\blearningOpen\b|\bLearningDrawer\b|\bFocusTermsBar\b|\bTermsBar\b/,
  },
  {
    id: "domain-css",
    label: "插件专属样式类",
    pattern: /\.study-|floating-study-switch|composer-mode-chip|message-terms-bar|terms-chips-list|term-chip/,
  },
  {
    id: "study-tool-id",
    label: "学习工具 / 卡片 id 字面量",
    pattern: /['"]study['"]\s*\|\s*['"]mistake['"]|['"]study['"]\s*,\s*['"]timer['"]/,
  },
];

export const SOURCE_EXT_RE = /\.(ts|tsx|js|mjs|cjs|vue|css)$/;
export const IGNORE_DIR_RE = /(^|\/)(node_modules|dist|out|reference|\.git)(\/|$)/;
export const EXCEPTIONS_URL = new URL("./host-domain-purity-exceptions.json", import.meta.url);

/**
 * 装配点白名单：组合根必须按 id 引用具体插件，这是**设计允许**的宿主唯一引用位置
 * （AVX-PLUG-001 §4.1「Hook 必须由 API 组合根 import 并注册」）。
 * 仅豁免 `plugin-id` 一条规则：装配文件仍不得出现领域驼峰、插件配置键、专属样式等。
 * 插件的**可达性**由 `check-removable-implementation` 的 allowedAssemblyFiles 另行约束。
 */
export const ASSEMBLY_FILES = new Set([
  "apps/api/src/plugin-assembly.ts",
  "apps/web/src/App.vue",
  "apps/desktop/src/renderer/src/App.vue",
]);

/** 装配点仅放行 plugin-id 规则 */
export function isAssemblyAllowedRule(relFile, ruleId) {
  return ruleId === "plugin-id" && ASSEMBLY_FILES.has(relFile);
}

/** 读取迁移期豁免清单；文件缺失视为空清单（fail-closed：不豁免任何违规） */
export function loadExceptions(url = EXCEPTIONS_URL) {
  if (!existsSync(url)) return [];
  const parsed = JSON.parse(readFileSync(url, "utf8"));
  return Array.isArray(parsed) ? parsed : [];
}

/** 遍历宿主根目录，返回源码文件相对路径（含 .css，跳过迁移期插件自有目录） */
export function collectHostFiles(roots = HOST_ROOTS) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      const rel = relative(process.cwd(), full).split(sep).join("/");
      if (stat.isDirectory()) {
        if (!IGNORE_DIR_RE.test(rel)) walk(full);
      } else if (SOURCE_EXT_RE.test(rel)) {
        out.push(rel);
      }
    }
  };
  for (const dir of roots) {
    if (statSync(dir, { throwIfNoEntry: false })) walk(dir);
  }
  return out.sort();
}

/** 逐行扫描单个文件，返回领域命中 [{ file, rule, label, line, text }] */
export function inspectHostFile(relFile, source) {
  const hits = [];
  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index];
    for (const rule of DOMAIN_PATTERNS) {
      if (rule.pattern.test(text)) {
        hits.push({
          file: relFile,
          rule: rule.id,
          label: rule.label,
          line: index + 1,
          text: text.trim().slice(0, 160),
        });
      }
    }
  }
  return hits;
}

const exceptionKey = (file, rule) => `${file}::${rule}`;

/**
 * 纯函数核心：对给定 [{ file, source }] 求值与豁免清单比对。
 * 抽离自 runHostPurityCheck 以便单测覆盖棘轮三种失败模式。
 */
export function evaluateHostPurity(entries, exceptions = []) {
  const allowed = new Map(exceptions.map((e) => [exceptionKey(e.file, e.pattern), e]));
  const counts = new Map();
  const samples = new Map();
  const violations = [];
  let hitCount = 0;

  for (const { file, source } of entries) {
    for (const hit of inspectHostFile(file, source)) {
      if (isAssemblyAllowedRule(hit.file, hit.rule)) continue;
      hitCount += 1;
      const key = exceptionKey(hit.file, hit.rule);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!samples.has(key)) samples.set(key, hit);
    }
  }

  const grown = [];
  const reducible = [];
  for (const [key, actual] of counts) {
    const entry = allowed.get(key);
    if (!entry) {
      violations.push(samples.get(key));
      continue;
    }
    const expected = typeof entry.count === "number" ? entry.count : 0;
    if (actual > expected) grown.push({ ...samples.get(key), expected, actual });
    else if (actual < expected) reducible.push({ ...entry, actual });
  }
  for (const entry of exceptions) {
    if (!counts.has(exceptionKey(entry.file, entry.pattern))) {
      reducible.push({ ...entry, actual: 0 });
    }
  }

  return {
    valid: violations.length === 0 && grown.length === 0 && reducible.length === 0,
    violations,
    grown,
    reducible,
    hitCount,
    filesScanned: entries.length,
  };
}

/**
 * 全量校验。返回 evaluateHostPurity 的结果。
 *
 * 豁免以「文件 × 规则 × 命中数」为粒度：仅按文件豁免会让已豁免文件静默新增同类命中，
 * 故命中数必须与登记值**精确相等**——
 *   - 多于登记值：`grown`，视为新增违规（阻断）；
 *   - 少于登记值：`reducible`，视为棘轮可收紧（阻断，要求同步下调或删除条目）。
 * 这样既不受行号漂移影响，又保证清单只减不增。
 */
export function runHostPurityCheck({ roots = HOST_ROOTS, exceptions = loadExceptions(), files = null } = {}) {
  const list = files ?? collectHostFiles(roots);
  const entries = [];
  for (const relFile of list) {
    try {
      entries.push({ file: relFile, source: readFileSync(relFile, "utf8") });
    } catch {
      // 不可读文件跳过（与既有守卫一致）
    }
  }
  return evaluateHostPurity(entries, exceptions);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--list")) {
    console.log("CR-060 宿主领域纯净性规则清单：");
    for (const rule of DOMAIN_PATTERNS) {
      console.log(`  [${rule.id}] ${rule.label} — ${rule.pattern}`);
    }
    console.log(`\n扫描根目录（${HOST_ROOTS.length}）：`);
    for (const root of HOST_ROOTS) console.log(`  ${root}`);
    process.exit(0);
  }

  if (process.argv.includes("--init")) {
    const files = collectHostFiles();
    const byKey = new Map();
    for (const relFile of files) {
      let source = "";
      try {
        source = readFileSync(relFile, "utf8");
      } catch {
        continue;
      }
      for (const hit of inspectHostFile(relFile, source)) {
        if (isAssemblyAllowedRule(hit.file, hit.rule)) continue;
        const key = exceptionKey(hit.file, hit.rule);
        const existing = byKey.get(key);
        if (existing) {
          existing.count += 1;
        } else {
          byKey.set(key, {
            file: hit.file,
            pattern: hit.rule,
            count: 1,
            owner: "platform/ecosystem",
            removeWhen: `CR-060 实施切片完成后随实现迁入 plugins/focus-mode 一并移除（${hit.label}）`,
          });
        }
      }
    }
    const next = [...byKey.values()].sort((a, b) =>
      a.file === b.file ? a.pattern.localeCompare(b.pattern) : a.file.localeCompare(b.file),
    );
    writeFileSync(EXCEPTIONS_URL, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`[host-domain-purity] 已写入 ${next.length} 条豁免至 scripts/host-domain-purity-exceptions.json`);
    process.exit(0);
  }

  const result = runHostPurityCheck();
  if (!result.valid) {
    if (result.violations.length > 0) {
      console.error(`❌ 宿主领域纯净性违规 ${result.violations.length} 处（CR-060 / AVX-PLUG-001 §0.3）：`);
      for (const v of result.violations) {
        console.error(`   ${v.file}:${v.line}: [${v.rule}] ${v.label} — ${v.text}`);
      }
    }
    if (result.grown.length > 0) {
      console.error(`❌ 已豁免文件新增同类命中 ${result.grown.length} 处（棘轮只减不增，须消除或重新评审）：`);
      for (const g of result.grown) {
        console.error(
          `   ${g.file}:${g.line}: [${g.rule}] 登记 ${g.expected} 处，实际 ${g.actual} 处 — ${g.text}`,
        );
      }
    }
    if (result.reducible.length > 0) {
      console.error(`❌ 豁免清单可收紧 ${result.reducible.length} 条（命中数已低于登记值，须同步下调或删除）：`);
      for (const s of result.reducible) {
        console.error(`   ${s.file} [${s.pattern}] 登记 ${s.count ?? 0} 处，实际 ${s.actual} 处（owner: ${s.owner}）`);
      }
    }
    process.exit(1);
  }
  console.log(
    `✔ 宿主领域纯净性检查通过：${result.filesScanned} 个文件零新增领域命中（迁移期豁免 ${loadExceptions().length} 条 / ${result.hitCount} 处命中，规则 ${DOMAIN_PATTERNS.length} 条）`,
  );
}
