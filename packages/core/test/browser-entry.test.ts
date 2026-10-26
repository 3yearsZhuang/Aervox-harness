import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import * as browser from "../src/browser.js";
import * as node from "../src/index.js";
import * as lightweight from "../src/core.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
// Exercise the source that emits the public JS/declaration targets, without
// requiring dist or mutating another build's output during unit tests.
function publicSource(condition: "default" | "types"): string {
  const target = manifest.exports["./browser"][condition] as string;
  if (!/^\.\/dist\/[\w-]+\.(?:d\.ts|js)$/.test(target)) throw new Error("unexpected browser entry target");
  return join(root, target.replace("./dist/", "src/").replace(/\.(?:d\.ts|js)$/, ".ts"));
}

describe("browser public entry", () => {
  it("retains all neutral public exports while preserving terminal entry compatibility", () => {
    expect(Object.keys(browser).sort()).toEqual(Object.keys(node).filter(name => name !== "CliInteractiveApprovalPolicy").sort());
    expect(browser).not.toHaveProperty("CliInteractiveApprovalPolicy");
    expect(lightweight.CliInteractiveApprovalPolicy).toBe(node.CliInteractiveApprovalPolicy);
    for (const [name, value] of Object.entries(lightweight)) {
      if (name === "CliInteractiveApprovalPolicy") continue;
      expect(node, `existing ./core export ${name}`).toHaveProperty(name, value);
      expect(browser, `existing ./core export ${name}`).toHaveProperty(name, value);
    }
  });

  it("bundles the whole public surface for a browser and executes a turn without Node globals", async () => {
    const result = await build({
      entryPoints: [publicSource("default")], bundle: true, platform: "browser",
      format: "iife", globalName: "AervoxBrowserCore", treeShaking: false,
      write: false, metafile: true, logLevel: "silent",
    });
    expect(Object.keys(result.metafile!.inputs).some(file => file.endsWith("cli-approval.ts"))).toBe(false);
    expect(Object.values(result.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
    const context = createContext({
      AbortController, AbortSignal, TextEncoder, TextDecoder, crypto: globalThis.crypto,
      performance, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval,
    });
    runInContext(result.outputFiles![0]!.text, context);
    expect(runInContext("typeof process + ':' + typeof require + ':' + typeof Buffer", context)).toBe("undefined:undefined:undefined");
    const turn = await runInContext(`(async () => {
      const core = AervoxBrowserCore;
      const store = new core.InMemoryExecutionStore();
      store.seedAttempt({ id: "attempt", turnId: "turn" });
      return core.executeTurn({
        execution: store, contextBuilder: core.defaultContextBuilder,
        provider: { id: "browser-fixture", async *stream() {
          yield { text: "browser turn", isFinal: false };
          yield { text: "", isFinal: true };
        } },
      }, { turnId: "turn", attemptId: "attempt", sessionId: "session", userMessage: "hello" });
    })()`, context);
    expect(turn.status, JSON.stringify(turn)).toBe("completed");
  });

  it("typechecks the public declaration closure against Web APIs without ambient Node types", () => {
    const dir = mkdtempSync(join(tmpdir(), "aervox-core-browser-types-"));
    try {
      const config = join(dir, "tsconfig.json");
      writeFileSync(config, JSON.stringify({
        compilerOptions: {
          target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext",
          strict: true, noUncheckedIndexedAccess: true, noEmit: true, types: [],
          lib: ["ES2023", "DOM", "DOM.Iterable"],
        },
        files: [publicSource("types")],
      }));
      execFileSync(process.execPath, [fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)), "-p", config], { stdio: "pipe" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
