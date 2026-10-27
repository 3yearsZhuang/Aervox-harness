import { getClientTransport, type AervoxTransport } from '@aervox/api-client';
import {
  campusStateSchema, campusStateSnapshotSchema, campusPlanSnapshotSchema,
  type CampusState, type CampusStateSnapshot, type CampusPlanSnapshot,
} from '../domain/index.js';

const base = '/v1/plugins/flowcampus';

export function createCampusClient(transport: AervoxTransport = getClientTransport()) {
  return {
    async load(signal?: AbortSignal): Promise<CampusStateSnapshot> {
      return campusStateSnapshotSchema.parse(await transport.request('GET', `${base}/state`, undefined, { signal }));
    },
    async save(state: CampusState, current: Pick<CampusStateSnapshot, 'revision' | 'lifecycleGeneration'>, signal?: AbortSignal): Promise<CampusStateSnapshot> {
      const result = await transport.request('PUT', `${base}/state`, {
        state: campusStateSchema.parse(state), expectedRevision: current.revision,
        expectedLifecycleGeneration: current.lifecycleGeneration,
      }, { signal });
      return campusStateSnapshotSchema.parse(result);
    },
    async plan(signal?: AbortSignal): Promise<CampusPlanSnapshot> {
      return campusPlanSnapshotSchema.parse(await transport.request('GET', `${base}/plan`, undefined, { signal }));
    },
  };
}
export type CampusClient = ReturnType<typeof createCampusClient>;
