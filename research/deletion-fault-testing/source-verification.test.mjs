import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { loadProductionSubjects, resolveDiscoveryFiles, REPOSITORY_ROOT } from '../../scripts/deletion-fault-testing/subjects.mjs';
import { discoverCandidates } from '../../scripts/deletion-fault-testing/discovery.mjs';
import { verifyPilotSources } from '../../scripts/deletion-fault-testing/validate-pilot.mjs';

test('source verification reloads actual descriptors and rescans candidates in the current checkout', async () => {
  // Read-only integration check: createAdapter loads APIs, but open/produce/remove
  // are never called. This cannot count as an experiment or a real-system run.
  const loaded = await loadProductionSubjects();
  const subjects = [];
  for (const actual of loaded.subjects) {
    const files = await resolveDiscoveryFiles(REPOSITORY_ROOT, actual.metadata);
    subjects.push({ id: actual.adapter.id, metadata: actual.metadata, checkedStores: actual.adapter.checkedStores,
      discovery: await discoverCandidates({ root: REPOSITORY_ROOT, files, allowDependencies: true }) });
  }
  const report = { kind: 'feasibility-pilot', subjects, sourceManifest: {
    root: '/unavailable/original/machine/checkout', files: ['package.json'],
    before: { 'package.json': createHash('sha256').update(await readFile(path.join(REPOSITORY_ROOT, 'package.json'))).digest('hex') },
  } };
  await verifyPilotSources(report);
  for (const mutate of [
    copy => { copy.subjects[2].discovery.candidates[0].line++; },
    copy => { copy.subjects[3].discovery.files = copy.subjects[3].discovery.files.slice(1); },
    copy => { copy.subjects[2].metadata.version = 'invented version'; },
    copy => { copy.subjects[0].checkedStores = ['inventedRows']; },
  ]) {
    const copy = structuredClone(report); mutate(copy);
    await assert.rejects(verifyPilotSources(copy), /differ/);
  }
});
