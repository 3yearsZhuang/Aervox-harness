import { describe, expect, it } from "vitest";
import { parseConfigSchema } from "@aervox/host-runtime-test/modules/ecosystem/plugins/config-schema";

const schema = (fields: unknown[]) => ({ apiVersion: "aervox.dev/v1", kind: "PluginConfigSchema", schemaVersion: 1, fields });
describe("configuration registration author checks", () => {
  it("rejects duplicate keys before configuration registration", () => {
    expect(() => parseConfigSchema(schema([
      { key: "enabled", label: "Enabled", type: "boolean" },
      { key: "enabled", label: "Enabled again", type: "string" },
    ]))).toThrow(/Duplicate sibling/);
  });
  it("rejects secret defaults and malformed validation patterns", () => {
    expect(() => parseConfigSchema(schema([{ key: "token", label: "Token", type: "secret", default: "embedded credential" }]))).toThrow(/Secret defaults/);
    expect(() => parseConfigSchema(schema([{ key: "name", label: "Name", type: "string", validation: { pattern: "[" } }]))).toThrow(/Invalid regular expression/);
  });
});
