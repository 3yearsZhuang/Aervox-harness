import { describe, expect, it } from "vitest";
import { parseConfigSchema, validateValues } from "@aervox/host-runtime-test/modules/ecosystem/plugins/config-schema";

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

describe("structured configuration values", () => {
  const fields = parseConfigSchema(schema([{ key: "state", type: "object", label: "State", children: [
    { key: "places", type: "array", label: "Places", items: { key: "entry", type: "object", label: "Place", required: true, children: [
      { key: "name", type: "string", label: "Name", required: true },
      { key: "days", type: "array", label: "Days", items: { key: "day", type: "integer", label: "Day", required: true } },
    ] } },
  ] }]));

  it("preserves complete object entries and nested scalar arrays while removing undeclared keys", () => {
    const result = validateValues(fields, { state: { places: [{ name: "Library", days: [1, 3], undeclared: "drop" }] } });
    expect(result.issues).toEqual([]);
    expect(result.values).toEqual({ state: { places: [{ name: "Library", days: [1, 3] }] } });
  });

  it.each([null, 1, "text", []])("rejects malformed object array entries: %j", entry => {
    const result = validateValues(fields, { state: { places: [entry] } });
    expect(result.issues).toContainEqual(expect.objectContaining({ key: "state.places[0]", code: "TYPE" }));
  });

  it("validates required object children rather than silently erasing an array entry", () => {
    const result = validateValues(fields, { state: { places: [{ days: [1] }] } });
    expect(result.issues).toContainEqual(expect.objectContaining({ key: "state.places[0].entry.name", code: "REQUIRED" }));
  });

  it.each([null, 1, "text", []])("rejects malformed optional objects: %j", state => {
    expect(validateValues(fields, { state }).issues).toContainEqual(expect.objectContaining({ key: "state", code: "TYPE" }));
  });
});
