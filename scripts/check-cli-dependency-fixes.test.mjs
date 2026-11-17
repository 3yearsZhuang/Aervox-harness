import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

function packageAt(entry, name) {
  let directory = path.dirname(entry);
  while (true) {
    const manifestPath = path.join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.name === name) return { directory, manifest };
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate ${name} from ${entry}`);
    directory = parent;
  }
}

function temporaryDirectory(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "aervox-cli-dependency-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

let drizzle;
function resolveDrizzle() {
  if (drizzle) return drizzle;
  const schemaRequire = createRequire(path.join(root, "packages/schema/package.json"));
  const drizzleEntry = schemaRequire.resolve("drizzle-kit");
  const loaderEntry = createRequire(drizzleEntry).resolve("@esbuild-kit/esm-loader");
  const loaderRequire = createRequire(loaderEntry);
  const coreEntry = loaderRequire.resolve("@esbuild-kit/core-utils");
  const coreRequire = createRequire(coreEntry);
  // The old loader imports its utility as ESM. Resolve that condition from the
  // actual loader too, so a fixed root copy cannot hide a parallel old target.
  const esm = JSON.parse(execFileSync(process.execPath, [
    "--experimental-import-meta-resolve", "--input-type=module", "-e", `
      const core = import.meta.resolve('@esbuild-kit/core-utils', ${JSON.stringify(pathToFileURL(loaderEntry).href)});
      const esbuild = import.meta.resolve('esbuild', core);
      console.log(JSON.stringify({ core, esbuild }));
    `,
  ], { cwd: root, encoding: "utf8", timeout: 10_000, maxBuffer: 128 * 1024 }));
  drizzle = {
    coreEntry,
    coreRequire,
    cjsEsbuild: coreRequire.resolve("esbuild"),
    esmCore: esm.core,
    esmEsbuild: fileURLToPath(esm.esbuild),
  };
  return drizzle;
}

let mobile;
function resolveMobile() {
  if (mobile) return mobile;
  const mobileRequire = createRequire(path.join(root, "apps/mobile/package.json"));
  const cliEntry = mobileRequire.resolve("@capacitor/cli");
  const cliRequire = createRequire(cliEntry);
  const xcodeEntry = cliRequire.resolve("xcode");
  const xcodeRequire = createRequire(xcodeEntry);
  mobile = { cliRequire, xcodeEntry, xcodeRequire, uuidEntry: xcodeRequire.resolve("uuid") };
  return mobile;
}

test("Drizzle's real legacy loader consumes the fixed esbuild under CJS and ESM", () => {
  const dependency = resolveDrizzle();
  const cjs = packageAt(dependency.cjsEsbuild, "esbuild");
  const esm = packageAt(dependency.esmEsbuild, "esbuild");
  assert.equal(cjs.manifest.version, "0.25.12");
  assert.equal(esm.manifest.version, "0.25.12");
  assert.equal(realpathSync(cjs.directory), realpathSync(esm.directory));
  assert.equal(dependency.coreRequire("esbuild").version, "0.25.12");
});

test("the legacy loader preserves synchronous and asynchronous TypeScript transforms", async t => {
  const dependency = resolveDrizzle();
  const directory = temporaryDirectory(t);
  const file = path.join(directory, "fixture.ts");
  const source = "export enum State { Ready = 2 }; export const answer: number = State.Ready + 40; export default answer;";
  writeFileSync(file, source);
  const apis = [dependency.coreRequire("@esbuild-kit/core-utils"), await import(dependency.esmCore)];
  for (const api of apis) {
    for (const result of [api.transformSync(source, file, { format: "cjs" }), await api.transform(source, file, { format: "cjs" })]) {
      const module = { exports: {} };
      new Function("module", "exports", "require", result.code)(module, module.exports, createRequire(file));
      assert.equal(module.exports.answer, 42);
      assert.equal(module.exports.default, 42);
    }
  }
});

test("Capacitor's real xcode consumer resolves the fixed CommonJS UUID API", () => {
  const dependency = resolveMobile();
  assert.equal(packageAt(dependency.xcodeEntry, "xcode").manifest.version, "3.0.1");
  assert.equal(packageAt(dependency.uuidEntry, "uuid").manifest.version, "11.1.1");
  const uuid = dependency.xcodeRequire("uuid");
  const value = uuid.v4();
  assert.equal(uuid.validate(value), true);
  assert.equal(uuid.version(value), 4);
});

test("xcode retains project parsing, UUID identifiers and project writeback", t => {
  const directory = temporaryDirectory(t);
  const file = path.join(directory, "project.pbxproj");
  const projectId = "AAAAAAAAAAAAAAAAAAAAAAAA";
  writeFileSync(file, `// !$*UTF8*$!
{
  archiveVersion = 1;
  classes = {};
  objectVersion = 56;
  objects = {
/* Begin PBXProject section */
    ${projectId} = { isa = PBXProject; buildConfigurationList = CCCCCCCCCCCCCCCCCCCCCCCC; mainGroup = BBBBBBBBBBBBBBBBBBBBBBBB; targets = (); };
/* End PBXProject section */
/* Begin PBXGroup section */
    BBBBBBBBBBBBBBBBBBBBBBBB = { isa = PBXGroup; children = (); sourceTree = "<group>"; };
/* End PBXGroup section */
/* Begin XCConfigurationList section */
    CCCCCCCCCCCCCCCCCCCCCCCC = { isa = XCConfigurationList; buildConfigurations = (DDDDDDDDDDDDDDDDDDDDDDDD,); defaultConfigurationIsVisible = 0; defaultConfigurationName = Debug; };
/* End XCConfigurationList section */
/* Begin XCBuildConfiguration section */
    DDDDDDDDDDDDDDDDDDDDDDDD = { isa = XCBuildConfiguration; buildSettings = {}; name = Debug; };
/* End XCBuildConfiguration section */
  };
  rootObject = ${projectId};
}
`);
  const xcode = resolveMobile().cliRequire("xcode");
  const project = xcode.project(file).parseSync();
  assert.equal(project.getFirstProject().uuid, projectId);
  const ids = Array.from({ length: 128 }, () => project.generateUuid());
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ids) {
    assert.match(id, /^[A-F0-9]{24}$/);
    assert.equal(project.allUuids().includes(id), false);
  }
  project.addBuildProperty("CLI_DEPENDENCY_FIX", "YES");
  const serialized = project.writeSync();
  assert.match(serialized, /CLI_DEPENDENCY_FIX = YES;/);
  writeFileSync(file, serialized);
  const reopened = xcode.project(file).parseSync();
  assert.equal(reopened.getFirstProject().uuid, projectId);
  assert.equal(reopened.pbxXCBuildConfigurationSection().DDDDDDDDDDDDDDDDDDDDDDDD.buildSettings.CLI_DEPENDENCY_FIX, "YES");
});

test("UUID v3/v5 reject invalid output bounds and preserve valid RFC name UUIDs", () => {
  const uuid = resolveMobile().xcodeRequire("uuid");
  const namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
  const examples = [
    ["v3", "3d813cbb-47fb-32ba-91df-831e1593ac29"],
    ["v5", "21f7f8de-8051-5b89-8680-0195ef798b6a"],
  ];
  for (const [name, expected] of examples) {
    assert.equal(uuid[name]("www.widgets.com", namespace), expected);
    for (const [buffer, offset] of [[new Uint8Array(8), 4], [Buffer.alloc(16), 1], [new Uint8Array(16), -1]]) {
      buffer.fill(0xaa);
      const before = Uint8Array.from(buffer);
      assert.throws(() => uuid[name]("www.widgets.com", namespace, buffer, offset), RangeError);
      assert.deepEqual(Uint8Array.from(buffer), before, "rejected writes must leave the buffer intact");
    }
    for (const buffer of [new Uint8Array(24), Buffer.alloc(24)]) {
      buffer.fill(0xaa);
      assert.equal(uuid[name]("www.widgets.com", namespace, buffer, 8), buffer);
      assert.deepEqual(Uint8Array.from(buffer.subarray(0, 8)), new Uint8Array(8).fill(0xaa));
      assert.deepEqual(Uint8Array.from(buffer.subarray(8)), uuid.parse(expected));
    }
  }
});
