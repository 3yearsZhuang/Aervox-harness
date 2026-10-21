import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DshMcpBridge } from "../../../src/modules/ecosystem/mcp/dsh-bridge.js";

const opening = vi.hoisted(() => ({ before: undefined as (() => void) | undefined, after: undefined as (() => void) | undefined }));
vi.mock("node:fs", async importActual => {
  const actual = await importActual<typeof import("node:fs")>();
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    const before = opening.before;
    opening.before = undefined;
    before?.();
    const fd = actual.openSync(...args);
    const after = opening.after;
    opening.after = undefined;
    after?.();
    return fd;
  } };
});

describe("DSH file boundaries and command cancellation", () => {
  let temporary: string;
  let root: string;
  let outside: string;
  let bridge: DshMcpBridge;

  beforeEach(() => {
    temporary = mkdtempSync(join(tmpdir(), "aervox-dsh-boundary-"));
    root = join(temporary, "repo");
    outside = join(temporary, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "private.txt"), "outside synthetic content");
    writeFileSync(join(root, "inside.txt"), "inside synthetic content");
    bridge = new DshMcpBridge({ repoRoot: root });
  });

  afterEach(() => {
    opening.before = undefined;
    opening.after = undefined;
    rmSync(temporary, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
    const response = await bridge.handleRpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, signal);
    if (!response || !("result" in response)) throw new Error("Expected a tool response");
    return response.result as { isError: boolean; content: Array<{ text: string }> };
  }

  it.skipIf(process.platform === "win32").each(["file", "ancestor"])("rejects %s symlink escapes for read and replacement without changing outside data", async kind => {
    const path = kind === "file" ? "escape.txt" : "escape/private.txt";
    symlinkSync(kind === "file" ? join(outside, "private.txt") : outside,
      join(root, kind === "file" ? "escape.txt" : "escape"), kind === "file" ? "file" : "junction");
    const read = await call("dsh_read_file", { path });
    const replacement = await call("dsh_str_replace", { path, oldStr: "outside", newStr: "changed" });
    expect(read.isError).toBe(true);
    expect(JSON.stringify(read)).not.toContain("outside synthetic content");
    expect(replacement.isError).toBe(true);
    expect(readFileSync(join(outside, "private.txt"), "utf8")).toBe("outside synthetic content");
  });

  it("rejects external linked directories for listing and command cwd", async () => {
    symlinkSync(outside, join(root, "escape"), "junction");
    expect((await call("dsh_list_dir", { path: "escape" })).isError).toBe(true);
    expect((await call("dsh_run_command", { command: "echo should-not-run", cwd: "escape" })).isError).toBe(true);
  });

  it.skipIf(process.platform === "win32").each(["dsh_read_file", "dsh_str_replace"])("rejects an ancestor swapped between canonical resolution and open for %s", async name => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub/private.txt"), "inside synthetic content");
    opening.before = () => {
      renameSync(join(root, "sub"), join(root, "original-sub"));
      symlinkSync(outside, join(root, "sub"), "junction");
    };
    const result = await call(name, { path: "sub/private.txt", oldStr: "outside", newStr: "changed" });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain("outside synthetic content");
    expect(readFileSync(join(outside, "private.txt"), "utf8")).toBe("outside synthetic content");
  });

  it.skipIf(process.platform === "win32").each(["dsh_read_file", "dsh_str_replace"])("checks the opened inode even when an ancestor swap is restored immediately after open for %s", async name => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub/private.txt"), "inside synthetic content");
    opening.before = () => {
      renameSync(join(root, "sub"), join(root, "original-sub"));
      symlinkSync(outside, join(root, "sub"), "junction");
    };
    opening.after = () => {
      rmSync(join(root, "sub"));
      renameSync(join(root, "original-sub"), join(root, "sub"));
    };
    const result = await call(name, { path: "sub/private.txt", oldStr: "outside", newStr: "changed" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("File changed while opening");
    expect(JSON.stringify(result)).not.toContain("outside synthetic content");
    expect(readFileSync(join(outside, "private.txt"), "utf8")).toBe("outside synthetic content");
  });

  it.skipIf(process.platform === "win32")("preserves in-root symlinks and regular replacement, including shorter UTF-8 text", async () => {
    symlinkSync(join(root, "inside.txt"), join(root, "alias.txt"), "file");
    expect((await call("dsh_read_file", { path: "alias.txt" })).isError).toBe(false);
    expect((await call("dsh_str_replace", { path: "alias.txt", oldStr: "inside synthetic content", newStr: "你好" })).isError).toBe(false);
    expect(readFileSync(join(root, "inside.txt"), "utf8")).toBe("你好");
    expect((await call("dsh_list_dir", { path: "." })).isError).toBe(false);
  });

  it("never launches a command whose signal is already cancelled", async () => {
    writeFileSync(join(root, "write.cjs"), "require('node:fs').writeFileSync('late.txt', 'unexpected')");
    const controller = new AbortController();
    controller.abort();
    expect((await call("dsh_run_command", { command: 'node "write.cjs"' }, controller.signal)).isError).toBe(true);
    expect(existsSync(join(root, "late.txt"))).toBe(false);
  });

  it("cancels the running shell and its child before a delayed write", async () => {
    writeFileSync(join(root, "delayed.cjs"), [
      "const fs = require('node:fs');",
      "fs.writeFileSync('started.txt', 'ready');",
      "setTimeout(() => fs.writeFileSync('late.txt', 'unexpected'), 500);",
      "setTimeout(() => {}, 2000);",
    ].join("\n"));
    const controller = new AbortController();
    const request = call("dsh_run_command", { command: 'node "delayed.cjs"' }, controller.signal);
    try {
      await vi.waitFor(() => expect(existsSync(join(root, "started.txt"))).toBe(true));
      controller.abort();
      const response = await request;
      expect(response.isError).toBe(true);
      expect(response.content[0]?.text).toContain("Command cancelled");
      await delay(650);
      expect(existsSync(join(root, "late.txt"))).toBe(false);
    } finally {
      controller.abort();
      await request;
    }
  });

  it("times out the shell and child before a delayed write", async () => {
    writeFileSync(join(root, "timeout.cjs"), "setTimeout(() => require('node:fs').writeFileSync('late.txt', 'unexpected'), 1600)");
    const response = await call("dsh_run_command", { command: 'node "timeout.cjs"', timeoutMs: 1000 });
    expect(response.isError).toBe(true);
    expect(response.content[0]?.text).toContain("Command timed out");
    await delay(850);
    expect(existsSync(join(root, "late.txt"))).toBe(false);
  });

  it("retains bounded command output and nonzero status", async () => {
    writeFileSync(join(root, "output.cjs"), "process.stdout.write('x'.repeat(2 * 1024 * 1024)); setTimeout(() => {}, 2000)");
    const limited = await call("dsh_run_command", { command: 'node "output.cjs"' });
    expect(limited.isError).toBe(true);
    const output = JSON.parse(limited.content[0]!.text) as { stdout: string; stderr: string };
    expect(Buffer.byteLength(output.stdout)).toBeLessThanOrEqual(1024 * 1024);
    expect(output.stderr).toContain("output limit");
    const nonzero = await call("dsh_run_command", { command: 'node -e "process.exit(2)"' });
    expect(nonzero.isError).toBe(true);
    expect(JSON.parse(nonzero.content[0]!.text).exitCode).toBe(2);
  });

  it("preserves successful compound shell commands and stdout/stderr", async () => {
    const result = await call("dsh_run_command", { command: 'node -e "console.log(123)" && node -e "console.error(456)"' });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.content[0]!.text)).toEqual({ stdout: "123", stderr: "456", exitCode: 0 });
  });

  it.skipIf(process.platform === "win32")("reaps background descendants when the shell exits", async () => {
    writeFileSync(join(root, "background.cjs"), "setTimeout(() => require('node:fs').writeFileSync('late.txt', 'unexpected'), 500)");
    const result = await call("dsh_run_command", { command: 'node "background.cjs" &' });
    expect(result.isError).toBe(false);
    await delay(650);
    expect(existsSync(join(root, "late.txt"))).toBe(false);
  });
});
