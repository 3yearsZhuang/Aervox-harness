import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generatePlans } from './planner.mjs';
import { validateObservation } from './engine.mjs';
import { REQUIRED_SOURCE_FILES } from '../memory-deletion-research/source-manifest.mjs';
import { discoverCandidates } from './discovery.mjs';
import { assertProductionDescriptor, loadProductionSubjects, resolveDiscoveryFiles, REPOSITORY_ROOT } from './subjects.mjs';

const FROZEN_PROTOCOL = JSON.parse(await readFile(new URL('./protocol.json', import.meta.url), 'utf8'));

export const SUBJECT_IDS = ['aervox-guarded', 'aervox-historical-provenance', 'langchain-libsql', 'llamaindex-simple'];
export const STRATEGIES = ['generic', 'random', 'trace-only', 'guided'];
export const PILOT_INPUTS = [
  'research/deletion-fault-testing/package.json', 'research/deletion-fault-testing/langchain.mjs',
  'research/deletion-fault-testing/llamaindex.mjs', 'research/deletion-fault-testing/resolve.mjs',
  ...REQUIRED_SOURCE_FILES, 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', 'mise.toml',
  ...['engine.mjs', 'planner.mjs', 'discovery.mjs', 'pilot.mjs', 'validate-pilot.mjs', 'subjects.mjs', 'protocol.json',
    'adapters/aervox.mjs'].map(file => `scripts/deletion-fault-testing/${file}`),
];
const sorted = values => [...values].sort();
const canonical = value => JSON.stringify(value, function (_key, child) {
  return child && !Array.isArray(child) && typeof child === 'object'
    ? Object.fromEntries(Object.keys(child).sort().map(key => [key, child[key]])) : child;
});
const equal = (a, b) => canonical(a) === canonical(b);
const groupKey = row => JSON.stringify([row.subject, row.strategy, row.budget, row.seed]);
const counterexample = row => row.run.status === 'completed' && row.run.violations.length > 0;
const sameViolations = (a, b) => equal(sorted(a), sorted(b));

export function summarizeRows(report, rows) {
  const groups = rows.filter(row => row.type === 'allocation').map(allocation => {
    const selected = rows.filter(row => row.type === 'schedule' && groupKey(row) === groupKey(allocation));
    const first = selected.find(counterexample);
    const subject = report.subjects.find(subject => subject.id === allocation.subject);
    return {
      subject: allocation.subject, strategy: allocation.strategy, budget: allocation.budget, seed: allocation.seed,
      allocated: allocation.budget, generated: allocation.planIds.length, executed: selected.length,
      completed: selected.filter(row => row.run.status === 'completed').length,
      ineligible: selected.filter(row => row.run.status === 'ineligible').length,
      infrastructureErrors: selected.filter(row => row.run.status === 'infrastructure-error').length,
      safeCompleted: selected.filter(row => row.run.status === 'completed' && !row.run.violations.length).length,
      counterexamples: selected.filter(counterexample).length,
      firstViolationOrdinal: first?.ordinal ?? null,
      rootCauseFamilies: first ? [subject.metadata.rootCause] : [],
    };
  });
  const witnesses = report.subjects.map(subject => {
    const first = rows.find(row => row.type === 'schedule' && row.subject === subject.id && counterexample(row));
    const replays = rows.filter(row => row.type === 'replay' && row.subject === subject.id);
    return {
      subject: subject.id, plan: first?.plan ?? null, seed: first?.seed ?? null,
      violations: first?.run.violations ?? [], repetitions: replays.length,
      successful: first ? replays.filter(row => row.run.status === 'completed' && sameViolations(row.run.violations, first.run.violations)).length : 0,
      reason: first ? 'first-observed-counterexample' : 'no-counterexample',
    };
  });
  return { groups, witnesses, note: 'Seeds and nested budgets are not independent observations. Families are declared adapter categories, not confirmed upstream defect roots.' };
}

export function assessGo(report, rows, summary) {
  const protocol = report.protocol;
  const references = rows.filter(row => row.type === 'reference');
  const externals = report.subjects.filter(subject => ['langchain-libsql', 'llamaindex-simple'].includes(subject.id));
  const heldOutComparison = report.config.budgets.map(budget => {
    const familyCounts = Object.fromEntries(STRATEGIES.map(strategy => [strategy, new Set(summary.groups
      .filter(group => group.subject === protocol.plannerHeldOutSubject && group.budget === budget && group.strategy === strategy)
      .flatMap(group => group.rootCauseFamilies)).size]));
    return { budget, familyCounts, strictGuidedGain: familyCounts.guided > familyCounts.generic && familyCounts.guided > familyCounts.random };
  });
  const conditions = [
    { id: 'full-frozen-protocol', passed: report.kind === 'feasibility-pilot' && equal(report.config.budgets, protocol.budgets) &&
      equal(report.config.seeds, protocol.seeds) && report.config.replayRepetitions === protocol.replayRepetitions },
    { id: 'frozen-source-consistency', passed: Boolean(report.sourceManifest?.files.length) &&
      report.sourceManifest.files.every(file => typeof report.sourceManifest.before[file] === 'string' && report.sourceManifest.before[file] === report.sourceManifest.after[file]) &&
      report.sourceManifest.changedFiles.length === 0 },
    { id: 'two-real-external-integrations', passed: externals.length === 2 && new Set(externals.map(subject => subject.metadata.project)).size === 2 &&
      externals.every(subject => subject.metadata.evidenceClass === 'application-contract' && subject.metadata.publicApiIntegration === true &&
        rows.some(row => row.type === 'schedule' && row.subject === subject.id && row.run.status === 'completed')) },
    { id: 'safe-calibration-and-sequential-references', passed: references.length === SUBJECT_IDS.length &&
      references.every(row => row.run.status === 'completed' && row.run.violations.length === 0) &&
      rows.filter(row => row.type === 'schedule' && row.subject === 'aervox-guarded').every(row => row.run.status === 'completed' && row.run.violations.length === 0) },
    { id: 'no-unexplained-execution-errors', passed: rows.filter(row => ['reference', 'schedule', 'replay', 'audit'].includes(row.type))
      .every(row => row.run.status === 'completed') },
    { id: 'counterexample-replay-threshold', passed: summary.witnesses.some(witness => witness.plan) && summary.witnesses.filter(witness => witness.plan)
      .every(witness => witness.repetitions === protocol.replayRepetitions && witness.successful >= protocol.minimumSuccessfulReplays) },
    { id: 'strict-held-out-guided-gain', passed: heldOutComparison.some(comparison => comparison.strictGuidedGain) },
  ];
  return {
    decision: conditions.every(condition => condition.passed) ? 'GO' : 'NOT ESTABLISHED', conditions, heldOutComparison,
    interpretation: 'GO only supports continuing this bounded method study. Equality with baselines establishes no effectiveness gain; this pilot confirms no upstream defect, novelty, representative system coverage or independent replication.',
  };
}

function validateRun(run, subject) {
  assert.ok(run && ['completed', 'ineligible', 'infrastructure-error'].includes(run.status), 'invalid run status');
  assert.equal(run.adapterId, subject.id, 'adapter identity mismatch');
  assert.ok(Array.isArray(run.trace) && Array.isArray(run.violations), 'missing run trace/violations');
  assert.ok(Number.isFinite(run.durationMs) && run.durationMs >= 0, 'invalid duration');
  const counts = new Map();
  for (const event of run.trace) {
    const key = JSON.stringify([event.actor, event.site, event.phase]);
    const next = (counts.get(key) ?? 0) + 1;
    assert.equal(event.occurrence, next, 'trace occurrence mismatch');
    counts.set(key, next);
  }
  generatePlans(run.trace, { strategy: 'generic', budget: run.trace.length });
  if (run.plan !== null) {
    assert.ok(run.plan && run.plan.action === 'delete' && run.plan.trigger, 'missing deletion plan');
    const matches = run.trace.filter(event => ['site', 'actor', 'phase', 'occurrence'].every(key => event[key] === run.plan.trigger[key]));
    assert.ok(matches.length <= 1, 'deletion trigger must identify one occurrence');
    assert.equal(run.triggerReached, matches.length === 1, 'deletion trigger was not reached in the actual trace');
    if (run.status === 'completed') assert.equal(matches.length, 1, 'completed deletion has no actual trigger');
    if (run.status === 'ineligible') assert.equal(matches.length, 0, 'ineligible deletion reached its trigger');
  } else assert.notEqual(run.status, 'ineligible', 'sequential reference cannot be ineligible');
  if (run.status === 'infrastructure-error') {
    assert.ok(typeof run.error === 'string' && run.error, 'infrastructure error lacks reason');
    assert.deepEqual(run.violations, [], 'infrastructure errors must not be scored');
    return;
  }
  assert.equal(run.error, null, 'successful/ineligible run has error');
  validateObservation(subject.checkedStores, run.final);
  validateObservation(subject.checkedStores, { residue: Object.fromEntries(subject.checkedStores.map(store => [store, 0])), keepSnapshot: run.keepBefore });
  if (run.status === 'ineligible') {
    assert.equal(run.triggerReached, false); assert.equal(run.atCompletion, null); assert.deepEqual(run.violations, []);
    return;
  }
  assert.equal(run.triggerReached, true);
  assert.ok(run.trace.length > 0, 'completed run has an empty producer trace');
  validateObservation(subject.checkedStores, run.atCompletion);
  const expected = [];
  if (subject.checkedStores.some(store => run.atCompletion.residue[store] > 0)) expected.push('false-completion');
  if (subject.checkedStores.some(store => run.atCompletion.residue[store] === 0 && run.final.residue[store] > 0)) expected.push('resurrection');
  if ([run.atCompletion, run.final].some(observation => !equal(observation.keepSnapshot, run.keepBefore))) expected.push('retained-data-changed');
  assert.deepEqual(run.violations, expected, 'oracle labels do not match raw observations');
}

/** Check consistency, not execution authenticity, independent witnessing or signatures. */
export function validatePilot(report, rows, { allowTestFixture = false } = {}) {
  assert.ok(report && report.schemaVersion === 1, 'invalid pilot schema');
  assert.ok(report.kind === 'feasibility-pilot' || (allowTestFixture && report.kind === 'unit-fixture'), 'test fixtures are not production evidence');
  assert.equal(report.status, 'complete', 'pilot report is incomplete or failed');
  assert.deepEqual(report.protocol, FROZEN_PROTOCOL, 'report differs from the frozen protocol');
  assert.equal(report.phase, FROZEN_PROTOCOL.phase);
  assert.ok(Array.isArray(rows) && rows.length > 0, 'raw JSONL is empty');
  assert.equal(report.rawFile, 'raw.jsonl');
  assert.equal(report.rawRows, rows.length, 'raw row count mismatch');
  assert.deepEqual(report.config.strategies, STRATEGIES);
  assert.equal(report.config.timeoutMs, FROZEN_PROTOCOL.timeoutMs);
  assert.equal(report.config.cleanupTimeoutMs, FROZEN_PROTOCOL.cleanupTimeoutMs);
  assert.ok(report.config.budgets.length && report.config.seeds.length, 'empty experiment configuration');
  assert.equal(new Set(report.config.budgets).size, report.config.budgets.length);
  assert.equal(new Set(report.config.seeds).size, report.config.seeds.length);
  assert.ok(report.config.budgets.every(value => Number.isSafeInteger(value) && value > 0));
  assert.ok(report.config.seeds.every(value => Number.isSafeInteger(value)));
  assert.ok(Number.isSafeInteger(report.config.replayRepetitions) && report.config.replayRepetitions > 0);
  assert.deepEqual(report.subjects.map(subject => subject.id), SUBJECT_IDS, 'missing or unexpected project');
  for (const subject of report.subjects) {
    assert.ok(typeof subject.metadata.project === 'string' && subject.metadata.project);
    assert.ok(typeof subject.metadata.evidenceClass === 'string' && subject.metadata.evidenceClass);
    assert.ok(typeof subject.metadata.rootCause === 'string' && subject.metadata.rootCause);
    validateObservation(subject.checkedStores, { residue: Object.fromEntries(subject.checkedStores.map(store => [store, 0])), keepSnapshot: null });
    assert.ok(subject.discovery && Array.isArray(subject.discovery.files) && Array.isArray(subject.discovery.candidates), 'missing discovery');
    if (report.kind === 'feasibility-pilot') assert.ok(subject.discovery.files.length > 0, 'empty production discovery');
    if (report.kind === 'feasibility-pilot') assertProductionDescriptor(subject);
  }
  const manifest = report.sourceManifest;
  assert.ok(manifest && Array.isArray(manifest.files) && manifest.files.length, 'missing source manifest');
  assert.deepEqual(sorted(Object.keys(manifest.before)), sorted(manifest.files));
  assert.deepEqual(sorted(Object.keys(manifest.after)), sorted(manifest.files));
  for (const file of manifest.files) {
    assert.ok(typeof file === 'string' && file && !path.isAbsolute(file) && !file.split('/').includes('..'), 'unsafe source path');
    assert.match(manifest.before[file], /^[a-f0-9]{64}$/); assert.equal(manifest.before[file], manifest.after[file], `source changed: ${file}`);
  }
  assert.deepEqual(manifest.changedFiles, []);
  if (report.kind === 'feasibility-pilot') for (const file of PILOT_INPUTS) assert.ok(manifest.files.includes(file), `missing measurement input: ${file}`);
  for (const subject of report.subjects) {
    const discovered = new Map();
    for (const file of subject.discovery.files) {
      assert.ok(typeof file.path === 'string' && !discovered.has(file.path), 'duplicate or invalid discovery file');
      assert.match(file.sha256, /^[a-f0-9]{64}$/);
      assert.equal(manifest.before[file.path], file.sha256, 'discovery source absent from frozen manifest');
      discovered.set(file.path, file.sha256);
    }
    const candidateIds = new Set();
    for (const candidate of subject.discovery.candidates) {
      assert.match(candidate.id, /^candidate:[a-f0-9]{64}$/, 'invalid candidate identity');
      assert.ok(!candidateIds.has(candidate.id), 'duplicate candidate'); candidateIds.add(candidate.id);
      assert.ok(discovered.has(candidate.file), 'candidate file was not discovered');
      assert.equal(candidate.sourceSha256, discovered.get(candidate.file), 'candidate source hash differs from discovered source');
      assert.ok(Number.isSafeInteger(candidate.line) && candidate.line > 0 && Number.isSafeInteger(candidate.column) && candidate.column > 0, 'invalid candidate location');
      assert.ok(['read', 'write', 'delete', 'complete'].includes(candidate.kind) && candidate.classification === `${candidate.kind}-candidate` && candidate.basis === 'lexical-method-name', 'invalid candidate classification');
      assert.ok(typeof candidate.method === 'string' && candidate.method.length > 0, 'invalid candidate method');
      assert.ok(candidate.enclosingMethod === null || typeof candidate.enclosingMethod === 'string', 'invalid enclosing method');
      assert.ok(candidate.className === null || typeof candidate.className === 'string', 'invalid candidate class');
    }
  }
  const allowed = new Set(['reference', 'allocation', 'schedule', 'replay', 'audit']);
  for (const row of rows) {
    assert.ok(allowed.has(row.type), `unknown raw row type: ${row.type}`);
    assert.ok(row.type === 'audit' ? row.subject === 'llamaindex-simple-index-api-only' : SUBJECT_IDS.includes(row.subject), 'unknown raw subject');
    if (row.run) {
      assert.equal(row.run.timeoutMs, report.config.timeoutMs, 'run workload deadline differs from frozen configuration');
      assert.equal(row.run.cleanupTimeoutMs, report.config.cleanupTimeoutMs, 'run cleanup deadline differs from frozen configuration');
    }
    if (['allocation', 'schedule'].includes(row.type)) {
      assert.ok(STRATEGIES.includes(row.strategy) && report.config.budgets.includes(row.budget) && report.config.seeds.includes(row.seed), 'raw row lies outside allocated configuration');
    }
  }
  for (const subject of report.subjects) {
    const references = rows.filter(row => row.type === 'reference' && row.subject === subject.id);
    assert.equal(references.length, 1, 'reference must be unique');
    validateRun(references[0].run, subject);
    assert.equal(references[0].run.plan, null);
    assert.equal(references[0].run.seed, report.config.seeds[0], 'reference seed differs from configured first seed');
    for (const budget of report.config.budgets) for (const seed of report.config.seeds) for (const strategy of STRATEGIES) {
      const key = groupKey({ subject: subject.id, strategy, budget, seed });
      const allocations = rows.filter(row => row.type === 'allocation' && groupKey(row) === key);
      assert.equal(allocations.length, 1, `missing/duplicate allocation: ${key}`);
      const plans = generatePlans(references[0].run.trace, { strategy, budget, seed, candidates: subject.discovery.candidates });
      assert.deepEqual(allocations[0].planIds, plans.map(plan => plan.id), 'allocated plans differ from regenerated plans');
      const schedules = rows.filter(row => row.type === 'schedule' && groupKey(row) === key);
      assert.equal(schedules.length, plans.length, 'missing or extra schedule execution');
      for (let i = 0; i < schedules.length; i++) {
        const row = schedules[i];
        assert.equal(row.ordinal, i + 1); assert.deepEqual(row.plan, plans[i]);
        assert.deepEqual(row.run.plan, row.plan); assert.equal(row.run.seed, seed);
        validateRun(row.run, subject);
      }
    }
    const first = rows.find(row => row.type === 'schedule' && row.subject === subject.id && counterexample(row));
    const replays = rows.filter(row => row.type === 'replay' && row.subject === subject.id);
    assert.equal(replays.length, first ? report.config.replayRepetitions : 0, 'missing/extra counterexample replays');
    for (let i = 0; i < replays.length; i++) {
      const replay = replays[i];
      assert.equal(replay.repetition, i + 1); assert.deepEqual(replay.plan, first.plan); assert.equal(replay.seed, first.seed);
      assert.deepEqual(replay.run.plan, first.plan); assert.equal(replay.run.seed, first.seed); validateRun(replay.run, subject);
    }
  }
  const audits = rows.filter(row => row.type === 'audit');
  assert.equal(audits.length, 1, 'missing standalone deletion API audit');
  assert.equal(audits[0].subject, 'llamaindex-simple-index-api-only');
  validateRun(audits[0].run, { ...report.subjects.find(subject => subject.id === 'llamaindex-simple'), id: audits[0].subject });
  assert.equal(audits[0].run.plan, null);
  assert.equal(audits[0].run.seed, report.config.seeds[0], 'audit seed differs from configured first seed');
  const expectedRows = SUBJECT_IDS.length + report.config.budgets.length * report.config.seeds.length * STRATEGIES.length * SUBJECT_IDS.length +
    rows.filter(row => ['schedule', 'replay'].includes(row.type)).length + 1;
  assert.equal(rows.length, expectedRows, 'unaccounted raw records');
  const summary = summarizeRows(report, rows);
  assert.deepEqual(report.summary, summary, 'summary differs from raw evidence');
  assert.deepEqual(report.go, assessGo(report, rows, summary), 'go/no-go differs from raw evidence');
  return report;
}

export async function validatePilotDirectory(directory, { verifySources = false, allowTestFixture = false } = {}) {
  const report = JSON.parse(await readFile(path.join(directory, 'report.json'), 'utf8'));
  const text = await readFile(path.join(directory, report.rawFile ?? 'raw.jsonl'), 'utf8');
  assert.ok(text.endsWith('\n') && text.trim(), 'raw JSONL must contain complete newline-terminated records');
  const rows = text.trimEnd().split('\n').map(line => JSON.parse(line));
  validatePilot(report, rows, { allowTestFixture });
  if (verifySources) await verifyPilotSources(report);
  return report;
}

/** Check a previously validated report against this checkout, without executing fixtures. */
export async function verifyPilotSources(report) {
  // Absolute sourceManifest.root is provenance only for production reports;
  // a new checkout verifies its own sources and installed lockfile graph.
  const root = report.kind === 'unit-fixture' ? report.sourceManifest.root : REPOSITORY_ROOT;
  for (const file of report.sourceManifest.files) {
    const sha256 = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
    assert.equal(sha256, report.sourceManifest.before[file], `current source changed: ${file}`);
  }
  if (report.kind === 'feasibility-pilot') {
    const loaded = await loadProductionSubjects();
    for (const actual of loaded.subjects) {
      const claimed = report.subjects.find(subject => subject.id === actual.adapter.id);
      assert.deepEqual(claimed.metadata, actual.metadata, 'reported metadata differs from actual adapter');
      assert.deepEqual(claimed.checkedStores, actual.adapter.checkedStores, 'reported stores differ from actual adapter');
      const files = await resolveDiscoveryFiles(root, actual.metadata);
      const discovery = await discoverCandidates({ root, files, allowDependencies: true });
      assert.deepEqual(claimed.discovery, discovery, 'reported discovery differs from rescanned actual sources');
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  const directory = args.find(arg => !arg.startsWith('--'));
  if (!directory || args.some(arg => arg.startsWith('--') && arg !== '--verify-sources')) {
    process.stderr.write('Usage: node validate-pilot.mjs OUTPUT_DIRECTORY [--verify-sources]\n'); process.exitCode = 1;
  } else {
    try {
      const report = await validatePilotDirectory(directory, { verifySources: args.includes('--verify-sources') });
      process.stdout.write(`${JSON.stringify({ status: report.status, decision: report.go.decision, rawRows: report.rawRows })}\n`);
    } catch (error) { process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1; }
  }
}
