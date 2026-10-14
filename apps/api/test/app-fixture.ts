import { afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildApp as buildProductionApp } from "../src/app.js";

const openApps = new Set<Awaited<ReturnType<typeof buildProductionApp>>["app"]>();

/** Each temporary database gets its own installed files; explicit test paths remain authoritative. */
export async function buildApp(options: Parameters<typeof buildProductionApp>[0] = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "avx-api-fixture-"));
  try {
    const built = await buildProductionApp({
      ...options,
      skillsRoot: options.skillsRoot ?? path.join(root, "skills"),
      pluginsRoot: options.pluginsRoot ?? path.join(root, "plugins"),
    });
    openApps.add(built.app);
    built.app.addHook("onClose", async () => {
      openApps.delete(built.app);
      await fs.rm(root, { recursive: true, force: true });
    });
    return built;
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

afterAll(async () => {
  for (const app of openApps) await app.close();
});
