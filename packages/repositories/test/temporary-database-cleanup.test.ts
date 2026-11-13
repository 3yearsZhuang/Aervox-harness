import "@libsql/client";
import type { Client } from "@libsql/client";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("temporary database lifecycle", () => {
  let directory: string;
  let exitHooks: Array<() => void>;
  let clients: Client[];

  beforeEach(() => {
    vi.resetModules();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "aervox-temp-cleanup-"));
    exitHooks = [];
    clients = [];
    vi.spyOn(os, "tmpdir").mockReturnValue(directory);
    const once = process.once.bind(process);
    vi.spyOn(process, "once").mockImplementation((event, listener) => {
      if (event === "exit") {
        exitHooks.push(() => listener(0));
        return process;
      }
      return once(event, listener);
    });
  });

  afterEach(() => {
    for (const client of clients) client.close();
    for (const onExit of exitHooks) onExit();
    vi.restoreAllMocks();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("process exit releases closed test databases, sidecars and the schema template", async () => {
    const { createInMemoryDatabase } = await import("../src/client.js");
    for (const options of [{}, { empty: true }]) {
      const database = await createInMemoryDatabase(options);
      clients.push(database.client);
      database.client.close();
    }
    expect(fs.readdirSync(directory).filter(file => file.startsWith("aervox_test_") && file.endsWith(".db"))).toHaveLength(2);
    expect(exitHooks).toHaveLength(1);
    for (const onExit of exitHooks) onExit();
    expect(fs.readdirSync(directory)).toEqual([]);
  });

  it("explicit cleanup unregisters its path before later exit cleanup", async () => {
    const { createInMemoryDatabase } = await import("../src/client.js");
    const database = await createInMemoryDatabase({ empty: true });
    clients.push(database.client);
    const file = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith(".db"))!);
    await database.cleanup();
    expect(fs.readdirSync(directory)).toEqual([]);
    fs.writeFileSync(file, "replacement after cleanup");
    for (const onExit of exitHooks) onExit();
    expect(fs.readFileSync(file, "utf8")).toBe("replacement after cleanup");
  });
});
