import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fixture, close, oracle, snapshot, query, LOCAL } from '../../memory-deletion-research/fixture.mjs';

export const metadata = {
  project: 'Aervox-harness', version: 'b08636ac plus this research harness',
  repository: 'https://github.com/3yearsZhuang/Aervox-harness',
  discoveryFiles: ['packages/repositories/src/repositories/sqlite/provenance-repository.ts'],
  limitations: [
    'Development/calibration subject. Historical reconstruction uses explicit research SQL and is not a new production defect.',
    'Ownership and the eight observed stores are supplied by the existing synthetic fixture and separate SQL observer.',
    'Only cooperative single-producer deletion interleavings are generated; no new crash, multiprocess, semantic-unlearning or physical-erasure claim.',
  ],
};
const event = (phase, kind, operation, result) => ({
  site: `aervox.${operation}`, actor: 'producer', operation, kind, phase, entity: 'target',
  ...(result ? { result } : {}),
});

export async function createAdapter({ historical = false } = {}) {
  return {
    id: historical ? 'aervox-historical-provenance' : 'aervox-guarded',
    checkedStores: ['record', 'revisions', 'evidence', 'fts', 'vector', 'summary', 'audit', 'outbox'],
    async open(seed, { signal } = {}) {
      const directory = await mkdtemp(path.join(tmpdir(), 'deletion-fault-aervox-'));
      try {
        const f = await fixture(`file:${path.join(directory, 'memory.db')}`);
        return { f, directory, signal, seed };
      } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
    },
    async produce(state, checkpoint) {
      state.signal?.throwIfAborted();
      await checkpoint(event('before', 'read', 'select'));
      const [row] = await query(state.f.client, "SELECT content FROM memory_records WHERE id='target' AND is_deleted=0");
      await checkpoint(event('after', 'read', 'select', row ? 'accepted' : 'rejected'));
      if (!row) return;
      const content = `${row.content}; derived synthetic revision`;
      await checkpoint(event('before', 'write', 'appendMemoryRevision'));
      let result = 'accepted';
      if (historical) {
        // Reconstruct the pre-guard method's content-bearing insert. Never used
        // by a product operation and not counted as a newly discovered bug.
        await query(state.f.client, 'INSERT INTO memory_revisions(id,memory_id,content,created_at) VALUES(?,?,?,?)',
          [`derived:${state.seed}`, 'target', content, '2026-10-18T00:00:00.000Z']);
      } else {
        try { await state.f.provenance.appendMemoryRevision(LOCAL, { id: `derived:${state.seed}`, memoryId: 'target', content }); }
        catch (error) { if (error.message !== 'memory_write_target_unavailable') throw error; result = 'rejected'; }
      }
      await checkpoint(event('after', 'write', 'appendMemoryRevision', result));
    },
    async remove(state) { state.signal?.throwIfAborted(); await state.f.store.clean('target'); },
    async observe(state) {
      const result = await oracle(state.f);
      return { residue: result.residue, keepSnapshot: await snapshot(state.f, 'keep') };
    },
    async close(state) { await close(state.f); await rm(state.directory, { recursive: true, force: true }); },
  };
}
