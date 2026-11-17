import { practiceSessions, questionAttempts, questions } from "@aervox/schema";
import { jsonObject, jsonValue } from "../../sql-dialect.js";

const parse = <T>(value: string): T => JSON.parse(value) as T;

// JSON escaping keeps embedded NUL text intact across native SQLite row reads.
// These are the existing table rows, including nullable and legacy fields.
export const practiceQuestionRow = (db: object) => jsonObject(db, [
  ["id", questions.id], ["sourceArtifactId", questions.sourceArtifactId], ["knowledgeId", questions.knowledgeId],
  ["prompt", questions.prompt], ["answerSpec", jsonValue(db, questions.answerSpec)], ["status", questions.status],
  ["createdAt", questions.createdAt], ["updatedAt", questions.updatedAt],
]).mapWith(parse<typeof questions.$inferSelect>);

export const practiceSessionRow = (db: object) => jsonObject(db, [
  ["id", practiceSessions.id], ["questionCount", practiceSessions.questionCount], ["questionIds", jsonValue(db, practiceSessions.questionIds)],
  ["status", practiceSessions.status], ["startedAt", practiceSessions.startedAt], ["endedAt", practiceSessions.endedAt],
]).mapWith(parse<typeof practiceSessions.$inferSelect>);

export const practiceAttemptRow = (db: object) => jsonObject(db, [
  ["id", questionAttempts.id], ["sessionId", questionAttempts.sessionId], ["questionId", questionAttempts.questionId],
  ["answer", questionAttempts.answer], ["judgement", questionAttempts.judgement], ["evidence", jsonValue(db, questionAttempts.evidence)],
  ["idempotencyKey", questionAttempts.idempotencyKey], ["difficulty", questionAttempts.difficulty],
  ["hintCount", questionAttempts.hintCount], ["timeSpentSec", questionAttempts.timeSpentSec], ["createdAt", questionAttempts.createdAt],
]).mapWith(parse<typeof questionAttempts.$inferSelect>);
