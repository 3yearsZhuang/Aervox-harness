import { mkdir, readFile, writeFile, appendFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSchedule } from './engine.mjs';
import { generatePlans } from './planner.mjs';
import { discoverCandidates } from './discovery.mjs';
import { STRATEGIES, PILOT_INPUTS, summarizeRows, assessGo, validatePilot } from './validate-pilot.mjs';
import { loadProductionSubjects as subjects, resolveDiscoveryFiles } from './subjects.mjs';
export { resolveDiscoveryFiles } from './subjects.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const HERE = fileURLToPath(new URL('./', import.meta.url));
const PROTOCOL = JSON.parse(await readFile(new URL('./protocol.json', import.meta.url), 'utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const relative = (root, file) => path.relative(root, file).split(path.sep).join('/');

async function discover(root, metadata) {
  return discoverCandidates({ root, files: await resolveDiscoveryFiles(root, metadata), allowDependencies: true });
}

async function hashFiles(root, files) {
  const entries = [];
  for (const file of files) entries.push([file, digest(await readFile(path.resolve(root, file)))]);
  return Object.fromEntries(entries);
}

async function toolInputs() {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['node_modules', '.turbo', 'dist', 'out'].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.name.endsWith('.mjs')) files.push(relative(ROOT, absolute));
    }
  }
  await visit(HERE);
  await visit(path.join(ROOT, 'research/deletion-fault-testing'));
  return files;
}

function configuration(options) {
  const config = {
    strategies: [...STRATEGIES], budgets: options.budgets ?? [...PROTOCOL.budgets], seeds: options.seeds ?? [...PROTOCOL.seeds],
    replayRepetitions: options.replayRepetitions ?? PROTOCOL.replayRepetitions, timeoutMs: PROTOCOL.timeoutMs,
    cleanupTimeoutMs: PROTOCOL.cleanupTimeoutMs,
  };
  if (!Array.isArray(config.budgets) || !config.budgets.length || config.budgets.some(value => !Number.isSafeInteger(value) || value < 1) ||
      new Set(config.budgets).size !== config.budgets.length || !Array.isArray(config.seeds) || !config.seeds.length ||
      config.seeds.some(value => !Number.isSafeInteger(value)) || new Set(config.seeds).size !== config.seeds.length ||
      !Number.isSafeInteger(config.replayRepetitions) || config.replayRepetitions < 1) throw new Error('invalid pilot budgets, seeds or replay repetitions');
  return config;
}

/** Read/resolve inputs without opening fixtures or running schedules. */
export async function checkPilotInputs() {
  const loaded = await subjects();
  const discoveries = [];
  for (const subject of loaded.subjects) discoveries.push({ id: subject.adapter.id, discovery: await discover(ROOT, subject.metadata) });
  const files = [...new Set([...PILOT_INPUTS, ...await toolInputs(), ...discoveries.flatMap(subject => subject.discovery.files.map(file => file.path))])].sort();
  const hashes = await hashFiles(ROOT, files);
  return { status: 'inputs-resolved-no-experiments', subjects: discoveries.map(subject => ({ id: subject.id, files: subject.discovery.files.length, candidates: subject.discovery.candidates.length })), sourceFiles: Object.keys(hashes).length };
}

/**
 * Every row executes a fresh fixture; repeated seeds/budgets are never cached.
 * The optional second argument is solely dependency injection for unit tests.
 * Such outputs are marked unit-fixture and rejected as experimental evidence.
 */
export async function runPilot(options = {}, injected = null) {
  if (typeof options.out !== 'string' || !options.out.trim()) throw new Error('out must be a new output directory');
  const out = path.resolve(options.out);
  await mkdir(path.dirname(out), { recursive: true });
  await mkdir(out); // No recursive mkdir here: even an existing empty dir is refused.
  const root = injected?.root ?? ROOT;
  const rows = [];
  const report = {
    schemaVersion: 1, kind: injected ? 'unit-fixture' : 'feasibility-pilot', phase: PROTOCOL.phase,
    status: 'running', startedAt: new Date().toISOString(), completedAt: null, rawFile: 'raw.jsonl', rawRows: 0,
    protocol: PROTOCOL, config: null, subjects: [], sourceManifest: null, summary: null, go: null, error: null,
    provenance: {
      inputCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      node: process.version, platform: process.platform, arch: process.arch,
      sourceScope: 'Repository measurement inputs plus explicit installed dependency sources; transitive dependency source coverage is not claimed. pnpm-lock.yaml binds the dependency graph.',
      validationScope: 'Validators detect internal and current-source consistency. They do not authenticate actual execution, sign evidence or establish that a report is independently witnessed.',
    },
  };
  const raw = path.join(out, report.rawFile);
  await writeFile(raw, '', { flag: 'wx' });
  const persist = async row => { await appendFile(raw, `${JSON.stringify(row)}\n`); rows.push(row); report.rawRows = rows.length; };
  const save = () => writeFile(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  let measurementError;
  try {
    report.config = configuration(options);
    const loaded = await (injected?.loadSubjects ?? subjects)();
    for (const subject of loaded.subjects) {
      const discovery = await (injected?.discover ?? discover)(root, subject.metadata);
      report.subjects.push({ id: subject.adapter.id, metadata: subject.metadata, checkedStores: subject.adapter.checkedStores, discovery });
    }
    const files = [...new Set([...(injected?.sourceFiles ?? [...PILOT_INPUTS, ...await toolInputs()]),
      ...report.subjects.flatMap(subject => subject.discovery.files.map(file => file.path))])].sort();
    report.sourceManifest = { root, files, before: await hashFiles(root, files), after: {}, changedFiles: [] };
    await save();
    for (const subject of loaded.subjects) {
      const descriptor = report.subjects.find(entry => entry.id === subject.adapter.id);
      const reference = await runSchedule(subject.adapter, { seed: report.config.seeds[0], timeoutMs: report.config.timeoutMs, cleanupTimeoutMs: report.config.cleanupTimeoutMs });
      await persist({ type: 'reference', subject: subject.adapter.id, run: reference });
      for (const budget of report.config.budgets) for (const seed of report.config.seeds) for (const strategy of STRATEGIES) {
        const plans = generatePlans(reference.trace, { strategy, budget, seed, candidates: descriptor.discovery.candidates });
        await persist({ type: 'allocation', subject: subject.adapter.id, strategy, budget, seed, planIds: plans.map(plan => plan.id) });
        for (let i = 0; i < plans.length; i++) {
          const plan = plans[i];
          const run = await runSchedule(subject.adapter, { plan, seed, timeoutMs: report.config.timeoutMs, cleanupTimeoutMs: report.config.cleanupTimeoutMs });
          await persist({ type: 'schedule', subject: subject.adapter.id, strategy, budget, seed, ordinal: i + 1, plan, run });
        }
      }
      const witness = rows.find(row => row.type === 'schedule' && row.subject === subject.adapter.id && row.run.status === 'completed' && row.run.violations.length > 0);
      if (witness) for (let repetition = 1; repetition <= report.config.replayRepetitions; repetition++) {
        const run = await runSchedule(subject.adapter, { plan: witness.plan, seed: witness.seed, timeoutMs: report.config.timeoutMs, cleanupTimeoutMs: report.config.cleanupTimeoutMs });
        await persist({ type: 'replay', subject: subject.adapter.id, repetition, seed: witness.seed, plan: witness.plan, run });
      }
    }
    const audit = await runSchedule(loaded.audit, { seed: report.config.seeds[0], timeoutMs: report.config.timeoutMs, cleanupTimeoutMs: report.config.cleanupTimeoutMs });
    await persist({ type: 'audit', subject: loaded.audit.id, classification: 'standalone-api-composition-audit', run: audit });
    report.sourceManifest.after = await hashFiles(root, report.sourceManifest.files);
    report.sourceManifest.changedFiles = report.sourceManifest.files.filter(file => report.sourceManifest.before[file] !== report.sourceManifest.after[file]);
    report.summary = summarizeRows(report, rows);
    report.go = assessGo(report, rows, report.summary);
    report.status = 'complete';
    validatePilot(report, rows, { allowTestFixture: Boolean(injected) });
    if (rows.some(row => row.run?.status === 'infrastructure-error')) throw new Error('pilot contains infrastructure errors; raw observations preserved');
  } catch (error) {
    measurementError = error;
    report.status = 'failed'; report.error = `${error.name}: ${error.message}`;
    if (report.sourceManifest) {
      try {
        report.sourceManifest.after = await hashFiles(root, report.sourceManifest.files);
        report.sourceManifest.changedFiles = report.sourceManifest.files.filter(file => report.sourceManifest.before[file] !== report.sourceManifest.after[file]);
      } catch (hashError) { report.sourceManifest.afterError = `${hashError.name}: ${hashError.message}`; }
    }
    if (report.config && report.subjects.length) {
      report.summary = summarizeRows(report, rows); report.go = assessGo(report, rows, report.summary);
    }
  } finally { report.completedAt = new Date().toISOString(); await save(); }
  if (measurementError) {
    measurementError.message += `; evidence preserved at ${out}`;
    throw measurementError;
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--check') process.stdout.write(`${JSON.stringify(await checkPilotInputs())}\n`);
    else {
      const options = {};
      for (const arg of args) {
        if (arg.startsWith('--out=')) options.out = arg.slice(6);
        else if (arg.startsWith('--budgets=')) options.budgets = arg.slice(10).split(',').map(Number);
        else if (arg.startsWith('--seeds=')) options.seeds = arg.slice(8).split(',').map(Number);
        else if (arg.startsWith('--replays=')) options.replayRepetitions = Number(arg.slice(10));
        else throw new Error('Usage: node pilot.mjs --check | --out=NEW_DIRECTORY [--budgets=1,2,4,8] [--seeds=1,2] [--replays=20]');
      }
      const report = await runPilot(options);
      process.stdout.write(`${JSON.stringify({ output: path.resolve(options.out), status: report.status, rawRows: report.rawRows, decision: report.go.decision })}\n`);
    }
  } catch (error) { process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1; }
}
