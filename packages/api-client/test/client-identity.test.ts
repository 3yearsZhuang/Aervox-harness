import { createApp } from 'vue';
import { expect, it, vi } from 'vitest';
import { createAervoxClient, configureAervoxClient, provideAervoxClient, useAervoxSessions, useAervoxProjects, useAervoxBots, type AervoxTransport } from '../src/index.js';

const storage = () => { const data = new Map<string, string>(); return {getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }}; };
const transport = (id: string): AervoxTransport => ({
  request: vi.fn(async (_method: string, path: string) => path === '/v1/bot-connections' ? {connections: [{id}]}
    : path === '/v1/projects' ? {id, name: id, createdAt: '2026-10-24', updatedAt: '2026-10-24'}
      : {id, title: id, createdAt: '2026-10-24', updatedAt: '2026-10-24'}),
  streamTurn: vi.fn(), submitQuestionAnswers: vi.fn(), decideToolApproval: vi.fn(),
});
it('captures injected transport and shared selection per client, isolated from other apps and fallback reconfiguration', async () => {
  const transportA = transport('A'), transportB = transport('B'), fallback = transport('fallback');
  const clientA = createAervoxClient({transport: transportA, sessionId: 'A-initial', sessionStorage: storage()});
  const clientB = createAervoxClient({transport: transportB, sessionId: 'B-initial', sessionStorage: storage()});
  const appA = createApp({}), appB = createApp({});
  provideAervoxClient(clientA, appA); provideAervoxClient(clientB, appB);
  const a = appA.runWithContext(() => ({sessions: useAervoxSessions(), second: useAervoxSessions(), projects: useAervoxProjects(), bots: useAervoxBots()}));
  const b = appB.runWithContext(() => ({sessions: useAervoxSessions(), projects: useAervoxProjects(), bots: useAervoxBots()}));
  configureAervoxClient({transport: fallback, sessionId: 'fallback'});
  a.sessions.switchSession('A-selected');
  expect(a.second.activeSessionId.value).toBe('A-selected');
  expect(b.sessions.activeSessionId.value).toBe('B-initial');
  await a.sessions.createNewSession(); await b.sessions.createNewSession();
  expect(await a.projects.createProject({name: 'project A'})).toMatchObject({id: 'A'});
  expect(await b.projects.createProject({name: 'project B'})).toMatchObject({id: 'B'});
  await a.bots.listConnections(); await b.bots.listConnections();
  expect(a.sessions.activeSessionId.value).toBe('A');
  expect(a.second.activeSessionId.value).toBe('A');
  expect(b.sessions.activeSessionId.value).toBe('B');
  expect(clientA.sessionId).toBe('A'); expect(clientB.sessionId).toBe('B');
  expect(transportA.request).toHaveBeenCalledTimes(3); expect(transportB.request).toHaveBeenCalledTimes(3);
  expect(fallback.request).not.toHaveBeenCalled();
});
it('does not restore main-window selection into an explicitly independent pet client', () => {
  const saved = storage(); saved.setItem('aervox_active_session_id', 'main-selected');
  const main = createAervoxClient({sessionStorage: saved});
  const pet = createAervoxClient({sessionId: 'web_default', sessionStorage: null});
  useAervoxSessions(main); useAervoxSessions(pet);
  expect(main.sessionId).toBe('main-selected'); expect(pet.sessionId).toBe('web_default');
});
