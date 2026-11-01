import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { createRequire, SourceMap } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const advisory = "GHSA-g3hv-75wg-m249";
// Backport: https://github.com/isaacs/minimatch/commit/77a0f5c4b80bdc641c3c930a1d9edf5ad2db57f8
// v9 has no braceExpandMax option; keep its API and use the upstream default cap.
const patchedVersions = ["9.0.9", "10.2.6"];
const legacyVersions = ["3.1.5", "5.1.9"];
const reviews = JSON.parse(readFileSync(path.join(root, "scripts/dependency-audit-exceptions.json"), "utf8"))
  .filter(entry => entry.advisory === advisory && entry.package === "minimatch");
const consumers = reviews.flatMap(entry => entry.paths.map(route => ({ version: entry.version, route })));
let resolved;

function resolveConsumers() {
  if (resolved) return resolved;
  const chains = JSON.parse(execFileSync(process.execPath, [
    "--experimental-import-meta-resolve", "--input-type=module", "-e", `
      const routes = ${JSON.stringify(consumers.map(consumer => consumer.route))};
      const root = ${JSON.stringify(pathToFileURL(root).href)};
      console.log(JSON.stringify(routes.map(route => {
        const [workspace, ...names] = route.split('>');
        let parent = new URL((workspace === '.' ? '' : workspace.replaceAll('__', '/') + '/') + 'package.json', root).href;
        return names.map(name => {
          parent = import.meta.resolve(name, parent);
          return parent;
        });
      })));
    `,
  ], { cwd: root, encoding: "utf8", timeout: 30_000 }));
  resolved = consumers.map((consumer, index) => {
    const chain = chains[index];
    const parent = fileURLToPath(chain.at(-2));
    const require = createRequire(parent);
    const packageRoot = path.dirname(require.resolve("minimatch/package.json"));
    return { ...consumer, chain, parent, require, packageRoot, cjs: require.resolve("minimatch"), esm: fileURLToPath(chain.at(-1)) };
  });
  return resolved;
}

// The probe measures finite structural bounds, not wall-clock performance.
// It runs in a memory- and time-bounded child as a second containment layer.
function securityProbe(Minimatch, version, phase = "all") {
  const limit = version === "10.2.6" ? 64 : 100_000;
  const options = { optimizationLevel: 2, ...(version === "10.2.6" ? { braceExpandMax: limit } : {}) };
  const mm = new Minimatch("safe", options);
  // At the cap, one more **/.. split must not grow the pattern set.
  // Reusing a non-mutated literal avoids constructing an exponential input.
  let expanded = 0;
  if (phase !== "deduplication") {
    const patterns = Array(limit).fill(["safe"]);
    patterns[0] = ["**", "..", "a", "b"];
    expanded = mm.firstPhasePreProcess(patterns).length;
    if (expanded !== limit) throw new Error(`pattern amplification: expected ${limit}, received ${expanded}`);
  }
  // Above 1,000 patterns no pairwise comparisons should be performed.
  let comparisons = 0;
  if (phase !== "amplification") {
    mm.partsMatch = () => { comparisons++; return null; };
    const many = Array.from({ length: 1001 }, (_, index) => [`literal-${index}`]);
    const returned = mm.secondPhasePreProcess(many);
    if (comparisons !== 0 || returned.length !== 1001) throw new Error(`quadratic deduplication: ${comparisons} comparisons`);
  }
  if (version === "10.2.6" && phase !== "deduplication") {
    const limited = new Minimatch(Array(7).fill("**/../a/b").join("/"), options);
    if (limited.set.length !== limit) throw new Error(`constructor amplification: ${limited.set.length}`);
  }
  return { expanded, comparisons };
}

function runProbe(packageRoot, format, version, phase = "all") {
  const entry = pathToFileURL(path.join(packageRoot, `dist/${format}/index.js`)).href;
  return spawnSync(process.execPath, ["--max-old-space-size=192", "--input-type=module", "-e", `
    import { createRequire } from 'node:module';
    import { fileURLToPath } from 'node:url';
    const entry = ${JSON.stringify(entry)};
    const api = ${format === "commonjs" ? "createRequire(entry)(fileURLToPath(entry))" : "await import(entry)"};
    const result = (${securityProbe.toString()})(api.Minimatch, ${JSON.stringify(version)}, ${JSON.stringify(phase)});
    console.log(JSON.stringify(result));
  `], { cwd: root, encoding: "utf8", timeout: 15_000, maxBuffer: 128 * 1024 });
}

function assertMatching(api) {
  const { minimatch, Minimatch, makeRe, AST } = api;
  assert.equal(typeof minimatch, "function");
  assert.equal(typeof makeRe, "function");
  assert.equal(typeof AST, "function");
  assert.equal(minimatch("src/main.ts", "src/**/*.ts"), true);
  assert.equal(minimatch("src/main.js", "src/**/*.ts"), false);
  assert.equal(minimatch(".env", "*"), false);
  assert.equal(minimatch(".env", "*", { dot: true }), true);
  assert.equal(minimatch("src/Main.TS", "src/*.ts", { nocase: true }), true);
  assert.equal(minimatch("src/file.ts", "*.ts", { matchBase: true }), true);
  assert.equal(makeRe("*.ts").test("main.ts"), true);
  const ordinary = new Minimatch("src/*.ts");
  assert.ok(ordinary.set[0][1] instanceof RegExp);
  assert.ok(ordinary.makeRe() instanceof RegExp);
  assert.ok(ordinary.regexp instanceof RegExp);
  const small = new Minimatch("**/../a/b/**/../c/d", { optimizationLevel: 2 });
  assert.equal(small.set.length, 4);
  assert.equal(small.match("../a/b/../c/d"), true);
  assert.equal(small.match("x/a/b/y/c/d"), true);
  const deduped = new Minimatch("{x,*}/{0..9}", { optimizationLevel: 2 });
  assert.equal(deduped.set.length, 10);
  const large = new Minimatch("{x,*}/{0..999}", { optimizationLevel: 2 });
  assert.equal(large.set.length, 2000);
  assert.equal(large.match("x/5"), true);
  assert.equal(large.match("y/999"), true);
  assert.equal(large.match(".y/5"), false);
}

test("minimatch reviews cover exact legacy and patched versions before registry audit", () => {
  assert.deepEqual([...new Set(reviews.map(entry => entry.version))].sort(), [...patchedVersions, ...legacyVersions].sort());
  assert.equal(new Set(consumers.map(consumer => consumer.route)).size, consumers.length);
  assert.ok(consumers.length > 0);
  const workspace = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  const lock = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  for (const version of patchedVersions) {
    const patchPath = `patches/minimatch@${version}.patch`;
    assert.ok(workspace.includes(`  minimatch@${version}: ${patchPath}\n`));
    const patch = readFileSync(path.join(root, patchPath));
    const hash = createHash("sha256").update(patch).digest("hex");
    assert.ok(lock.includes(`  minimatch@${version}: ${hash}\n`));
    assert.ok(lock.includes(`  minimatch@${version}(patch_hash=${hash}):\n`));
    for (const format of ["commonjs", "esm"]) {
      for (const file of ["index.js", "index.js.map", "index.d.ts.map"]) {
        assert.ok(patch.includes(Buffer.from(`+++ b/dist/${format}/${file}`)), `${version}: ${format}/${file} is patched`);
      }
    }
  }
  const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  const [validation, audit] = scripts["check:dependency-audit"].split(" && ");
  assert.match(validation, /^node --test /);
  assert.ok(validation.split(" ").includes("scripts/check-minimatch-patches.test.mjs"));
  assert.equal(audit, "node scripts/check-dependency-audit.mjs");
  assert.match(scripts["check:guards"], /node --test scripts\/check-\*\.test\.mjs/);
});

test("every reviewed minimatch route resolves to the tested package and preserves its API", async () => {
  const checked = new Set();
  for (const consumer of resolveConsumers()) {
    const manifest = JSON.parse(readFileSync(path.join(consumer.packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.version, consumer.version, consumer.route);
    assert.equal(manifest.license, consumer.version === "10.2.6" ? "BlueOak-1.0.0" : "ISC");
    const key = realpathSync(consumer.packageRoot);
    if (patchedVersions.includes(consumer.version)) {
      assert.equal(path.relative(consumer.packageRoot, consumer.cjs), "dist/commonjs/index.js");
      assert.equal(path.relative(consumer.packageRoot, consumer.esm), "dist/esm/index.js");
      if (consumer.route.endsWith(">glob>minimatch")) {
        // glob's minified default formerly embedded an unpatched minimatch copy.
        assert.equal(path.basename(consumer.parent), "index.js", consumer.route);
      }
      if (checked.has(key)) continue;
      checked.add(key);
      assertMatching(consumer.require("minimatch"));
      assertMatching(await import(pathToFileURL(consumer.esm).href));
    } else {
      assert.ok(legacyVersions.includes(consumer.version));
      assert.equal(realpathSync(consumer.cjs), realpathSync(consumer.esm));
      if (checked.has(key)) continue;
      checked.add(key);
      const source = readFileSync(consumer.cjs, "utf8");
      assert.doesNotMatch(source, /firstPhasePreProcess|secondPhasePreProcess|optimizationLevel/);
      for (const api of [consumer.require("minimatch"), (await import(pathToFileURL(consumer.esm).href)).default]) {
        assert.equal(typeof api, "function");
        assert.equal(typeof api.Minimatch.prototype.firstPhasePreProcess, "undefined");
        assert.equal(typeof api.Minimatch.prototype.secondPhasePreProcess, "undefined");
        assert.equal(api("src/main.ts", "src/**/*.ts"), true);
        assert.equal(api("src/main.js", "src/**/*.ts"), false);
        assert.equal(api(".env", "*"), false);
        assert.equal(api(".env", "*", { dot: true }), true);
        assert.equal(api.makeRe("*.ts").test("main.ts"), true);
        const pattern = new api.Minimatch(Array(7).fill("**/../a/b").join("/"), { optimizationLevel: 2 });
        assert.equal(pattern.set.length, 1, "legacy versions do not perform the vulnerable pattern expansion");
      }
    }
  }
});

for (const version of patchedVersions) {
  test(`minimatch ${version} CJS/ESM enforce both bounds and reject the original negative control`, t => {
    const installed = [...new Set(resolveConsumers().filter(consumer => consumer.version === version)
      .map(consumer => realpathSync(consumer.packageRoot)))];
    assert.ok(installed.length > 0);
    for (const packageRoot of installed) {
      for (const format of ["commonjs", "esm"]) {
        const result = runProbe(packageRoot, format, version);
        assert.ifError(result.error);
        assert.equal(result.status, 0, `${format}: ${result.stderr}`);
        assert.equal(JSON.parse(result.stdout).comparisons, 0);
      }
      const parent = path.join(root, "artifacts/minimatch-remediation");
      mkdirSync(parent, { recursive: true });
      const control = mkdtempSync(path.join(parent, `${version}-control-`));
      t.after(() => rmSync(control, { recursive: true, force: true }));
      cpSync(packageRoot, control, { recursive: true });
      // Restore the exact published original without network access or touching
      // installed package files. --directory confines the reverse patch here.
      execFileSync("git", ["apply", "--reverse", `--directory=${path.relative(root, control)}`,
        path.join(root, `patches/minimatch@${version}.patch`)], { cwd: root, encoding: "utf8" });
      symlinkSync(path.dirname(packageRoot), path.join(control, "node_modules"), "dir");
      for (const format of ["commonjs", "esm"]) {
        for (const phase of ["amplification", "deduplication"]) {
          const result = runProbe(control, format, version, phase);
          assert.ifError(result.error);
          assert.equal(result.status, 1, `${format} ${phase}: the unpatched original must fail the same finite probe`);
          assert.match(result.stderr, phase === "amplification" ? /pattern amplification:/ : /quadratic deduplication: 500500 comparisons/);
        }
      }
    }
  });

  test(`minimatch ${version} published source maps retain the patched source and correct line offsets`, () => {
    const packageRoot = resolveConsumers().find(consumer => consumer.version === version).packageRoot;
    for (const format of ["commonjs", "esm"]) {
      const directory = path.join(packageRoot, `dist/${format}`);
      const generated = readFileSync(path.join(directory, "index.js"), "utf8").split("\n");
      const map = JSON.parse(readFileSync(path.join(directory, "index.js.map"), "utf8"));
      const source = map.sourcesContent[0].split("\n");
      assert.match(map.sourcesContent[0], /globParts\.length >= braceExpandMax/);
      assert.match(map.sourcesContent[0], /if \(globParts\.length > 1000\) return globParts/);
      assert.match(generated.at(-1) || generated.at(-2), /sourceMappingURL=index\.js\.map/);
      const firstPhase = generated.findIndex(line => line.includes("firstPhasePreProcess(globParts) {"));
      for (const anchor of ["let didSomething = false;", "for (let i = 0; i < globParts.length - 1; i++) {"]) {
        const line = generated.findIndex((text, index) => index > firstPhase && text.trim() === anchor);
        assert.ok(line > firstPhase);
        const entry = new SourceMap(map).findEntry(line, generated[line].length - 1);
        assert.equal(source[entry.originalLine].trim().replace(": boolean", "").replace(/;$/, ""), anchor.replace(/;$/, ""));
      }
      const declarations = readFileSync(path.join(directory, "index.d.ts"), "utf8").split("\n");
      const declarationMap = JSON.parse(readFileSync(path.join(directory, "index.d.ts.map"), "utf8"));
      const line = declarations.findIndex(text => text.trim().startsWith("partsMatch("));
      assert.ok(line >= 0);
      const entry = new SourceMap(declarationMap).findEntry(line, declarations[line].indexOf("partsMatch"));
      assert.ok(source[entry.originalLine].trim().startsWith("partsMatch("));
    }
  });
}
