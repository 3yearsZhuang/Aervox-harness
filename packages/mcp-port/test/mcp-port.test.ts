import { describe, expect, it } from "vitest";
import { selectMcpTools, type McpTool } from "../src/index.js";

const tools: McpTool[] = [
  { id: "server-a:one", serverId: "server-a", name: "one", inputSchema: {}, scopes: [], healthy: true, authorized: true, revoked: false, killSwitch: false },
  { id: "server-a:two", serverId: "server-a", name: "two", inputSchema: {}, scopes: [], healthy: true, authorized: true, revoked: false, killSwitch: false },
];

describe("MCP persona policy", () => {
  it("enables all eligible tools when persona list is undefined", () => {
    expect(selectMcpTools({ tools }).tools.map((tool) => tool.id)).toEqual(["server-a:one", "server-a:two"]);
  });
  it("disables all tools for an empty list", () => {
    expect(selectMcpTools({ tools, allowedMcpToolIds: [] }).tools).toHaveLength(0);
  });
  it("filters a non-empty allowlist and applies safety intersection", () => {
    const result = selectMcpTools({ tools, allowedMcpToolIds: ["server-a:one"], safetyAllowedToolIds: new Set() });
    expect(result.tools).toHaveLength(0);
    expect(result.excluded).toEqual([{ id: "server-a:one", reason: "safety_policy" }, { id: "server-a:two", reason: "persona_allowlist" }]);
  });
});
