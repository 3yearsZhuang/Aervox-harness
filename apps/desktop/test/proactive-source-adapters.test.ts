import { describe, expect, it } from "vitest";
import {
  createProactiveSourceAdapters,
  type FileDirentLike,
  type FileStatLike,
} from "../src/main/proactive-source-adapters.ts";

const file = (overrides: Partial<FileStatLike> = {}): FileStatLike => ({
  size: 12,
  mtimeMs: 1_700_000_000_000,
  birthtimeMs: 1_699_000_000_000,
  mode: 0o644,
  isFile: () => true,
  isDirectory: () => false,
  isSymbolicLink: () => false,
  ...overrides,
});

const directory = (overrides: Partial<FileStatLike> = {}): FileStatLike => file({
  size: 0,
  isFile: () => false,
  isDirectory: () => true,
  ...overrides,
});

const dirent = (
  name: string,
  kind: "file" | "directory" | "symlink" = "file",
): FileDirentLike => ({
  name,
  isFile: () => kind === "file",
  isDirectory: () => kind === "directory",
  isSymbolicLink: () => kind === "symlink",
});

describe("CAP-033 desktop wide-source adapters", () => {
  it("never reports unsupported sources as granted", async () => {
    const adapters = createProactiveSourceAdapters({
      platform: "win32",
      homeDir: "Z:/missing-user",
      env: {
        USERPROFILE: "Z:/missing-user",
        LOCALAPPDATA: "Z:/missing-user/AppData/Local",
        APPDATA: "Z:/missing-user/AppData/Roaming",
      },
    });

    const probes = await adapters.probeAll();

    expect(probes).toHaveLength(4);
    for (const probe of probes) {
      expect(probe.granted).toBe(false);
      expect(probe.ready).toBe(false);
      expect(probe.status).not.toBe("granted");
    }
  });

  it("browser history capture exposes metadata and path hash only", async () => {
    const historyPath = "/fixture/home/Library/Application Support/Google/Chrome/Default/History";
    const fs = {
      access: async (path: string) => {
        if (path !== historyPath) throw new Error("not readable");
      },
      lstat: async (path: string): Promise<FileStatLike> => {
        if (path === historyPath) return file({ size: 456 });
        throw new Error("not found");
      },
      realpath: async (path: string) => path,
      readdir: async () => [] as readonly FileDirentLike[],
    };
    const adapters = createProactiveSourceAdapters({
      platform: "darwin",
      homeDir: "/fixture/home",
      fileSystem: fs,
    });

    const probe = await adapters.browserHistory.probe();
    expect(probe).toMatchObject({ status: "granted", granted: true, ready: true });

    const batch = await adapters.browserHistory.capture({ includePaths: false });
    expect(batch.records).toHaveLength(1);
    const payload = batch.records[0]?.payload as Record<string, unknown>;
    expect(payload).toMatchObject({
      browser: "chrome",
      profile: "Default",
      format: "chromium-history",
      size: 456,
      contentOmitted: true,
    });
    expect(typeof payload.pathHash).toBe("string");
    expect(payload).not.toHaveProperty("path");
    expect(batch.records[0]).not.toHaveProperty("payloadText");
  });

  it("file metadata capture rejects symlinks and paths escaping the authorized root", async () => {
    const root = "/fixture/root";
    const safe = `${root}/safe.txt`;
    const link = `${root}/link.txt`;
    const escape = `${root}/escape.txt`;
    const fs = {
      access: async (path: string) => {
        if (path !== root && path !== safe) throw new Error("denied");
      },
      lstat: async (path: string): Promise<FileStatLike> => {
        if (path === root) return directory();
        if (path === safe) return file({ size: 8 });
        if (path === link) return file({ isSymbolicLink: () => true });
        if (path === escape) return file();
        throw new Error("not found");
      },
      realpath: async (path: string) => (path === escape ? "/outside/secret.txt" : path),
      readdir: async (path: string) => {
        if (path !== root) throw new Error("not a directory");
        return [dirent("safe.txt"), dirent("link.txt", "symlink"), dirent("escape.txt")];
      },
    };
    const adapters = createProactiveSourceAdapters({
      platform: "darwin",
      fileRoots: [root],
      fileSystem: fs,
    });

    const probe = await adapters.fileMetadata.probe();
    expect(probe).toMatchObject({ status: "granted", granted: true, ready: true });

    const batch = await adapters.fileMetadata.capture({ maxItems: 20, maxDepth: 2 });
    const paths = batch.records.map((record) => (record.payload as Record<string, unknown>).path);
    expect(paths).toContain(root);
    expect(paths).toContain(safe);
    expect(paths).not.toContain(link);
    expect(paths).not.toContain("/outside/secret.txt");
    expect(batch.skipped).toBeGreaterThanOrEqual(2);
  });

  it("downgrades a screen grant when no capture provider is ready", async () => {
    const adapters = createProactiveSourceAdapters({
      platform: "darwin",
      systemPreferences: { getMediaAccessStatus: () => "granted" },
      screenCapture: { probe: () => ({ status: "granted", ready: true }) },
    });

    const probe = await adapters.screenCapture.probe();

    expect(probe.osStatus).toBe("granted");
    expect(probe.status).toBe("unavailable");
    expect(probe.granted).toBe(false);
    expect(probe.ready).toBe(false);
    expect(probe.reason).toBe("screen_capture_provider_unavailable");
  });
});
