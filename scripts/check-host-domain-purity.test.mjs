/**
 * Aervox｜思隅 宿主领域纯净性守卫自测（node --test）
 * 运行：node --test scripts/check-host-domain-purity.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  DOMAIN_PATTERNS,
  HOST_ROOTS,
  collectHostFiles,
  evaluateHostPurity,
  inspectHostFile,
  loadExceptions,
  runHostPurityCheck,
} from "./check-host-domain-purity.mjs";

const rules = (file, source) => inspectHostFile(file, source).map((h) => h.rule);

test("规则矩阵：10 条 CR-060 不变量齐备", () => {
  assert.deepEqual(
    DOMAIN_PATTERNS.map((r) => r.id).sort(),
    [
      "camel-ident",
      "domain-copy",
      "domain-css",
      "focus-config",
      "plugin-id",
      "practice-tool",
      "quiz-protocol",
      "study-surface",
      "study-tool-id",
      "term-pipeline",
    ].sort(),
  );
});

test("插件 id 与领域驼峰命中", () => {
  assert.deepEqual(rules("packages/ui/src/a.ts", 'const id = "focus-mode";'), ["plugin-id"]);
  assert.deepEqual(rules("packages/ui/src/a.ts", 'registry.register(focusModeTurnPlugin);'), ["camel-ident"]);
  assert.deepEqual(rules("packages/ui/src/a.ts", "const studyModeEnabled = ref(false);"), ["camel-ident"]);
});

test("中文领域文案命中", () => {
  assert.deepEqual(rules("apps/api/src/a.ts", "// 进入专注模式后的刷题闭环"), ["domain-copy"]);
});

test("刷题私有协议与落库工具命中", () => {
  assert.deepEqual(rules("apps/api/src/a.ts", "allowQuizTrigger?: boolean;"), ["quiz-protocol"]);
  assert.deepEqual(rules("apps/api/src/a.ts", 'name: "record_practice_attempt",'), ["practice-tool"]);
  assert.deepEqual(rules("apps/api/src/a.ts", "port: PracticeAttemptPort;"), ["practice-tool"]);
});

test("插件配置键与专属样式类命中", () => {
  assert.deepEqual(rules("packages/ui/src/a.ts", "autoEnableFocusMode: true,"), ["focus-config"]);
  assert.deepEqual(rules("packages/ui/src/t.css", ".study-switch-track.active { opacity: 1; }"), ["domain-css"]);
  assert.deepEqual(rules("packages/ui/src/a.ts", "lookAtEl: '.floating-study-switch-wrap'"), ["domain-css"]);
});

test("学习工具 / 卡片 id 字面量命中", () => {
  assert.deepEqual(rules("packages/ui/src/a.ts", "export type ToolId = 'study' | 'mistake' | 'todo';"), ["study-tool-id"]);
  assert.deepEqual(rules("packages/ui/src/a.ts", "cardSlots.value = ['study', 'timer'];"), ["study-tool-id"]);
});

test("CR-060 §B9a：已迁入插件的样式类不得回流宿主主题", () => {
  // 这些类名随样式物理迁入 plugins/focus-mode/src/ui/styles.css，宿主侧引用数须保持 0
  for (const cls of [
    ".practice-panel",
    ".practice-guidance",
    ".mistake-tab-btn",
    ".mistake-reason-filter",
    ".goal-status",
    ".goal-item-heading",
    ".drawer-error",
    ".side-card-actions",
    ".learning-dialog",
    ".task-sub-btn",
    ".tag-active",
  ]) {
    assert.deepEqual(
      rules("packages/ui/src/theme/workbench.css", `${cls} { color: red; }`),
      ["domain-css"],
      `${cls} 回流宿主主题应被拦截`,
    );
  }

  // 宿主自身 CAP-017 学习规划的合法类名不得误伤（前缀匹配会误报）
  assert.deepEqual(rules("packages/ui/src/theme/workbench.css", ".goal-actions button { color: red; }"), []);
  assert.deepEqual(rules("packages/ui/src/theme/workbench.css", ".mistake-filters button.active { color: red; }"), []);
  assert.deepEqual(rules("packages/ui/src/theme/workbench.css", ".task-status-tag { color: red; }"), []);
});

test("不误伤 CAP-003/004/006 学习资料标识（study 单词与连字符路径）", () => {
  for (const source of [
    'import { studyMaterials } from "./study-materials.js";',
    'const studyMaterialRepository = new SqliteStudyMaterialRepository();',
    "// 学习资料与附件上传",
    'table: "study_materials"',
  ]) {
    assert.deepEqual(rules("apps/api/src/a.ts", source), [], `误伤: ${source}`);
  }
});

test("棘轮：未登记的 文件×规则 组合判定为违规", () => {
  const entries = [{ file: "packages/core/src/types.ts", source: 'const x = "focus-mode";' }];
  const result = evaluateHostPurity(entries, []);
  assert.equal(result.valid, false);
  assert.equal(result.violations.length, 1);
  assert.equal(result.violations[0].rule, "plugin-id");
});

test("棘轮：已豁免文件命中数增长判定为 grown", () => {
  const exceptions = [{ file: "packages/ui/src/a.ts", pattern: "camel-ident", count: 1, owner: "t", removeWhen: "t" }];
  const entries = [{ file: "packages/ui/src/a.ts", source: "focusModeEnabled;\nstudyModeEnabled;\n" }];
  const result = evaluateHostPurity(entries, exceptions);
  assert.equal(result.valid, false);
  assert.equal(result.violations.length, 0);
  assert.equal(result.grown.length, 1);
  assert.equal(result.grown[0].expected, 1);
  assert.equal(result.grown[0].actual, 2);
});

test("棘轮：命中数低于登记值判定为 reducible（清单必须收紧）", () => {
  const exceptions = [{ file: "packages/ui/src/a.ts", pattern: "camel-ident", count: 3, owner: "t", removeWhen: "t" }];
  const entries = [{ file: "packages/ui/src/a.ts", source: "focusModeEnabled;\n" }];
  const result = evaluateHostPurity(entries, exceptions);
  assert.equal(result.valid, false);
  assert.equal(result.reducible.length, 1);
  assert.equal(result.reducible[0].actual, 1);
});

test("棘轮：豁免条目对应命中完全消失同样判定为 reducible", () => {
  const exceptions = [{ file: "packages/ui/src/gone.ts", pattern: "plugin-id", count: 2, owner: "t", removeWhen: "t" }];
  const result = evaluateHostPurity([{ file: "packages/ui/src/a.ts", source: "const x = 1;" }], exceptions);
  assert.equal(result.valid, false);
  assert.equal(result.reducible.length, 1);
  assert.equal(result.reducible[0].actual, 0);
});

test("棘轮：登记数与实际数一致时通过", () => {
  const exceptions = [{ file: "packages/ui/src/a.ts", pattern: "plugin-id", count: 2, owner: "t", removeWhen: "t" }];
  const entries = [{ file: "packages/ui/src/a.ts", source: 'const a = "focus-mode";\nconst b = "study-mode";\n' }];
  const result = evaluateHostPurity(entries, exceptions);
  assert.equal(result.valid, true);
  assert.equal(result.hitCount, 2);
});

test(".css 纳入扫描；插件实现目录不在宿主扫描根内", () => {
  const files = collectHostFiles();
  assert.ok(files.includes("packages/ui/src/theme/workbench.css"), "应扫描宿主主题 CSS");
  assert.ok(
    !files.some((f) => f.startsWith("packages/ui/src/plugins/focus-mode/")),
    "迁移期插件自有目录不应被宿主纯净性守卫扫描",
  );
  // CR-060 S6：插件 UI 已物理迁出宿主包，迁移期前缀豁免退役；
  // 宿主包内不再存在任何插件自有目录，扫描覆盖全部宿主源码。
  assert.ok(
    !existsSync("packages/ui/src/plugins/focus-mode"),
    "插件 UI 必须已迁出宿主包（迁移期豁免不得复活）",
  );
  assert.ok(
    existsSync("plugins/focus-mode/src/ui/index.ts"),
    "插件 UI 必须位于插件包内",
  );
});

test("扫描根覆盖宿主包，且不含学习事实真源包", () => {
  assert.ok(HOST_ROOTS.includes("packages/core/src"));
  assert.ok(HOST_ROOTS.includes("packages/agent-loop/src"));
  assert.ok(HOST_ROOTS.includes("packages/contracts/src"));
  assert.ok(!HOST_ROOTS.includes("packages/schema/src"), "schema 属 CAP-003/004/006 学习事实真源，范围外");
  assert.ok(!HOST_ROOTS.includes("packages/repositories/src"), "repositories 属学习事实真源，范围外");
});

test("当前仓库状态：宿主零领域命中且豁免清单为空（CR-060 收敛终点）", () => {
  const result = runHostPurityCheck();
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.grown, []);
  assert.deepEqual(
    result.reducible,
    [],
    "豁免清单存在可收紧条目；请运行 node scripts/check-host-domain-purity.mjs --init 同步，或删除已完成迁移的条目",
  );
  assert.equal(result.hitCount, 0, "宿主仍存在领域命中，CR-060 未收敛");
  assert.deepEqual(
    loadExceptions(),
    [],
    "迁移期豁免清单必须为空：宿主领域知识应已全部落到实现侧（插件包内）",
  );
});

test("装配点白名单：仅放行 plugin-id，其余规则仍生效", () => {
  const assembly = "apps/api/src/plugin-assembly.ts";
  // 组合根按 id 引用插件是实现装配的必要行为（AVX-PLUG-001 §4.1），仅 plugin-id 放行
  const result = evaluateHostPurity(
    [{ file: assembly, source: 'const loaders = [{ pluginId: "focus-mode", load: () => import("@aervox/plugin-focus-mode/server") }];' }],
    [],
  );
  assert.equal(result.valid, true, "装配点的 plugin-id 不应判违规");

  // 装配点仍不得承载领域驼峰、中文文案、插件配置键等
  for (const [source, rule] of [
    ["const focusModeRegistration = {};", "camel-ident"],
    ["// 专注模式的装配点", "domain-copy"],
    ["const cfg = { autoEnableFocusMode: true };", "focus-config"],
  ]) {
    const r = evaluateHostPurity([{ file: assembly, source }], []);
    assert.equal(r.valid, false, `装配点不应放行 ${rule}`);
    assert.equal(r.violations[0].rule, rule);
  }

  // 非装配文件不享受该放行
  const other = evaluateHostPurity([{ file: "apps/api/src/modules/x.ts", source: 'const id = "focus-mode";' }], []);
  assert.equal(other.valid, false);
});
