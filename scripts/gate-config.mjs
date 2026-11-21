/**
 * Aervox｜思隅 — 门禁脚本的配置断言助手
 *
 * 背景：多个守卫测试需要确认"某个测试文件确实被某个门禁任务执行"。
 * 早期写法是把整条命令当作精确字符串/整串正则来匹配，例如：
 *
 *   assert.match(scripts['check:dependency-audit'],
 *     /^node --test scripts\/a.test.mjs scripts\/b.test.mjs && node scripts\/audit\.mjs$/);
 *
 * 这类断言能防止"测试被悄悄移出门禁"，但同时也把**书写顺序和空白**冻结了：
 * 新增一个补丁测试、或调换两个 `--test` 参数的顺序，断言就会失败，而门禁的
 * 实际覆盖并没有变弱。失败信息也指向"命令文本变了"，而不是"覆盖丢了"。
 *
 * 本模块改为**语义断言**：解析出命令实际调用了哪些脚本，再判断目标脚本是否
 * 在集合中。新增脚本不会误报，移出脚本仍会立即失败。
 *
 * 安全前提（重要）：语义解析只在"这段命令仍然是一条会如实传播失败的命令"时
 * 才有意义。如果门禁被改写成 `... || true`、`... | cat`、`... ; echo ok`，
 * 脚本虽仍在文本中，失败却不再阻断，等于覆盖被悄悄废除。因此本模块同时拒绝
 * 这类改写：一旦检测到它们，直接失败并说明原因，而不是安静地判为通过。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 读取根 package.json 的 scripts（默认指向本模块所在的仓库根）。 */
export function readRootScripts(root = fileURLToPath(new URL('..', import.meta.url))) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
}

/**
 * 会吞掉子命令退出码或改变失败传播的 shell 改写。
 * 命中任意一条，说明"脚本还在命令里"不等于"脚本还在门禁里"。
 */
const WEAKENING_PATTERNS = [
  { pattern: /\|\|\s*(true\b|:|exit\s+0\b)/, reason: '把失败改写为成功（|| true / || :) ' },
  { pattern: /(^|[^|])\|(?!\|)\s*(cat|tee|head|tail)\b/, reason: '经管道丢失退出码（| cat 等）' },
  { pattern: /;\s*(echo|true|:|exit\s+0)\b/, reason: '用分号忽略前段失败（; echo）' },
  { pattern: /^\s*(?!node\b|mise\b|pnpm\b|turbo\b|cd\b|npm\b|npx\b)[A-Za-z_]+\s*=/, reason: '以前置环境变量包装，绕过直接 node 调用' },
];

/**
 * 断言一段门禁命令仍然是"失败会传播"的形态。
 * 与新增/重排脚本无关，只拦截会废除门禁的改写。
 */
export function assertGateNotWeakened(assert, command, hint = '') {
  if (typeof command !== 'string' || !command) {
    assert.fail(`${hint || 'gate'} command is missing`);
  }
  for (const { pattern, reason } of WEAKENING_PATTERNS) {
    assert.ok(
      !pattern.test(command),
      `${hint || 'gate'} must not ${reason}; command was: ${command}`,
    );
  }
}

/**
 * 从一条 npm script 命令里提取所有被 `node` / `node --test` 调用的脚本路径。
 *
 * 只做本仓库实际用到的两种形态：
 *   1. `node --test a.test.mjs b.test.mjs`      → 测试集合
 *   2. `node scripts/x.mjs`                     → 执行的脚本
 *
 * 返回去重后的路径数组，顺序不参与判定。
 */
export function referencedScripts(command) {
  if (typeof command !== 'string' || !command) return [];
  const found = new Set();
  // 拆开 shell 连接符，逐段看 node 调用
  for (const segment of command.split(/\s*(?:&&|\|\||;)\s*/)) {
    const match = segment.match(/^\s*(?:mise\s+exec\s+--\s+)?node\s+(--test\s+)?(.+)$/);
    if (!match) continue;
    for (const token of match[2].trim().split(/\s+/)) {
      // 去掉可能存在的引号：`node --test "scripts/a.test.mjs"` 与不带引号等价，
      // 否则合法路径会被误判为缺失。
      const cleaned = token.replace(/^['"]|['"]$/g, '');
      if (!cleaned || cleaned.startsWith('-')) continue;
      found.add(cleaned);
    }
  }
  return [...found];
}

/**
 * 断言某个门禁脚本确实执行了给定脚本；失败信息直接说明"覆盖丢失"，
 * 而不是"命令文本不匹配"。同时先确认命令没有被改写成吞错形态。
 */
export function assertScriptRuns(assert, command, script, hint = '') {
  assertGateNotWeakened(assert, command, hint);
  const referenced = referencedScripts(command);
  assert.ok(
    referenced.includes(script),
    `${hint || 'gate'} must run ${script}; it actually runs: ${referenced.join(', ') || '(nothing)'}`,
  );
}

/**
 * 断言命令里出现某个"动作 token"（构建命令、pnpm 脚本名、mise 任务名等）。
 * 与整条命令正则相比，只要求该动作存在、不规定其位置与相邻文字，
 * 因此调整参数顺序、插入新步骤都不会误报，但删除该动作仍会失败。
 */
export function assertCommandIncludes(assert, command, token, hint = '') {
  assertGateNotWeakened(assert, command, hint);
  assert.ok(
    typeof command === 'string' && command.includes(token),
    `${hint || 'gate'} must include \`${token}\`; command was: ${command ?? '(missing)'}`,
  );
}

/**
 * 断言"先构建、后测试"的执行顺序。只看 token 出现位置，不看整条命令文本。
 * 顺序被反转（测试先于构建）与构建被删除都会失败。
 */
export function assertCommandOrder(assert, command, before, after, hint = '') {
  assertGateNotWeakened(assert, command, hint);
  const at = token => (typeof command === 'string' ? command.indexOf(token) : -1);
  const first = at(before), second = at(after);
  assert.ok(first !== -1, `${hint || 'gate'} must include \`${before}\`; command was: ${command ?? '(missing)'}`);
  assert.ok(second !== -1, `${hint || 'gate'} must include \`${after}\`; command was: ${command ?? '(missing)'}`);
  assert.ok(first < second, `${hint || 'gate'} must run \`${before}\` before \`${after}\``);
}

/**
 * 断言一组脚本全部被某个门禁执行（用于"补丁测试不得被移出门禁"这类回归）。
 * 顺序无关：新增脚本不会导致失败，移除任意一个都会失败。
 */
export function assertScriptRunsAll(assert, command, scripts, hint = '') {
  assertGateNotWeakened(assert, command, hint);
  const referenced = referencedScripts(command);
  const missing = scripts.filter(script => !referenced.includes(script));
  assert.deepEqual(
    missing,
    [],
    `${hint || 'gate'} dropped ${missing.join(', ') || ''}; it actually runs: ${referenced.join(', ')}`,
  );
}

/**
 * 从 mise.toml 文本中取出某个任务的命令行。支持仓库实际使用的两种写法：
 *   1. 顶层任务：`ci-code = "pnpm a && pnpm b"`
 *   2. `[tasks.<name>]` 段内的 `run = "..."`
 * 返回 null 表示该任务不存在——调用方应据此失败，而不是静默跳过。
 */
export function miseTaskCommand(miseToml, task) {
  if (typeof miseToml !== 'string') return null;
  const lines = miseToml.split('\n');
  const inline = lines.find(candidate => candidate.startsWith(`${task} =`));
  if (inline) return inline.slice(inline.indexOf('=') + 1).trim().replace(/^"|"$/g, '');
  const start = lines.findIndex(candidate => candidate.trim() === `[tasks.${task}]`);
  if (start === -1) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('[')) return null;           // 下一个段开始，说明本段没有 run
    if (line.startsWith('run =')) return line.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '');
  }
  return null;
}
