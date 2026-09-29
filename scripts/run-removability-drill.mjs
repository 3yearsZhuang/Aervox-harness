/** BTD-T09/T10. Run in an idle review checkout with mise exec -- node scripts/run-removability-drill.mjs.
 * Backs up exact source bytes, physically removes pilots, rebuilds API/Worker without Turbo cache,
 * exercises existing owner ports against a temp file database, restores sources and rebuilds.
 * Source backups, model fixtures and data exports remain in the printed temp directory.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { REMOVABLE_TARGETS } from "./check-removable-implementation.mjs";
const root = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-removal-"));
console.log(`Drill evidence/backup: ${root}`);
const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: "inherit" });
  p.on("error", reject);
  p.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
});
const memory = "apps/api/src/modules/companion/memory/index.ts";
const model = "apps/api/src/modules/ecosystem/model-runtime/index.ts";
const files = [...REMOVABLE_TARGETS.flatMap((t) => t.implementationFiles), memory, model];
const originals = new Map(await Promise.all(files.map(async (f) => [f, await fs.readFile(f)])));
await fs.writeFile(path.join(root, "source-backup.json"), JSON.stringify(Object.fromEntries([...originals].map(([f, b]) => [f, b.toString("base64")]))));
const build = async () => {
  for (const parent of ["apps", "packages"]) {
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) await fs.rm(path.join(parent, entry.name, "dist"), { recursive: true, force: true });
    }
  }
  await run("pnpm", ["exec", "turbo", "run", "build", "--filter=@aervox/api...", "--filter=@aervox/worker...", "--force", "--concurrency=2"]);
};
const phase = (name) => run(process.execPath, ["scripts/fixtures/removability-data-rights.mjs", name, root]);
let failure;
try {
  await build(); await phase("seed");
  await fs.writeFile(memory, originals.get(memory).toString()
    .replace(/^import .*MemoryStoreTool.*\n/m, "").replace(/^import .*contributeMemoryTool.*\n/m, "")
    .replace(/^export type \{ MemoryWritePort.*\n/m, "")
    .replace(/  if \(ctx.toolRuntime[\s\S]*?\n  }\n}/, "}"));
  await fs.writeFile(model, originals.get(model).toString()
    .replace(/^import .*LlamaServerManager.*\n/m, "")
    .replace(/export interface ModelRuntimeModuleOptions[^\n]+/, "export type ModelRuntimeModuleOptions = ModelRuntimeServiceOptions;")
    .replace(/new ModelRuntimeService\(\{[^\n]+/, "new ModelRuntimeService(options);")
    .replace(/^export \* from "\.\/llama-server.js";\n/m, "")
    .replace(/^export type \{ LlamaServerManagerDeps \};(?:\n|$)/m, ""));
  for (const target of REMOVABLE_TARGETS) for (const f of target.implementationFiles) await fs.unlink(f);
  await build();
  for (const target of REMOVABLE_TARGETS) for (const f of target.implementationFiles) {
    await fs.access(f).then(() => { throw new Error(`source still exists: ${f}`); }, () => {});
    await fs.access(f.replace("/src/", "/dist/").replace(/\.ts$/, ".js")).then(() => { throw new Error(`stale output: ${f}`); }, () => {});
  }
  await phase("absent");
} catch (error) { failure = error; }
finally { for (const [f, data] of originals) await fs.writeFile(f, data); }
await build();
if (failure) throw failure;
await phase("restored");
console.log("Physical removal, cold API/Worker dependency builds, data rights and restoration PASS");
