import { runtimeManifest } from './evidence.mjs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { GROUPS, runSample } from './runner.mjs';
import { hash, readJson, writeJson } from './config.mjs';

export function schedule(tasks, samples) {
  const rows = [];
  for (let sample = 0; sample < samples; sample++) for (let t = 0; t < tasks.length; t++) {
    const offset = (sample + t) % GROUPS.length;
    for (let i = 0; i < GROUPS.length; i++) rows.push({ taskId: tasks[t].id, taskHash: hash(tasks[t]), family: tasks[t].family, split: tasks[t].split, sample, group: GROUPS[(offset + i) % GROUPS.length] });
  }
  return rows;
}
export async function runBatch({ config, tasks, directory, eda, signal, inventory }) {
  if (!tasks.length || new Set(tasks.map((t) => t.id)).size !== tasks.length) throw new Error('tasks_empty_or_duplicate');
  if (new Set(tasks.map((t) => t.split)).size !== 1) throw new Error('development_and_holdout_require_separate_batches');
  await mkdir(directory, { mode: 0o700 });
  const jobs = schedule(tasks, config.samples).map((row, index) => ({ ...row, path: `run-${String(index).padStart(5, '0')}` }));
  const manifest = { runtime: await runtimeManifest(), schemaVersion: 1, evidenceKind: eda.kind, configHash: hash(config), config, inventory, jobs, createdAt: new Date().toISOString() };
  // Write all planned jobs before first generation, preserving crash denominators.
  await writeJson(join(directory, 'manifest.json'), manifest);
  for (const job of jobs) {
    if (signal?.aborted) break;
    try { await runSample({ config, task: tasks.find((t) => t.id === job.taskId), group: job.group, sample: job.sample, directory: join(directory, job.path), eda, signal }); }
    catch (err) { await writeJson(join(directory, `${job.path}.failure.json`), { error: err.message }); }
  }
  const report = await loadReport(directory);
  await writeJson(join(directory, 'report.json'), report);
  return report;
}
function wilson(success, n) {
  if (!n) return null;
  const z = 1.96, p = success / n, denom = 1 + z * z / n;
  const mid = (p + z * z / (2 * n)) / denom, delta = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / denom;
  return [Math.max(0, mid - delta), Math.min(1, mid + delta)];
}
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
/** Cluster bootstrap by task: repeated samples are not independent tasks. */
function pairedInterval(diffs, seed) {
  if (diffs.length < 2) return null;
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const values = Array.from({ length: 2000 }, () => mean(diffs.map(() => diffs[Math.floor(next() * diffs.length)]))).sort((a, b) => a - b);
  return [percentile(values, 0.025), percentile(values, 0.975)];
}
export function summarize(manifest, results) {
  if (results.length !== manifest.jobs.length) throw new Error('result_count_mismatch');
  const rows = manifest.jobs.map((job, i) => {
    const r = results[i];
    if (r && (r.runtimeHash !== manifest.runtime.sha256 || r.configHash !== manifest.configHash || r.evidenceKind !== manifest.evidenceKind || ['taskId', 'taskHash', 'group', 'sample', 'family', 'split'].some((k) => r[k] !== job[k]))) throw new Error('mixed_or_mismatched_evidence');
    return { ...job, result: r, passed: r?.status === 'completed' && r?.passed === true };
  });
  const groups = Object.fromEntries(GROUPS.map((group) => {
    const items = rows.filter((r) => r.group === group), success = items.filter((r) => r.passed).length;
    const durations = items.filter((r) => Number.isFinite(r.result?.wallMs)).map((r) => r.result.wallMs).sort((a, b) => a - b);
    const taskSamples = [...new Set(items.map((r) => r.taskId))].map((id) => items.filter((r) => r.taskId === id));
    const passAt = (k) => !taskSamples.length || taskSamples.some((rs) => rs.length < k) ? null : mean(taskSamples.map((rs) => {
      const n = rs.length, c = rs.filter((r) => r.passed).length;
      if (n - c < k) return 1;
      let failure = 1; for (let i = 0; i < k; i++) failure *= (n - c - i) / (n - i);
      return 1 - failure;
    }));
    return [group, { independentPassAt1: group === 'C1' ? null : passAt(1), independentPassAt5: group === 'C1' ? null : passAt(5), planned: items.length, success, missing: items.filter((r) => !r.result).length, publicDevelopmentPassRate: items.length ? success / items.length : null, wilson95Descriptive: wilson(success, items.length), wallMsObserved: durations.length, medianWallMs: durations.length ? percentile(durations, 0.5) : null, p95WallMs: durations.length ? percentile(durations, 0.95) : null, calls: items.reduce((n, r) => n + (r.result?.calls ?? 0), 0) }];
  }));
  const pairs = Object.fromEntries(['A1', 'A2', 'C1'].map((group) => {
    const baseline = rows.filter((r) => r.group === 'B0');
    const byTask = new Map(); let improved = 0, regressed = 0;
    for (const b of baseline) {
      const a = rows.find((r) => r.taskId === b.taskId && r.sample === b.sample && r.group === group);
      const d = Number(a?.passed ?? false) - Number(b.passed);
      if (d > 0) improved++; if (d < 0) regressed++;
      byTask.set(b.taskId, [...(byTask.get(b.taskId) ?? []), d]);
    }
    const diffs = [...byTask.values()].map(mean);
    return [group, { pairs: baseline.length, improved, regressed, taskCount: diffs.length, pairedGain: diffs.length ? mean(diffs) : null, taskClusterBootstrap95: pairedInterval(diffs, manifest.config.seed) }];
  }));
  const strata = {};
  for (const row of rows) {
    const key = `${row.split}/${row.family}/${row.group}`;
    strata[key] ??= { planned: 0, success: 0 }; strata[key].planned++; strata[key].success += Number(row.passed);
  }
  return { schemaVersion: 1, evidenceKind: manifest.evidenceKind, officialAcceptance: false, groups, pairs, strata, limitations: ['Public C simulation and synthesis only; no official four-level score or timing closure.', 'Timeouts, crashes and missing jobs remain in denominators; missing cost is not imputed as zero.', 'Wilson intervals are descriptive; paired intervals resample tasks, not repair steps.', 'C1 matches maximum calls/checks/time, not measured token consumption; it is best-of-budget, not pass@k.', 'Model revision, quantization, GPU and cold/warm state need independent attestation.', 'pass@5 requires at least five independent final samples per task; internal repair calls are not samples.', 'Simulated fixtures never establish competition gain.'] };
}
export async function loadReport(directory) {
  const manifest = await readJson(join(directory, 'manifest.json'));
  const results = [];
  for (const job of manifest.jobs) {
    if (!/^run-\d{5}$/.test(job.path)) throw new Error('invalid_manifest_path');
    try { results.push(await readJson(join(directory, job.path, 'result.json'))); }
    catch (err) { if (err.code !== 'ENOENT') throw err; results.push(null); }
  }
  return summarize(manifest, results);
}
