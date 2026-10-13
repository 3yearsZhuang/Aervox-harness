import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = new URL("../native/protocol/runtime.json", import.meta.url);
const target = new URL("../packages/native-runtime/src/generated/protocol.ts", import.meta.url);
const contract = JSON.parse(readFileSync(source, "utf8"));
const keywords = new Set(["$ref", "type", "const", "enum", "properties", "required", "additionalProperties", "items", "maxItems", "minLength", "minimum", "maximum"]);

// Deliberately restricted JSON Schema vocabulary, also implemented by the Rust validator.
function typeOf(schema) {
  for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error(`Unsupported native schema keyword: ${key}`);
  if (schema.$ref) {
    const name = schema.$ref.replace(/^#\/\$defs\//u, "");
    if (!Object.hasOwn(contract.$defs, name)) throw new Error(`Unknown native schema: ${name}`);
    return name;
  }
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const);
  if (schema.enum) return schema.enum.map(value => JSON.stringify(value)).join(" | ");
  if (Array.isArray(schema.type)) return schema.type.map(type => typeOf({ ...schema, type })).join(" | ");
  switch (schema.type) {
    case "string": case "boolean": case "null": return schema.type;
    case "number": case "integer": return "number";
    case "array": return `Array<${typeOf(schema.items)}>`;
    case "object": {
      if (schema.additionalProperties && !schema.properties) return `Record<string, ${typeOf(schema.additionalProperties)}>`;
      const fields = Object.entries(schema.properties ?? {}).map(([key, value]) => `${JSON.stringify(key)}${schema.required?.includes(key) ? "" : "?"}: ${typeOf(value)}`);
      return fields.length ? `{ ${fields.join("; ")} }` : "Record<string, never>";
    }
    default: throw new Error(`Unsupported native schema type: ${schema.type}`);
  }
}

const types = Object.entries(contract.$defs).map(([name, schema]) => `export type ${name} = ${typeOf(schema)};`);
const methods = Object.entries(contract.methods).map(([name, schema]) => `  ${JSON.stringify(name)}: { params: ${typeOf(schema.params)}; result: ${typeOf(schema.result)} };`);
const output = `// Generated from native/protocol/runtime.json by scripts/generate-native-protocol.mjs.\n// Do not edit; run mise tasks run native-protocol-generate.\n\nexport const nativeContract = ${JSON.stringify(contract, null, 2)} as const;\n\n${types.join("\n")}\n\nexport type NativeError = (typeof nativeContract.errors)[number];\n\nexport interface NativeMethods {\n${methods.join("\n")}\n}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output) throw new Error("Native protocol types are stale; run mise tasks run native-protocol-generate");
} else {
  writeFileSync(target, output);
  console.log(`Generated ${fileURLToPath(target)}`);
}
