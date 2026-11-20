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
 * 实际覆盖并没有变弱。失败信息也指向"命令文本变了"，而不是"覆盖丢了"，
 * 维护者要先读懂整条正则才知道是不是真问题。
 *
 * 本模块改为**语义断言**：解析出命令实际调用了哪些脚本，再判断目标脚本是否
 * 在集合中。新增脚本不会误报，移出脚本仍会立即失败。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 读取根 package.json 的 scripts（默认指向本模块所在的仓库根）。 */
export function readRootScripts(root = fileURLToPath(new URL('..', import.meta.url))) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts;
}

/**
 * 从一条 npm script 命令里提取所有被 `node` / `node --test` 调用的脚本路径，
 * 以及末尾被当作入口执行的非 test 脚本。
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
      if (!token || token.startsWith('-') || token.startsWith('--')) continue;
      found.add(token);
    }
  }
  return [...found];
}

/**
 * 断言某个门禁脚本确实执行了给定脚本；失败信息直接说明"覆盖丢失"，
 * 而不是"命令文本不匹配"。
 */
export function assertScriptRuns(assert, command, script, hint = '') {
  const referenced = referencedScripts(command);
  assert.ok(
    referenced.includes(script),
    `${hint || 'gate'} must run ${script}; it actually runs: ${referenced.join(', ') || '(nothing)'}`,
  );
}

/**
 * 断言一组脚本全部被某个门禁执行（用于"补丁测试不得被移出门禁"这类回归）。
 * 顺序无关：新增脚本不会导致失败，移除任意一个都会失败。
 */
export function assertScriptRunsAll(assert, command, scripts, hint = '') {
  const referenced = referencedScripts(command);
  const missing = scripts.filter(script => !referenced.includes(script));
  assert.deepEqual(
    missing,
    [],
    `${hint || 'gate'} dropped ${missing.join(', ') || ''}; it actually runs: ${referenced.join(', ')}`,
  );
}

/**
 * 从 mise.toml 文本中取出某个任务的命令行（`name = "..."`）。
 * 返回 null 表示该任务不存在——调用方应据此失败，而不是静默跳过。
 */
export function miseTaskCommand(miseToml, task) {
  const line = miseToml.split('\n').find(candidate => candidate.startsWith(`${task} =`));
  if (!line) return null;
  return line.slice(line.indexOf('=') + 1).trim().replace(/^"|"$/g, '');
}
