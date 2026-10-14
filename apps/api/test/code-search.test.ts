import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { CODE_SEARCH_LIMITS, RipgrepCodeSearch } from "../src/modules/ecosystem/mcp/code-search.js";
import { DshMcpBridge } from "../src/modules/ecosystem/mcp/dsh-bridge.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "aervox-code-search-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function input(query = "needle") {
  return { root, path: ".", query, caseSensitive: false, maxResults: 50 };
}

function fakeProcess(ignoreTerm = false) {
  const events = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn((signal: string) => {
    if (!ignoreTerm || signal === "SIGKILL") queueMicrotask(() => events.emit("close", null));
    return true;
  });
  const child = Object.assign(events, { stdin, stdout, stderr, kill }) as unknown as ChildProcessWithoutNullStreams;
  return { child, stdout, stderr, kill, close: (code: number) => events.emit("close", code) };
}

function match(line = 1, content = "needle", path = "./file.txt") {
  return JSON.stringify({ type: "match", data: { path: { text: path }, lines: { text: `${content}\n` }, line_number: line } }) + "\n";
}

describe("bundled ripgrep search", () => {
  it("matches literal text with line numbers, Unicode, case controls and subdirectories", async () => {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/a.ts"), "  Alpha [a.*] 学习\r\nalpha 学习\nother\n");
    const search = new RipgrepCodeSearch();
    expect(await search.search({ ...input("[a.*]"), path: "src" })).toEqual([
      { file: join("src", "a.ts"), line: 1, content: "Alpha [a.*] 学习" },
    ]);
    expect(await search.search(input("ALPHA"))).toHaveLength(2);
    expect(await search.search({ ...input("Alpha"), caseSensitive: true })).toHaveLength(1);
    expect(await search.search(input("学习"))).toHaveLength(2);
    expect(await search.search(input("absent"))).toEqual([]);
  });

  it("ignores hidden, dependency, build and binary entries but does not apply gitignore", async () => {
    for (const dir of [".hidden", "node_modules", "dist", "src/node_modules", "src/dist"]) {
      await mkdir(join(root, dir), { recursive: true });
      await writeFile(join(root, dir, "a.txt"), "needle");
    }
    await writeFile(join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(join(root, "ignored.txt"), "needle");
    await writeFile(join(root, ".secret"), "needle");
    await writeFile(join(root, "picture.PNG"), "needle");
    expect(await new RipgrepCodeSearch().search(input())).toEqual([
      { file: "ignored.txt", line: 1, content: "needle" },
    ]);
  });

  it("caps matches across files, skips oversized files, and keeps leading-dash queries literal", async () => {
    await writeFile(join(root, "a.txt"), "--needle\n".repeat(4));
    await writeFile(join(root, "b.txt"), "--needle\n".repeat(4));
    await writeFile(join(root, "large.txt"), Buffer.alloc(CODE_SEARCH_LIMITS.fileBytes + 1, 97));
    const search = new RipgrepCodeSearch();
    expect(await search.search({ ...input("--needle"), maxResults: 3 })).toHaveLength(3);
    expect(await search.search(input("aaa"))).toEqual([]);
    expect(await search.search(input("--no-ignore; $(echo injected)"))).toEqual([]);
  });

  it("rejects invalid input, missing directories and paths outside the root", async () => {
    const search = new RipgrepCodeSearch();
    for (const query of ["", "a\nb", "a\0b", "x".repeat(4097)]) {
      await expect(search.search(input(query))).rejects.toThrow("query");
    }
    await expect(search.search({ ...input(), maxResults: NaN })).rejects.toThrow("maxResults");
    await expect(search.search({ ...input(), path: ".." })).rejects.toThrow("outside");
    await expect(search.search({ ...input(), path: "missing" })).rejects.toThrow();
  });

  it.skipIf(process.platform === "win32")("rejects external symlink roots and does not follow directory/file symlinks", async () => {
    const outside = await mkdtemp(join(tmpdir(), "aervox-code-search-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "needle");
      await symlink(outside, join(root, "external"));
      await symlink(join(outside, "secret.txt"), join(root, "secret.txt"));
      const search = new RipgrepCodeSearch();
      await expect(search.search({ ...input(), path: "external" })).rejects.toThrow("outside");
      expect(await search.search(input())).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("propagates bridge cancellation as a tool error", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await new DshMcpBridge({ repoRoot: root }).handleRpc({
      id: 1, method: "tools/call", params: { name: "dsh_search_code", arguments: { query: "needle" } },
    }, controller.signal);
    expect(result).toMatchObject({ result: { isError: true } });
  });
});

describe("search lifecycle", () => {
  it("decodes split JSON/UTF-8 records and stops after the global limit", async () => {
    const process = fakeProcess();
    const search = new RipgrepCodeSearch({ spawnSearch: () => {
      queueMicrotask(() => {
        const bytes = Buffer.from(match(2, "学习 needle"));
        const split = bytes.indexOf(Buffer.from("学习")) + 1;
        process.stdout.write(bytes.subarray(0, split));
        process.stdout.write(bytes.subarray(split));
      });
      return process.child;
    } });
    expect(await search.search({ ...input(), maxResults: 1 })).toEqual([{ file: "file.txt", line: 2, content: "学习 needle" }]);
    expect(process.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("kills cancelled work, escalates if needed, and releases concurrency after close", async () => {
    const children: ReturnType<typeof fakeProcess>[] = [];
    const search = new RipgrepCodeSearch({ spawnSearch: () => {
      const child = fakeProcess(true);
      children.push(child);
      return child.child;
    } });
    const controller = new AbortController();
    const first = search.search({ ...input(), signal: controller.signal });
    const second = search.search({ ...input(), signal: controller.signal });
    const assertions = Promise.all([
      expect(first).rejects.toThrow("cancelled"), expect(second).rejects.toThrow("cancelled"),
    ]);
    await vi.waitFor(() => expect(children).toHaveLength(2));
    await expect(search.search(input())).rejects.toThrow("busy");
    await expect(new RipgrepCodeSearch().search(input())).rejects.toThrow("busy");
    controller.abort();
    await assertions;
    expect(children[0]!.kill).toHaveBeenCalledWith("SIGKILL");
    const next = search.search(input());
    await vi.waitFor(() => expect(children).toHaveLength(3));
    children[2]!.close(1);
    expect(await next).toEqual([]);
  });

  it("times out and rejects malformed, oversized, truncated or failed output", async () => {
    const timed = fakeProcess();
    await expect(new RipgrepCodeSearch({ timeoutMs: 10, spawnSearch: () => timed.child }).search(input())).rejects.toThrow("timed out");
    for (const scenario of ["malformed", "oversized", "flood", "truncated", "exit", "spawn"]) {
      const child = fakeProcess();
      const search = new RipgrepCodeSearch({ spawnSearch: () => {
        queueMicrotask(() => {
          if (scenario === "malformed") child.stdout.write("not-json\n");
          if (scenario === "oversized") child.stdout.write(Buffer.alloc(CODE_SEARCH_LIMITS.recordBytes + 1, 97));
          if (scenario === "flood") child.stderr.write(Buffer.alloc(CODE_SEARCH_LIMITS.outputBytes + 1, 97));
          if (scenario === "truncated") { child.stdout.write("{"); child.close(0); }
          if (scenario === "exit") { child.stderr.write("permission denied"); child.close(2); }
          if (scenario === "spawn") child.child.emit("error", new Error("ENOENT"));
        });
        return child.child;
      } });
      await expect(search.search(input())).rejects.toThrow();
    }
  });
});
