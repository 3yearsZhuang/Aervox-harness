import { sql } from "drizzle-orm";
import { practiceSessions, questionAttempts, questions } from "@aervox/schema";

const parse = <T>(value: string): T => JSON.parse(value) as T;

// JSON escaping keeps embedded NUL text intact across native SQLite row reads.
// These are the existing table rows, including nullable and legacy fields.
export const practiceQuestionRow = sql<string>`json_object(
  'id', ${questions.id}, 'sourceArtifactId', ${questions.sourceArtifactId}, 'knowledgeId', ${questions.knowledgeId},
  'prompt', ${questions.prompt}, 'answerSpec', json(${questions.answerSpec}), 'status', ${questions.status},
  'createdAt', ${questions.createdAt}, 'updatedAt', ${questions.updatedAt}
)`.mapWith(parse<typeof questions.$inferSelect>);

export const practiceSessionRow = sql<string>`json_object(
  'id', ${practiceSessions.id}, 'questionCount', ${practiceSessions.questionCount}, 'questionIds', json(${practiceSessions.questionIds}),
  'status', ${practiceSessions.status}, 'startedAt', ${practiceSessions.startedAt}, 'endedAt', ${practiceSessions.endedAt}
)`.mapWith(parse<typeof practiceSessions.$inferSelect>);

export const practiceAttemptRow = sql<string>`json_object(
  'id', ${questionAttempts.id}, 'sessionId', ${questionAttempts.sessionId}, 'questionId', ${questionAttempts.questionId},
  'answer', ${questionAttempts.answer}, 'judgement', ${questionAttempts.judgement}, 'evidence', json(${questionAttempts.evidence}),
  'idempotencyKey', ${questionAttempts.idempotencyKey}, 'difficulty', ${questionAttempts.difficulty},
  'hintCount', ${questionAttempts.hintCount}, 'timeSpentSec', ${questionAttempts.timeSpentSec}, 'createdAt', ${questionAttempts.createdAt}
)`.mapWith(parse<typeof questionAttempts.$inferSelect>);
