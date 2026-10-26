import { describe, expect, it, vi } from "vitest";
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { ConversationExecutionStore, type ConversationExecutionRepositoryPort } from "../src/browser.js";
import { SqliteExecutionStore } from "../src/sqlite-execution-store.js";
import { FencingMismatchError, SqliteConversationRepository } from "@aervox/repositories";
import { LeaseLostError } from "@aervox/core";

const root = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
function publicSource(condition: "default" | "types"): string {
  const target = manifest.exports["./browser"][condition] as string;
  if (!/^\.\/dist\/[\w-]+\.(?:d\.ts|js)$/.test(target)) throw new Error("unexpected browser entry target");
  return join(root, target.replace("./dist/", "src/").replace(/\.(?:d\.ts|js)$/, ".ts"));
}

describe("neutral repository execution adaptation", () => {
  it("bundles its complete public entry without Node, drivers or Vue and preserves inherited/proxied use", async () => {
    const result = await build({
      entryPoints: [publicSource("default")], bundle: true, platform: "browser",
      format: "iife", globalName: "AervoxBrowserHost", treeShaking: false,
      write: false, metafile: true, logLevel: "silent",
    });
    expect(Object.keys(result.metafile!.inputs).filter(file => /repositories|libsql|drizzle|vue|cli-approval/.test(file))).toEqual([]);
    expect(Object.values(result.metafile!.outputs).flatMap(output => output.imports)).toEqual([]);
    const context = createContext({ AbortController, AbortSignal, TextEncoder, TextDecoder, crypto: globalThis.crypto,
      performance, structuredClone, setTimeout, clearTimeout, setInterval, clearInterval });
    runInContext(result.outputFiles![0]!.text, context);
    expect(runInContext("typeof process + ':' + typeof require + ':' + typeof Buffer", context)).toBe("undefined:undefined:undefined");
    const observed = await runInContext(`(async () => {
      const ctx = { local: 'native-host' };
      const calls = [];
      const repo = {
        getTurn: async (owner, id) => { calls.push(owner === ctx && id === 'turn'); return { lastSequence: 20 }; },
        getStreamEventHighWater: async () => 2,
        appendStreamEvent: async (owner, event) => { calls.push(owner === ctx); return { ...event, payloadVersion: 1 }; },
        recordSafeSegmentsAtomically: async (owner, segments) => { calls.push(owner === ctx && segments.length === 1); return false; },
      };
      const store = new AervoxBrowserHost.ConversationExecutionStore(repo, ctx);
      const inherited = Object.create(store);
      const proxy = new Proxy(inherited, { get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
      const next = await proxy.nextSequence('turn');
      const event = await proxy.appendEvent({ turnId: 'turn', attemptId: 'attempt', sequence: next,
        eventType: 'message', data: { text: 'hello' }, safetyDecision: 'approved', expectedFencingToken: 7 });
      const batch = await proxy.recordSafeSegments([{ turnId: 'turn', attemptId: 'attempt', sequence: next + 1,
        text: 'prefix', eventData: { text: 'prefix' }, safetyDecision: 'approved', expectedFencingToken: 7 }]);
      return { next, eventId: event.eventId, fencing: event.expectedFencingToken, batch: batch.ok, calls };
    })()`, context);
    expect(observed).toMatchObject({ next: 21, eventId: "tev_turn_21", batch: false, calls: [true, true, true] });
  });

  it("typechecks the built public declaration closure against DOM APIs without ambient Node types", () => {
    const dir = mkdtempSync(join(tmpdir(), "aervox-host-browser-types-"));
    try {
      const config = join(dir, "tsconfig.json");
      writeFileSync(config, JSON.stringify({ compilerOptions: {
        target: "ES2023", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
        noUncheckedIndexedAccess: true, noEmit: true, types: [], lib: ["ES2023", "DOM", "DOM.Iterable"],
      }, files: [join(root, manifest.exports["./browser"].types)] }));
      execFileSync(process.execPath, [fileURLToPath(new URL("../../../node_modules/typescript/bin/tsc", import.meta.url)), "-p", config], { stdio: "pipe" });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it.each(["appendEvent", "recordSafeSegment", "recordSafeSegments", "recordToolOutcome"] as const)(
    "%s preserves unknown errors without an injected classifier and production recognizes only its actual repository class", async method => {
      const counterfeit = new Error("not a repository error"); counterfeit.name = "FencingMismatchError";
      const repositoryMethod = { appendEvent: "appendStreamEvent", recordSafeSegment: "recordSafeSegmentAtomically",
        recordSafeSegments: "recordSafeSegmentsAtomically", recordToolOutcome: "recordToolOutcomeAtomically" } as const;
      const operation = repositoryMethod[method];
      const repo = { [operation]: async () => { throw counterfeit; } } as unknown as ConversationExecutionRepositoryPort<object>;
      const input = { turnId: "turn", attemptId: "attempt", sequence: 1, text: "text", data: {}, eventData: {},
        safetyDecision: "approved" as const, expectedFencingToken: 1, invocationId: "call", name: "tool",
        arguments: {}, status: "executed" as const, startedAt: "time", eventType: "delta" as const };
      const neutral = new ConversationExecutionStore(repo, {});
      const invoke = (store: ConversationExecutionStore<object>) => method === "recordSafeSegments"
        ? store.recordSafeSegments([input]) : store[method](input);
      await expect(invoke(neutral)).rejects.toBe(counterfeit);
      // The old wrapper retains the exact class comparison; a matching name is
      // insufficient and arbitrary failures cannot turn into a lease result.
      const productionRepo = Object.create(SqliteConversationRepository.prototype) as SqliteConversationRepository;
      const spy = vi.spyOn(productionRepo, operation).mockRejectedValue(counterfeit);
      const production = new SqliteExecutionStore(productionRepo, { workspaceId: "local", subjectUserId: "local" });
      await expect(invoke(production)).rejects.toBe(counterfeit);
      spy.mockRejectedValue(new FencingMismatchError("fenced"));
      await expect(invoke(production)).rejects.toBeInstanceOf(LeaseLostError);
      spy.mockRestore();
      expect(SqliteExecutionStore.prototype[method]).toBe(ConversationExecutionStore.prototype[method]);
    },
  );
});
