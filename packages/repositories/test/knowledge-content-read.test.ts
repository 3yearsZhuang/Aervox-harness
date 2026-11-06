import { afterEach, expect, it } from 'vitest';
import { createInMemoryDatabase, initDatabaseSchema, SqliteLearningRepository } from '../src/index.js';

const clients: Array<{close(): void}> = [];
afterEach(() => { clients.splice(0).forEach(client => client.close()); });

it('reads the complete persisted knowledge content and identity, including NUL text', async () => {
  const {db, client} = await createInMemoryDatabase();
  clients.push(client);
  await initDatabaseSchema(client);
  const repo = new SqliteLearningRepository(db);
  const ctx = {workspaceId: 'local', subjectUserId: 'local'};
  const id = 'knowledge\0identity';
  const concept = '二次方程\0求根公式\nα + β';
  await repo.createKnowledgeItem(ctx, {id, concept, sourceStatus: 'observed'});
  const stored = await client.execute({sql: 'SELECT hex(id) AS id_hex, hex(concept) AS concept_hex FROM knowledge_items WHERE id = ?', args: [id]});
  expect(stored.rows[0]?.concept_hex).toBe(Buffer.from(concept).toString('hex').toUpperCase());
  expect(await repo.getKnowledgeItem(ctx, id)).toMatchObject({id, concept, sourceStatus: 'observed'});
});

it('keeps NUL identities through due reads, completion replay and linked next dates after reopening', async () => {
  const {db, client} = await createInMemoryDatabase();
  clients.push(client);
  await initDatabaseSchema(client);
  const repo = new SqliteLearningRepository(db);
  const ctx = {workspaceId: 'local', subjectUserId: 'local'};
  const knowledgeId = 'knowledge\0id', reviewId = 'review\0id';
  await repo.createKnowledgeItem(ctx, {id: knowledgeId, concept: '概念\0正文'});
  await repo.createReviewItem(ctx, {id: reviewId, knowledgeId, dueAt: '2020-01-01T00:00:00.000Z'});
  expect(await repo.listDueReviewItems(ctx, '2026-01-01T00:00:00.000Z')).toMatchObject([{id: reviewId, knowledgeId}]);
  const derive = (item: {correctCount: number; wrongCount: number; correctStreak: number; masteryState: string}) => ({
    state: {correctCount: item.correctCount + 1, wrongCount: item.wrongCount, correctStreak: item.correctStreak + 1, mastery: 0.5, masteryState: 'reviewing', masteryBasis: null},
    review: {dueAt: '2027-01-02T12:00:00.000Z', intervalDays: 2, schedulerVersion: 2, timezoneSnapshot: 'Asia/Shanghai'},
  });
  const input = {reviewId, isCorrect: true, timeZone: 'Asia/Shanghai'};
  const first = await repo.completeReviewAndSchedule(ctx, input, derive);
  expect(first?.completed.id).toBe(reviewId);
  expect(first?.knowledge.concept).toBe('概念\0正文');
  const reopened = new SqliteLearningRepository(db);
  expect(await reopened.completeReviewAndSchedule(ctx, input, derive)).toEqual(first);
  expect(await reopened.listCompletedReviewItems(ctx)).toMatchObject([{
    id: reviewId, knowledgeId, completionIsCorrect: true, nextReviewId: first?.nextReview.id,
    nextReview: {id: first?.nextReview.id, knowledgeId, dueAt: '2027-01-02T12:00:00.000Z', schedulerVersion: 2},
  }]);
  expect((await reopened.getKnowledgeItem(ctx, knowledgeId))?.correctCount).toBe(1);
  await client.execute({sql: 'DELETE FROM knowledge_items WHERE id = ?', args: [knowledgeId]});
  expect(await reopened.listDueReviewItems(ctx, '2030-01-01T00:00:00.000Z')).toEqual([]);
  expect(await reopened.listCompletedReviewItems(ctx)).toEqual([]);
});
