import Fastify from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createDatabase, initDatabaseSchema, SqliteLearningRepository } from '@aervox/repositories';
import { createFetchTransport, createReviewStore } from '@aervox/api-client';
import { registerLearningRoutes } from '@aervox/host-runtime-test/modules/learning/learning/routes';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

it('recovers a lost real HTTP completion once, and reopens its linked next date from SQLite', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aervox-review-client-'));
  cleanups.push(() => rm(directory, {recursive: true, force: true}));
  const url = `file:${join(directory, 'learning.db')}`;
  const database = await createDatabase({url});
  cleanups.push(async () => database.client.close());
  await initDatabaseSchema(database.client);
  const learning = new SqliteLearningRepository(database.db);
  const ctx = {workspaceId: 'local', subjectUserId: 'local'};
  await learning.createKnowledgeItem(ctx, {id: 'knowledge', concept: '求根公式\0完整正文', sourceStatus: 'observed'});
  await learning.createReviewItem(ctx, {id: 'review', knowledgeId: 'knowledge', dueAt: '2020-01-01T00:00:00.000Z', schedulerVersion: 2, timezoneSnapshot: 'Asia/Shanghai'});
  const app = Fastify();
  cleanups.push(() => app.close());
  registerLearningRoutes(app, learning);
  const base = createFetchTransport(await app.listen({host: '127.0.0.1', port: 0}));
  let dropReceipt = true;
  const transport = {...base, async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await base.request<T>(method, path, body);
    if (method === 'POST' && dropReceipt) { dropReceipt = false; throw new Error('committed receipt lost'); }
    return response;
  }};
  const store = createReviewStore(transport, 'Asia/Shanghai');
  await store.loadReviews();
  expect((await store.getKnowledgeItem('knowledge')).concept).toBe('求根公式\0完整正文');
  await expect(store.completeReview('review', false)).rejects.toThrow('committed receipt lost');
  await store.loadReviews();
  expect(store.dueReviews.value).toEqual([]);
  expect((await store.getKnowledgeItem('knowledge')).wrongCount).toBe(1);
  const receipt = await store.completeReview('review', false);
  expect(receipt.completed.id).toBe('review');
  expect(receipt.nextReview.schedulerVersion).toBe(2);
  expect((await learning.getKnowledgeItem(ctx, 'knowledge'))?.wrongCount).toBe(1);
  expect((await database.client.execute("SELECT count(*) AS count FROM outbox_events WHERE event_type = 'learning.review.completed'")).rows[0]?.count).toBe(1);
  await app.close();
  database.client.close();
  const reopenedDatabase = await createDatabase({url});
  cleanups.push(async () => reopenedDatabase.client.close());
  const reopenedApp = Fastify();
  cleanups.push(() => reopenedApp.close());
  const reopenedLearning = new SqliteLearningRepository(reopenedDatabase.db);
  registerLearningRoutes(reopenedApp, reopenedLearning);
  const reopenedTransport = createFetchTransport(await reopenedApp.listen({host: '127.0.0.1', port: 0}));
  const reopened = createReviewStore(reopenedTransport, 'Asia/Shanghai');
  await reopened.loadReviews();
  expect(reopened.completedReviews.value[0]).toMatchObject({completionIsCorrect: false, nextReviewId: receipt.nextReview.id,
    nextReview: {id: receipt.nextReview.id, dueAt: receipt.nextReview.dueAt, schedulerVersion: 2}});
  await reopened.completeReview(receipt.nextReview.id, true);
  const replay = await reopened.completeReview('review', false);
  expect(replay.nextReview).toMatchObject({id: receipt.nextReview.id, status: 'completed'});
  expect((await reopenedLearning.getKnowledgeItem(ctx, 'knowledge'))?.wrongCount).toBe(1);
  expect((await reopenedLearning.getKnowledgeItem(ctx, 'knowledge'))?.correctCount).toBe(1);
  expect((await reopenedDatabase.client.execute("SELECT count(*) AS count FROM outbox_events WHERE event_type = 'learning.review.completed'")).rows[0]?.count).toBe(2);
});
