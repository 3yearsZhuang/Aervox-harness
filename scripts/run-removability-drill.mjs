/** BTD-T09/T10/T11. Run in an idle review checkout with mise exec -- node scripts/run-removability-drill.mjs.
 * Backs up exact source bytes, physically removes pilots (including the CR-060 first-party plugin:
 * whole package directory + composition-root references), rebuilds API/Worker without Turbo cache,
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

/** CR-060 移除计划：删除的目录与需剥离引用的宿主文件（组合根 + 其包清单）。 */
const plans = REMOVABLE_TARGETS.map((t) => t.removalPlan).filter(Boolean);
const removedDirs = [...new Set(plans.flatMap((p) => p.removeDirectories ?? []))];
const stripFiles = [...new Set(plans.flatMap((p) => (p.strips ?? []).map((s) => s.file)))];
/**
 * 目录内**源码**文件同样需要备份，以便演练结束后逐字节还原。
 * 跳过依赖链接目录与构建产物：前者在工作区内是指向目录的符号链接（`readFile` 会抛 EISDIR），
 * 后者由 `build()` 重建，不属源码真源。
 */
const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", ".git"]);
const dirFiles = [];
for (const dir of removedDirs) {
  const walk = async (d) => {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(full);
      } else {
        dirFiles.push(full);
      }
    }
  };
  await walk(dir);
}

const files = [
  ...new Set([
    ...REMOVABLE_TARGETS.flatMap((t) => t.implementationFiles.filter((f) => !removedDirs.some((d) => f.startsWith(`${d}/`)))),
    memory,
    model,
    ...stripFiles,
    ...dirFiles,
  ]),
];
const originals = new Map(await Promise.all(files.map(async (f) => [f, await fs.readFile(f)])));
await fs.writeFile(path.join(root, "source-backup.json"), JSON.stringify(Object.fromEntries([...originals].map(([f, b]) => [f, b.toString("base64")]))));
const build = async () => {
  for (const parent of ["apps", "packages", "plugins"]) {
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      if (entry.isDirectory()) await fs.rm(path.join(parent, entry.name, "dist"), { recursive: true, force: true });
    }
  }
  await run("pnpm", ["exec", "turbo", "run", "build", "--filter=@aervox/api...", "--filter=@aervox/worker...", "--force", "--concurrency=2"]);
  // CR-060：被剥离引用的 **UI 组合根** 必须真正参与编译。演练会从
  // `apps/web/src/App.vue` 与 `apps/desktop/src/renderer/src/App.vue` 剥离插件装配行，
  // 若只构建 API/Worker，这些文件从不编译——悬空引用（例如跨行的 `:plugins=` 属性）
  // 会让"删除插件后宿主仍可编译"的结论落空。UI 侧以 `typecheck`（vue-tsc）收口：
  // 足以捕获未解析导入/符号，且避免 electron 打包在演练环境中的额外不确定性。
  await run("pnpm", ["exec", "turbo", "run", "typecheck", "--filter=@aervox/web...", "--filter=@aervox/desktop...", "--force", "--concurrency=2"]);
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

  // CR-060：剥离组合根与包清单中的插件引用（等价于发布一个不含该插件的宿主版本）
  for (const plan of plans) {
    for (const strip of plan.strips ?? []) {
      const before = (originals.get(strip.file) ?? await fs.readFile(strip.file)).toString();
      const after = before.replace(new RegExp(strip.pattern, strip.flags), "");
      if (after === before) throw new Error(`移除演练未匹配到引用，需同步更新 removalPlan：${strip.file}`);
      await fs.writeFile(strip.file, after);
    }
  }

  for (const target of REMOVABLE_TARGETS) for (const f of target.implementationFiles) {
    if (removedDirs.some((d) => f.startsWith(`${d}/`))) continue;
    await fs.unlink(f);
  }
  for (const dir of removedDirs) await fs.rm(dir, { recursive: true, force: true });

  await build();
  for (const target of REMOVABLE_TARGETS) for (const f of target.implementationFiles) {
    await fs.access(f).then(() => { throw new Error(`source still exists: ${f}`); }, () => {});
    await fs.access(f.replace("/src/", "/dist/").replace(/\.ts$/, ".js")).then(() => { throw new Error(`stale output: ${f}`); }, () => {});
  }
  await phase("absent");
} catch (error) { failure = error; }
finally {
  for (const [f, data] of originals) {
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, data);
  }
}
await build();
if (failure) throw failure;
await phase("restored");
console.log("Physical removal, cold API/Worker dependency builds, data rights and restoration PASS");
