import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createInMemoryDatabase } from "@aervox/repositories";
import { loadHostRuntimeConfig } from "@aervox/config";

const state = vi.hoisted(() => ({
  main: undefined as Awaited<ReturnType<typeof createInMemoryDatabase>> | undefined,
  denyDrain: false,
  failStartup: false,
  probeModuleClose: false,
  observedBeforeClose: undefined as unknown,
}));
vi.mock("@aervox/repositories", async importOriginal => {
  const actual = await importOriginal<typeof import("@aervox/repositories")>();
  return { ...actual,
    createDefaultDatabase: async () => state.main ?? actual.createDefaultDatabase(),
    assertPluginIdentityMigrationReady: async (...args: Parameters<typeof actual.assertPluginIdentityMigrationReady>) => {
      if (state.failStartup) throw new Error("fixture_startup_failure");
      return actual.assertPluginIdentityMigrationReady(...args);
    },
  };
});
vi.mock("../src/modules/companion/conversation/dsh-adapter.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/modules/companion/conversation/dsh-adapter.js")>();
  return { ...actual,
    createDshTurnAdapterResolver: (...args: Parameters<typeof actual.createDshTurnAdapterResolver>) => {
      const resolver = actual.createDshTurnAdapterResolver(...args);
      return { ...resolver, close: async () => {
        if (state.probeModuleClose) {
          state.observedBeforeClose = (await state.main!.client.execute("SELECT 1 AS retained")).rows[0]?.retained;
        }
        await resolver.close();
      } };
    },
  };
});
vi.mock("../src/modules/ecosystem/llm/index.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/modules/ecosystem/llm/index.js")>();
  return { ...actual,
    createModelStreamResources: (...args: Parameters<typeof actual.createModelStreamResources>) => {
      const owner = actual.createModelStreamResources(...args);
      return { ...owner, close: async () => {
        if (state.denyDrain) throw new actual.ModelStreamDrainError();
        await owner.close();
      } };
    },
  };
});
import { buildHostRuntime } from "../src/runtime.js";

let root: string, vault: Awaited<ReturnType<typeof createInMemoryDatabase>>;
let host: Awaited<ReturnType<typeof buildHostRuntime>> | undefined;
beforeEach(async () => {
  state.denyDrain = false; state.failStartup = false;
  state.probeModuleClose = false; state.observedBeforeClose = undefined;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "avx-owned-close-"));
  state.main = await createInMemoryDatabase(); vault = await createInMemoryDatabase();
});
afterEach(async () => {
  state.denyDrain = false; state.failStartup = false;
  state.probeModuleClose = false;
  await host?.app.close().catch(() => undefined); host = undefined;
  await state.main?.cleanup(); await vault.cleanup(); state.main = undefined;
  await fs.rm(root, { recursive: true, force: true });
});
const start = () => buildHostRuntime({
  role: "worker", initSchema: false, pluginRegistryOptions: null,
  config: loadHostRuntimeConfig({ AERVOX_LOOP_PROVIDER: "replay" }),
  proactiveDb: vault.db, proactiveClient: vault.client, proactiveAccessToken: null,
  migrationStatePath: path.join(root, "migration.json"),
  skillsRoot: path.join(root, "skills"), pluginsRoot: path.join(root, "plugins"),
  attachmentsRoot: path.join(root, "attachments"),
});

it("lets module cleanup use the database before releasing the host-owned connection", async () => {
  state.probeModuleClose = true;
  host = await start(); await host.app.ready();
  await host.app.close();
  expect(state.observedBeforeClose).toBe(1);
  expect(state.main!.client.closed).toBe(true);
});

it("keeps the host-owned main database open when shutdown cannot acknowledge model stream drainage", async () => {
  host = await start(); await host.app.ready(); state.denyDrain = true;
  await expect(host.app.close()).rejects.toMatchObject({ code: "MODEL_STREAM_DRAIN_UNCONFIRMED" });
  expect(state.main!.client.closed).toBe(false);
  expect((await state.main!.client.execute("SELECT 1 AS retained")).rows[0]?.retained).toBe(1);
});

it("retains the owned database and both errors when startup cleanup cannot acknowledge stream drainage", async () => {
  state.failStartup = true; state.denyDrain = true;
  const error = await start().then(() => undefined, failure => failure as AggregateError);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error!.errors).toEqual(expect.arrayContaining([
    expect.objectContaining({ message: "fixture_startup_failure" }),
    expect.objectContaining({ code: "MODEL_STREAM_DRAIN_UNCONFIRMED" }),
  ]));
  expect(state.main!.client.closed).toBe(false);
  expect((await state.main!.client.execute("SELECT 1 AS retained")).rows[0]?.retained).toBe(1);
});
