import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { rgPath } from "@vscode/ripgrep";

export const CODE_SEARCH_LIMITS = {
  timeoutMs: 10_000,
  concurrent: 2,
  fileBytes: 8 * 1024 * 1024,
  outputBytes: 4 * 1024 * 1024,
  recordBytes: 256 * 1024,
  queryBytes: 4096,
} as const;

export interface CodeSearchMatch {
  file: string;
  line: number;
  content: string;
}

type SpawnSearch = (args: string[], cwd: string) => ChildProcessWithoutNullStreams;

export interface CodeSearchOptions {
  spawnSearch?: SpawnSearch;
  timeoutMs?: number;
}

// All bridge instances in this API process share the same resource budget.
let activeSearches = 0;

function assertWithin(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("Search path is outside the repository root");
  }
}

function decodeText(value: { text?: string; bytes?: string } | undefined): string {
  if (typeof value?.text === "string") return value.text;
  if (typeof value?.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf8");
  throw new Error("Invalid ripgrep text field");
}

export class RipgrepCodeSearch {
  constructor(private readonly options: CodeSearchOptions = {}) {}

  async search(input: {
    root: string;
    path: string;
    query: string;
    caseSensitive: boolean;
    maxResults: number;
    signal?: AbortSignal;
  }): Promise<CodeSearchMatch[]> {
    input.signal?.throwIfAborted();
    if (!input.query || /[\r\n\0]/u.test(input.query) || Buffer.byteLength(input.query) > CODE_SEARCH_LIMITS.queryBytes) {
      throw new Error("Search query must be a nonempty single line of at most 4096 bytes without NUL");
    }
    if (!Number.isSafeInteger(input.maxResults) || input.maxResults < 1 || input.maxResults > 200) {
      throw new Error("Search maxResults must be an integer from 1 to 200");
    }
    if (activeSearches >= CODE_SEARCH_LIMITS.concurrent) throw new Error("Code search is busy; retry later");
    activeSearches += 1;
    try {
      const root = await realpath(input.root);
      const lexicalPath = resolve(root, input.path);
      assertWithin(root, lexicalPath);
      const directory = await realpath(lexicalPath);
      assertWithin(root, directory);
      if (!(await stat(directory)).isDirectory()) throw new Error("Search path must be a directory");
      input.signal?.throwIfAborted();
      const args = [
        "--no-config", "--json", "--fixed-strings", "--line-buffered", "--no-ignore",
        "--no-follow", "--text", "--encoding", "utf-8", "--sort", "path",
        "--max-filesize", String(CODE_SEARCH_LIMITS.fileBytes),
        "--glob", "!node_modules", "--glob", "!dist",
        "--iglob", "!*.{png,jpg,jpeg,gif,webp,ico,woff,woff2,ttf,eot,pdf,zip,tar,gz,sqlite,db}",
        input.caseSensitive ? "--case-sensitive" : "--ignore-case",
        "--regexp", input.query, "--", ".",
      ];
      const launch = this.options.spawnSearch ?? ((argv, cwd) => spawn(rgPath, argv, {
        cwd, windowsHide: true, shell: false, stdio: "pipe",
      }));
      return await this.collect(launch(args, directory), root, directory, input.maxResults, input.signal);
    } finally {
      activeSearches -= 1;
    }
  }

  private collect(
    child: ChildProcessWithoutNullStreams,
    root: string,
    directory: string,
    maxResults: number,
    signal?: AbortSignal,
  ): Promise<CodeSearchMatch[]> {
    return new Promise((resolveResult, reject) => {
      const matches: CodeSearchMatch[] = [];
      let pending = Buffer.alloc(0);
      let outputBytes = 0;
      let stderr = "";
      let stopped = false;
      let failure: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stop = (error?: Error) => {
        failure ??= error;
        if (stopped) return;
        stopped = true;
        child.kill("SIGTERM");
        killTimer = setTimeout(() => child.kill("SIGKILL"), 150);
      };
      const abort = () => stop(new Error("Code search cancelled", { cause: signal?.reason }));
      const deadline = setTimeout(() => stop(new Error("Code search timed out")), this.options.timeoutMs ?? CODE_SEARCH_LIMITS.timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      child.stdin.on("error", (error) => stop(error));
      child.stdin.end();
      child.on("error", (error) => stop(error));
      child.stdout.on("error", (error) => stop(error));
      child.stderr.on("error", (error) => stop(error));
      child.stderr.on("data", (data: Buffer) => {
        if (stopped) return;
        outputBytes += data.length;
        if (outputBytes > CODE_SEARCH_LIMITS.outputBytes) return stop(new Error("Code search output limit exceeded"));
        if (stderr.length < 2048) stderr += data.toString("utf8").slice(0, 2048 - stderr.length);
      });
      child.stdout.on("data", (data: Buffer) => {
        if (stopped) return;
        outputBytes += data.length;
        if (outputBytes > CODE_SEARCH_LIMITS.outputBytes) return stop(new Error("Code search output limit exceeded"));
        pending = Buffer.concat([pending, data]);
        try {
          let newline: number;
          while (!stopped && (newline = pending.indexOf(10)) !== -1) {
            if (newline > CODE_SEARCH_LIMITS.recordBytes) throw new Error("Code search record limit exceeded");
            const record = JSON.parse(pending.subarray(0, newline).toString("utf8")) as {
              type?: string;
              data?: { path?: { text?: string; bytes?: string }; lines?: { text?: string; bytes?: string }; line_number?: number };
            };
            pending = pending.subarray(newline + 1);
            if (record.type !== "match") continue;
            if (!Number.isSafeInteger(record.data?.line_number) || record.data!.line_number! < 1) throw new Error("Invalid ripgrep line number");
            const filePath = resolve(directory, decodeText(record.data?.path));
            assertWithin(directory, filePath);
            matches.push({
              file: relative(root, filePath),
              line: record.data!.line_number!,
              content: decodeText(record.data?.lines).trim(),
            });
            if (matches.length >= maxResults) stop();
          }
          if (!stopped && pending.length > CODE_SEARCH_LIMITS.recordBytes) throw new Error("Code search record limit exceeded");
        } catch (error) {
          stop(error instanceof Error ? error : new Error(String(error)));
        }
      });
      // Wait for close, not exit: pipes must drain and the process must be reaped before releasing capacity.
      child.once("close", (code) => {
        clearTimeout(deadline);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
        if (failure) return reject(failure);
        if (stopped && matches.length === maxResults) return resolveResult(matches);
        if (code !== 0 && code !== 1) return reject(new Error(`Code search failed (${code}): ${stderr.trim()}`));
        if (pending.length !== 0) return reject(new Error("Incomplete ripgrep response"));
        resolveResult(matches);
      });
    });
  }
}
