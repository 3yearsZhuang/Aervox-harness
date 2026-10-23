import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { registerConversationRoutes, type ConversationHttpPort } from "../src/modules/companion/conversation/routes.js";

it("adapts every HTTP conversation use case with only a fake application Port", async () => {
  const session = { id: "session", title: "Session" };
  const message = { id: "message", sessionId: "session", role: "user" };
  const commands = {
    ensureSession: vi.fn(async () => session), createSession: vi.fn(async () => session), renameSession: vi.fn(async () => session),
    deleteSession: vi.fn(async () => true), createTurn: vi.fn(async () => ({ created: true, turn: { id: "turn" } })),
    cancelTurn: vi.fn(async () => ({ turnId: "turn", status: "CancelRequested", cancelled: true })),
    answerQuestions: vi.fn(async () => ({ accepted: true })), approve: vi.fn(async () => ({ approvalId: "approval", state: "granted" })),
    createMessage: vi.fn(async () => message), editMessage: vi.fn(async () => ({ message, newVersion: { id: "version" } })),
    deleteMessage: vi.fn(async () => ({ ...message, deletedAt: "2026-10-24" })), restoreMessage: vi.fn(async () => message),
  };
  const queries = {
    getTurnDiagnostics: vi.fn(async () => null), listSessions: vi.fn(async () => [session]),
    pendingQuestions: vi.fn(async () => null), subagents: vi.fn(async () => []), workflows: vi.fn(() => []),
    messageDeleteImpact: vi.fn(async () => ({ messageId: "message", impacts: [], totalAffected: 0 })),
    listMessageVersions: vi.fn(async () => []), getTurn: vi.fn(async () => ({ id: "turn" })),
    getStreamEventById: vi.fn(async () => null), getStreamEventHighWater: vi.fn(async () => 1),
    getStreamReplayState: vi.fn(async () => ({ highWaterSequence: 1, settled: true })),
    getStreamEventsPage: vi.fn(async () => ({ events: [{ id: "event", turnId: "turn", sequence: 1, eventType: "done", data: { status: "Completed", isComplete: true } }], persistedDataBytes: 20, oversizedEvent: false })),
  };
  const app = Fastify();
  // Neither a SQLite repository nor product execution dependencies are available to the HTTP adapter.
  registerConversationRoutes(app, { commands, queries } as unknown as ConversationHttpPort);
  try {
    const cases: Array<{ method: "GET" | "POST" | "PATCH" | "DELETE"; url: string; payload?: unknown; status: number }> = [
      { method: "GET", url: "/v1/turns/turn/diagnostics", status: 404 },
      { method: "GET", url: "/v1/sessions", status: 200 },
      { method: "POST", url: "/v1/sessions", payload: { title: "Session" }, status: 201 },
      { method: "POST", url: "/v1/sessions", payload: { id: "session", title: "Session" }, status: 201 },
      { method: "PATCH", url: "/v1/sessions/session", payload: { title: "Renamed" }, status: 200 },
      { method: "DELETE", url: "/v1/sessions/session", status: 204 },
      { method: "POST", url: "/v1/sessions/session/turns", payload: { message: { content: "hello", contentType: "text" }, clientVersion: "port" }, status: 201 },
      { method: "POST", url: "/v1/turns/turn/cancel", status: 200 },
      { method: "POST", url: "/v1/turns/turn/questions/answers", payload: { answers: [{ id: "question", selectedOptions: ["yes"] }] }, status: 200 },
      { method: "GET", url: "/v1/turns/turn/questions/pending", status: 200 },
      { method: "POST", url: "/v1/turns/turn/tool-approvals", payload: { approvalId: "approval", decision: "granted" }, status: 200 },
      { method: "GET", url: "/v1/turns/turn/subagents", status: 200 },
      { method: "GET", url: "/v1/workflows", status: 200 },
      { method: "POST", url: "/v1/messages", payload: { sessionId: "session", role: "user" }, status: 201 },
      { method: "PATCH", url: "/v1/messages/message", payload: { content: "edited", expectedVersion: 1 }, status: 200 },
      { method: "DELETE", url: "/v1/messages/message", status: 200 },
      { method: "GET", url: "/v1/messages/message/delete-impact", status: 200 },
      { method: "POST", url: "/v1/messages/message/restore", status: 200 },
      { method: "GET", url: "/v1/messages/message/versions", status: 200 },
      { method: "GET", url: "/v1/turns/turn/events", status: 200 },
    ];
    for (const test of cases) {
      const response = await app.inject(test);
      expect(response.statusCode, `${test.method} ${test.url}: ${response.body}`).toBe(test.status);
    }
    for (const command of Object.values(commands)) expect(command).toHaveBeenCalled();
    expect(queries.getStreamEventsPage).toHaveBeenCalled();
  } finally { await app.close(); }
});
