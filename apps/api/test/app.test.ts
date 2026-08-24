import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { SkillRecord } from "@aervox/skill-runtime";
import type { McpTool } from "@aervox/mcp-port";
import type { VoiceProviderPort } from "@aervox/voice-port";

function makeSkill(name: string): SkillRecord {
  const markdown = `---\nname: ${name}\ndescription: ${name} description\n---\n\nUse ${name}.`;
  return {
    id: name,
    workspaceId: "workspace_demo",
    name,
    description: `${name} description`,
    source: "active",
    version: 1,
    checksum: "a".repeat(64),
    enabled: true,
    valid: true,
    validationErrors: [],
    files: { "SKILL.md": new TextEncoder().encode(markdown) },
    skillMarkdown: markdown,
    importedAt: new Date().toISOString(),
  };
}

const tool: McpTool = {
  id: "server:tool",
  serverId: "server",
  name: "tool",
  inputSchema: {},
  scopes: [],
  healthy: true,
  authorized: true,
  revoked: false,
  killSwitch: false,
};

describe("Persona API", () => {
  it("creates, activates, snapshots Persona context on Turns, and exports Skills", async () => {
    const app = buildApp({ seedSkills: [makeSkill("alpha"), makeSkill("beta")], seedMcpTools: [tool] });
    const headers = { "x-workspace-id": "w", "x-subject-user-id": "u" };

    const created = await app.inject({
      method: "POST",
      url: "/v1/personas",
      headers,
      payload: { name: "Tutor", config: { systemPromptAppend: "Be concise", allowedSkillNames: ["alpha"], allowedMcpToolIds: [] } },
    });
    expect(created.statusCode).toBe(201);
    const persona = created.json().persona;

    const activated = await app.inject({ method: "POST", url: `/v1/personas/${persona.id}/activate`, headers, payload: {} });
    expect(activated.statusCode).toBe(200);

    const turn = await app.inject({
      method: "POST",
      url: "/v1/sessions/session-1/turns",
      headers: { ...headers, "idempotency-key": "turn-key-1" },
      payload: { message: { content: "hello", contentType: "text" }, clientVersion: "test" },
    });
    expect(turn.statusCode).toBe(201);
    const context = await app.inject({ method: "GET", url: `/v1/turns/${turn.json().turnId}/context`, headers });
    expect(context.json().skillNames).toEqual(["alpha"]);
    expect(context.json().mcpToolIds).toEqual([]);
    expect(context.json().contextSnapshot.personaId).toBe(persona.id);

    const exported = await app.inject({ method: "POST", url: `/v1/personas/${persona.id}/export`, headers });
    expect(exported.statusCode).toBe(200);
    expect(exported.json().skillNames).toEqual(["alpha"]);
    expect(exported.json().bundleBase64).toBeTruthy();

    const imported = await app.inject({
      method: "POST",
      url: "/v1/personas/import",
      headers,
      payload: { bundleBase64: exported.json().bundleBase64, conflictResolution: "error" },
    });
    expect(imported.statusCode).toBe(201);
    expect(imported.json().skills.map((skill: { name: string }) => skill.name)).toEqual(["alpha"]);
    await app.close();
  });

  it("routes voice synthesis through the configured provider", async () => {
    const provider: VoiceProviderPort = {
      id: "voice-test",
      kind: "gpt-sovits-remote",
      async listModels() { return []; },
      async healthCheck() { return { status: "healthy" }; },
      async synthesize(request) { return { providerId: "voice-test", modelId: request.modelId, contentType: "audio/wav", bytes: new Uint8Array([1, 2, 3]), generatedAt: new Date().toISOString() }; },
    };
    const app = buildApp({ voiceProviders: [provider] });
    const response = await app.inject({ method: "POST", url: "/v1/voice/synthesize", payload: { providerId: "voice-test", text: "hello", modelId: "m" } });
    expect(response.statusCode).toBe(200);
    expect(response.json().audioBase64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    await app.close();
  });

  it("uses idempotency for duplicate Turn creation", async () => {
    const app = buildApp();
    const request = { method: "POST" as const, url: "/v1/sessions/session-1/turns", headers: { "idempotency-key": "same" }, payload: { message: { content: "hello", contentType: "text" }, clientVersion: "test" } };
    const first = await app.inject(request);
    const second = await app.inject(request);
    expect(first.json().turnId).toBe(second.json().turnId);
    await app.close();
  });
});
