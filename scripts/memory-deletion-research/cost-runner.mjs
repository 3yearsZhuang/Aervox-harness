#!/usr/bin/env node
import { fork, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COST_SCHEMA_VERSION, COST_KIND, COST_REPETITIONS, COST_BASELINE, COST_CONFIGURATIONS, COST_GUARD_MODES, COST_BOUNDARY, COST_REQUIRED_SOURCE_FILES, costSchedule } from './cost-protocol.mjs';
import { validateCostReport, validateCostFiles } from './cost-validator.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const CHILD = fileURLToPath(new URL('./cost-child.mjs', import.meta.url));
const sha = data => createHash('sha256').update(data).digest('hex');

export async function hashCostSources() {
  const readErrors = {}, hashes = {};
  await Promise.all(COST_REQUIRED_SOURCE_FILES.map(async name => {
    try { hashes[name] = sha(await readFile(path.join(ROOT, name))); }
    catch (error) { readErrors[name] = `${error.name}: ${error.message}`; }
  }));
  return { hashes: Object.fromEntries(COST_REQUIRED_SOURCE_FILES.filter(name => name in hashes).map(name => [name, hashes[name]])), readErrors };
}

export function finalizeCostChild(unit, row, execution, { messages = 1, timedOut = false, spawnError = null } = {}) {
  const result = { ...(row ?? unit), execution };
  const expectedCode = row?.status === 'completed' ? 0 : 1;
  if (!row || timedOut || spawnError || messages !== 1 || execution.code !== expectedCode || execution.signal || execution.stderr || !['completed', 'failed', 'blocked'].includes(row.status)) {
    result.status = 'failed';
    result.error = spawnError ?? (timedOut ? 'child timeout' : row?.error ?? `child result/exit failure (${messages} messages, code=${execution.code}, signal=${execution.signal})`);
  }
  return result;
}

export function runCostChild(unit, timeoutMs = 60_000) {
  return new Promise(resolve => {
    const child = fork(CHILD, [JSON.stringify(unit)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let row, stderr = '', spawnError = null, timedOut = false, messages = 0;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { spawnError = `${error.name}: ${error.message}`; });
    child.on('message', message => { messages++; if (message?.type === 'result') row = message.row; });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve(finalizeCostChild(unit, row, { code, signal, stderr }, { messages, timedOut, spawnError }));
    });
  });
}

// Summary creation and validation use separate reductions over individual rows.
function summarize(rows) {
  const distribution = values => {
    const sorted = values.toSorted((a, b) => a - b);
    const q = probability => {
      if (!sorted.length) return null;
      const offset = (sorted.length - 1) * probability, index = Math.floor(offset);
      return sorted[index] + (sorted[Math.min(index + 1, sorted.length - 1)] - sorted[index]) * (offset - index);
    };
    return { n: values.length, p25Ms: q(.25), medianMs: q(.5), p75Ms: q(.75), p95Ms: q(.95) };
  };
  const group = (kind, id) => {
    const selected = rows.filter(row => row.kind === kind && (kind === 'scale' ? row.configuration : row.mode) === id);
    const complete = selected.filter(row => row.status === 'completed');
    return { id, samples: selected.length, completed: complete.length, blocked: selected.filter(row => row.status === 'blocked').length, failed: selected.filter(row => row.status === 'failed').length,
      ...(kind === 'scale' ? { cleanup: distribution(complete.map(row => row.cleanupMs)), verification: distribution(complete.map(row => row.verificationMs)) } : { write: distribution(complete.map(row => row.writeMs)) }) };
  };
  return { scale: COST_CONFIGURATIONS.map(value => group('scale', value.id)), guard: COST_GUARD_MODES.map(mode => group('guard', mode)) };
}

export async function runCostStudy({ out, repetitions = COST_REPETITIONS, timeoutMs = 60_000, onProgress } = {}) {
  if (!out) throw new Error('--out=<new-report.json> required');
  const schedule = costSchedule(repetitions);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('timeoutMs must be 1..60000');
  out = path.resolve(out);
  await mkdir(path.dirname(out), { recursive: true });
  try { await (await open(out, 'wx')).close(); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`refusing to overwrite ${out}`); throw error; }
  const rawFile = `${path.basename(out, '.json')}.raw.jsonl`, rawPath = path.join(path.dirname(out), rawFile);
  const report = { schemaVersion: COST_SCHEMA_VERSION, kind: COST_KIND, status: 'running', error: null,
    purpose: repetitions === COST_REPETITIONS ? 'formal' : 'smoke', repetitions, startedAt: new Date().toISOString(),
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    workingTree: execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }),
    baseline: COST_BASELINE, configurations: COST_CONFIGURATIONS, guardModes: COST_GUARD_MODES,
    boundary: COST_BOUNDARY, rawFile, samples: [], hashes: {}, sourceConsistency: {} };
  let rawHandle;
  try {
    rawHandle = await open(rawPath, 'wx');
    const before = await hashCostSources(); report.hashes = before.hashes;
    report.sourceConsistency.beforeReadErrors = before.readErrors;
    if (Object.keys(before.readErrors).length) throw new Error('measurement source inputs could not be read');
    await writeFile(out, JSON.stringify(report, null, 2) + '\n');
    for (const [ordinal, unit] of schedule.entries()) {
      const row = { ...await runCostChild(unit, timeoutMs), ordinal };
      report.samples.push(row);
      await rawHandle.write(JSON.stringify(row) + '\n');
      await rawHandle.sync();
      onProgress?.({ completed: ordinal + 1, total: schedule.length, id: unit.id, status: row.status });
    }
    if (report.samples.some(row => row.status !== 'completed' || row.error !== null)) throw new Error('one or more cost observations failed or blocked');
    report.status = 'completed';
  } catch (error) { report.status = 'failed'; report.error = `${error.name}: ${error.message}`; }
  finally {
    if (rawHandle) await rawHandle.close();
    const after = await hashCostSources();
    report.sourceConsistency = { ...report.sourceConsistency, afterHashes: after.hashes, readErrors: after.readErrors,
      changedFiles: COST_REQUIRED_SOURCE_FILES.filter(name => report.hashes[name] !== after.hashes[name]) };
    if (report.sourceConsistency.changedFiles.length || Object.keys(after.readErrors).length) {
      report.status = 'failed'; report.error ??= 'source inputs changed during measurement';
    }
    report.completedAt = new Date().toISOString();
    report.summary = summarize(report.samples);
    try { report.rawSha256 = sha(await readFile(rawPath)); }
    catch (error) { report.status = 'failed'; report.error ??= `raw evidence unavailable: ${error.message}`; }
    await writeFile(out, JSON.stringify(report, null, 2) + '\n');
  }
  try {
    validateCostReport(report, { requireFormal: repetitions === COST_REPETITIONS });
    await validateCostFiles(out, { requireFormal: repetitions === COST_REPETITIONS });
  } catch (error) {
    report.status = 'failed'; report.error ??= `${error.name}: ${error.message}`;
    await writeFile(out, JSON.stringify(report, null, 2) + '\n');
    throw new Error(`${error.message}; raw evidence saved at ${out}`, { cause: error });
  }
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (const argument of process.argv.slice(2)) {
    if (argument.startsWith('--out=')) options.out = argument.slice(6);
    else if (argument.startsWith('--repetitions=')) options.repetitions = Number(argument.slice(14));
    else throw new Error(`unknown option ${argument}`);
  }
  options.onProgress = progress => { if (progress.completed % 30 === 0 || progress.status !== 'completed' || progress.completed === progress.total) console.log(JSON.stringify(progress)); };
  const report = await runCostStudy(options);
  console.log(JSON.stringify(validateCostReport(report, { requireFormal: report.repetitions === COST_REPETITIONS }), null, 2));
}
