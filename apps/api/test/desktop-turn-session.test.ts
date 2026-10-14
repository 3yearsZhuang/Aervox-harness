import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInMemoryDatabase, SqliteConversationRepository } from "@aervox/repositories";
import { turns } from "@aervox/schema";
import { buildApp } from "./app-fixture.js";
import { createDesktopTurnBridge } from "../../desktop/src/main/turn-bridge.js";

afterEach(() => vi.unstubAllEnvs());

it("main-process requests persist separate selected-session histories and project associations", async () => {
  vi.stubEnv("AERVOX_LOOP_PROVIDER", "replay");
  const database = await createInMemoryDatabase();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "avx-desktop-session-"));
  const { app } = await buildApp({ db: database.db, client: database.client, skillsRoot: path.join(root, "skills"), pluginsRoot: path.join(root, "plugins") });
  const requests: string[] = [];
  app.addHook("onRequest", async request => { if (request.method === "POST" && request.url.endsWith("/turns")) requests.push(request.url); });
  try {
    const apiBaseUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    const bridge = createDesktopTurnBridge({ apiBaseUrl, sessionId: () => "environment_default" });
    const messages: Array<Record<string, unknown>> = [];
    const sender = { isDestroyed: () => false, send: (_channel: string, message: Record<string, unknown>) => messages.push(message) };
    const repo = new SqliteConversationRepository(database.db);
    const local = { workspaceId: "local", subjectUserId: "local" };
    for (const name of ["A", "B"]) {
      const project = await app.inject({ method: "POST", url: "/v1/projects", payload: { name: `Project ${name}` } });
      expect(project.statusCode).toBe(201);
      const sessionId = `desktop_${name}`;
      const session = await app.inject({ method: "POST", url: "/v1/sessions", payload: { id: sessionId, projectId: project.json().id, title: name } });
      expect(session.statusCode).toBe(201);
      for (const sequence of [1, 2]) {
        await bridge.streamAervoxTurn({ sender }, { requestId: `desktop_${name}_${sequence}`, sessionId, content: `Only ${name} message ${sequence}` });
      }
      expect((await repo.getSession(local, sessionId))?.projectId).toBe(project.json().id);
      const storedTurns = (await database.db.select().from(turns)).filter(turn => turn.sessionId === sessionId);
      expect(storedTurns).toHaveLength(2);
      const history = await repo.getSessionHistory(local, { sessionId, beforeTurnId: storedTurns[1]!.id });
      expect(JSON.stringify(history)).toContain(`Only ${name} message 1`);
      expect(JSON.stringify(history)).not.toContain(`Only ${name === "A" ? "B" : "A"}`);
    }
    expect(requests).toEqual(["/v1/sessions/desktop_A/turns", "/v1/sessions/desktop_A/turns", "/v1/sessions/desktop_B/turns", "/v1/sessions/desktop_B/turns"]);
    expect(messages.filter(message => message.type === "closed")).toHaveLength(4);
    expect(messages.filter(message => message.type === "error")).toEqual([]);
    expect(await repo.getSession(local, "environment_default")).toBeNull();
    expect(bridge.activeTurnRequests.size).toBe(0);
  } finally {
    await app.close();
    await database.cleanup();
    await fs.rm(root, { recursive: true, force: true });
  }
});
