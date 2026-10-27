import { describe, expect, it, vi } from "vitest";
import type { PluginHostServices, PluginHttpRequest } from "@aervox/host-plugin-api";
import { buildOpenApiDocument, type PluginApiContribution, type PluginApiRegistry } from "@aervox/contracts";
import { createFlowCampusEndpoints, createFlowCampusToolContributions, campusToolResultSchema, registerFlowCampusApiContract } from "../src/server/index.js";
import { campusFixture, NOW } from "./domain-fixtures.js";

function host(initial: unknown = campusFixture()) {
  let values: Record<string, unknown> = initial === undefined ? {} : { state: initial };
  let revision = 2; let lifecycleGeneration = "generation_1";
  const configuration = {
    read: vi.fn(async () => ({ values: structuredClone(values), revision, lifecycleGeneration })),
    save: vi.fn(async (input: { values: Record<string, unknown>; expectedRevision: number; expectedLifecycleGeneration: string }) => {
      if (input.expectedRevision !== revision) throw Object.assign(new Error("host details"), { code: "plugin_config_revision_conflict" });
      if (input.expectedLifecycleGeneration !== lifecycleGeneration) throw Object.assign(new Error("host details"), { code: "plugin_config_lifecycle_changed" });
      values = structuredClone(input.values); revision += 1;
      return { values: structuredClone(values), revision, lifecycleGeneration };
    }),
  };
  return { services: { configuration } as unknown as PluginHostServices, configuration,
    changeLifecycle: () => { lifecycleGeneration = "generation_2"; } };
}
const request = (body: unknown = undefined, query: Record<string, string> = {}): PluginHttpRequest => ({ params: {}, query, body });
const endpoints = () => createFlowCampusEndpoints(() => new Date(NOW));
const invoke = (method: "GET" | "PUT", path: "state" | "plan", services: PluginHostServices, body?: unknown, query?: Record<string, string>) =>
  endpoints().find(endpoint => endpoint.method === method && endpoint.path.endsWith(`/${path}`))!.handler(request(body, query), services);

describe("campus host-backed HTTP", () => {
  it("reads a snapshot and calculates the same revision without any writes", async () => {
    const h = host();
    const response = await invoke("GET", "plan", h.services);
    expect(response.payload).toMatchObject({ revision: 2, lifecycleGeneration: "generation_1", plan: { freeMinutes: 16 } });
    expect(h.configuration.read).toHaveBeenCalledTimes(1); expect(h.configuration.save).not.toHaveBeenCalled();
  });
  it("returns an empty state without silently seeding or saving", async () => {
    const h = host(null); h.configuration.read.mockResolvedValueOnce({ values: {}, revision: 0, lifecycleGeneration: "generation_1" });
    const response = await invoke("GET", "state", h.services);
    expect(response.payload).toMatchObject({ state: { places: [], events: [], tasks: [] }, revision: 0 });
    expect(h.configuration.save).not.toHaveBeenCalled();
  });
  it("CAS-saves the validated document and returns the actual new snapshot", async () => {
    const h = host(); const state = campusFixture(); state.tasks[0]!.status = "done";
    const response = await invoke("PUT", "state", h.services, { state, expectedRevision: 2, expectedLifecycleGeneration: "generation_1" });
    expect(response.payload).toMatchObject({ revision: 3, state });
    expect(h.configuration.save).toHaveBeenCalledTimes(1);
    expect((await invoke("GET", "state", h.services)).payload).toMatchObject({ revision: 3, state });
  });
  it("does not present a durable revision missing its document as empty data", async () => {
    const h = host(null);
    h.configuration.read.mockResolvedValueOnce({ values: {}, revision: 7, lifecycleGeneration: "generation_1" });
    expect(await invoke("GET", "state", h.services)).toMatchObject({ status: 409, payload: { code: "campus_stored_state_invalid" } });
    expect(h.configuration.save).not.toHaveBeenCalled();
  });
  it("rejects stale revisions and lifecycle generations", async () => {
    const h = host(); const body = { state: campusFixture(), expectedRevision: 1, expectedLifecycleGeneration: "generation_1" };
    expect(await invoke("PUT", "state", h.services, body)).toMatchObject({ status: 409, payload: { code: "plugin_config_revision_conflict" } });
    h.changeLifecycle(); body.expectedRevision = 2;
    expect(await invoke("PUT", "state", h.services, body)).toMatchObject({ status: 409, payload: { code: "plugin_config_lifecycle_changed" } });
  });
  it.each([
    ["plugin_configuration_conflict", 409], ["plugin_configuration_invalid", 400], ["plugin_configuration_unavailable", 503],
  ])("maps the host's %s fault without exposing diagnostics", async (code, status) => {
    const h = host(); h.configuration.save.mockRejectedValueOnce(Object.assign(new Error("private repository diagnostic"), { code, status }));
    const response = await invoke("PUT", "state", h.services, { state: campusFixture(), expectedRevision: 2, expectedLifecycleGeneration: "generation_1" });
    expect(response).toMatchObject({ status, payload: { code } });
    expect(JSON.stringify(response.payload)).not.toContain("private repository diagnostic");
  });
  it("leaves unknown infrastructure failures to the host", async () => {
    const h = host(); h.configuration.read.mockRejectedValueOnce(new Error("storage failed"));
    await expect(invoke("GET", "state", h.services)).rejects.toThrow("storage failed");
  });
  it("rejects dangling references before touching the host", async () => {
    const h = host(); const state = campusFixture(); state.places = [];
    expect(await invoke("PUT", "state", h.services, { state, expectedRevision: 2, expectedLifecycleGeneration: "generation_1" })).toMatchObject({ status: 400, payload: { code: "campus_state_invalid" } });
    expect(h.configuration.save).not.toHaveBeenCalled();
  });
  it("keeps route failures local to the planning result", async () => {
    const state = campusFixture(); state.routes = []; const h = host(state);
    expect((await invoke("GET", "plan", h.services)).payload).toMatchObject({ plan: { departureStatus: "route_unavailable", nextEvent: { id: "math" } } });
    expect((await invoke("GET", "state", h.services)).payload).toMatchObject({ state: { tasks: state.tasks, events: state.events } });
  });
  it("rejects timezone-free queries and unknown parameters", async () => {
    const h = host();
    expect(await invoke("GET", "plan", h.services, undefined, { at: "2026-10-26T08:00:00" })).toMatchObject({ status: 400 });
    expect(await invoke("GET", "plan", h.services, undefined, { url: "https://external.example" })).toMatchObject({ status: 400 });
    expect(h.configuration.read).not.toHaveBeenCalled();
  });
  it("fails closed for unavailable storage or malformed saved data", async () => {
    expect(await invoke("GET", "state", {} as PluginHostServices)).toMatchObject({ status: 503, payload: { code: "campus_storage_unavailable" } });
    const h = host({ version: 9 });
    expect(await invoke("GET", "state", h.services)).toMatchObject({ status: 409, payload: { code: "campus_stored_state_invalid" } });
    expect(h.configuration.save).not.toHaveBeenCalled();
  });
});

describe("read-only model contribution", () => {
  const input = (argumentsValue: unknown = {}) => ({ name: "get_campus_plan", arguments: argumentsValue, turnId: "turn", attemptId: "attempt", invocationId: "call" });
  it("uses one snapshot and omits coordinates, addresses and lifecycle credentials", async () => {
    const state = campusFixture(); state.places[0]!.coords = { latitude: 31, longitude: 121, coordinateSystem: "gcj02" };
    const h = host(state); const tool = createFlowCampusToolContributions(h.services, () => new Date(NOW))[0]!;
    expect(tool.provider.tools[0]!.readOnly).toBe(true);
    const result = await tool.provider.execute(input());
    expect(result).toMatchObject({ ok: true, output: { revision: 2, freeMinutes: 16, route: { source: "manual" } } });
    expect(campusToolResultSchema.safeParse(result.output).success).toBe(true);
    expect(JSON.stringify(result.output)).not.toMatch(/coords|address|lifecycleGeneration/);
    expect(h.configuration.read).toHaveBeenCalledTimes(1); expect(h.configuration.save).not.toHaveBeenCalled();
  });
  it.each([{ at: NOW }, { delete: true }, null])("rejects all nonempty or invalid arguments %j", async args => {
    const h = host(); const tool = createFlowCampusToolContributions(h.services)[0]!;
    expect(await tool.provider.execute(input(args))).toMatchObject({ ok: false, error: "campus_invalid_tool_arguments" });
    expect(h.configuration.read).not.toHaveBeenCalled();
  });
  it("limits lists while retaining counts and the total budget", async () => {
    const state = campusFixture(); state.tasks = Array.from({ length: 20 }, (_, index) => ({ id: `task_${index}`, title: "小任务", estimatedMinutes: 1, priority: "high" as const, status: "pending" as const }));
    const h = host(state); const tool = createFlowCampusToolContributions(h.services, () => new Date(NOW))[0]!;
    const result = await tool.provider.execute(input());
    expect(result.output).toMatchObject({ recommendedTaskCount: 16, totalRecommendedMinutes: 16 });
    expect(campusToolResultSchema.parse(result.output).recommendedTasks).toHaveLength(8);
  });
  it("does not read after cancellation or execute an unregistered tool", async () => {
    const h = host(); const tool = createFlowCampusToolContributions(h.services)[0]!; const controller = new AbortController(); controller.abort();
    expect(await tool.provider.execute({ ...input(), signal: controller.signal })).toMatchObject({ ok: false, error: "operation_cancelled" });
    expect(await tool.provider.execute({ ...input(), name: "delete_all" })).toMatchObject({ ok: false, error: "unregistered_tool" });
    expect(h.configuration.read).not.toHaveBeenCalled();
  });
  it("registers only its three API operations and returns the host disposer", () => {
    const off = vi.fn(); const registerPluginApiContribution = vi.fn((_contribution: PluginApiContribution) => off);
    expect(registerFlowCampusApiContract({ registerPluginApiContribution })).toBe(off);
    const contribution = registerPluginApiContribution.mock.calls[0]![0];
    expect(contribution.openApiRoutes!.map((route: { method: string; path: string }) => `${route.method}:${route.path}`))
      .toEqual(endpoints().map(endpoint => `${endpoint.method.toLowerCase()}:${endpoint.path}`));
  });
  it("validates actual success payloads against every declared OpenAPI response and generates schemas", async () => {
    const contributions: PluginApiContribution[] = [];
    registerFlowCampusApiContract({ registerPluginApiContribution: contribution => { contributions.push(contribution); return () => undefined; } });
    const routes = contributions[0]!.openApiRoutes!;
    const h = host();
    for (const route of routes) {
      const endpoint = endpoints().find(item => item.method.toLowerCase() === route.method && item.path === route.path)!;
      const body = route.method === "put" ? { state: campusFixture(), expectedRevision: 2, expectedLifecycleGeneration: "generation_1" } : undefined;
      const response = await endpoint.handler(request(body), h.services);
      expect(route.responses[200]!.schema!.safeParse(response.payload).success).toBe(true);
    }
    const registry = { getPluginApiRevision: () => 1, getPluginOpenApiRoutes: () => routes } as PluginApiRegistry;
    const document = buildOpenApiDocument(registry);
    for (const route of routes) {
      const operation = document.paths![route.path]![route.method];
      expect(operation?.responses?.["200"]).toHaveProperty("content.application/json.schema");
    }
    expect(JSON.stringify(document.paths!["/v1/plugins/flowcampus/state"]!.put)).toContain("expectedLifecycleGeneration");
    expect(JSON.stringify(document.paths!["/v1/plugins/flowcampus/plan"]!.get)).toContain("route_unavailable");
  });
});
