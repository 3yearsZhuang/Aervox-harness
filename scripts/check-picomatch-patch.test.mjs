import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const patchPath = "patches/picomatch@4.0.5.patch";
const reviews = JSON.parse(readFileSync(path.join(root, "scripts/dependency-audit-exceptions.json"), "utf8"))
  .filter(entry => entry.advisory === "GHSA-fc5q-39xc-vjpf" && entry.package === "picomatch");
const routes = reviews.flatMap(entry => entry.paths);
let consumers;

function resolveConsumers() {
  if (consumers) return consumers;
  const resolved = JSON.parse(execFileSync(process.execPath, [
    "--experimental-import-meta-resolve", "--input-type=module", "-e", `
      const routes = ${JSON.stringify(routes)};
      const root = ${JSON.stringify(pathToFileURL(root).href)};
      console.log(JSON.stringify(routes.map(route => {
        const [workspace, ...names] = route.split('>');
        let parent = new URL((workspace === '.' ? '' : workspace.replaceAll('__', '/') + '/') + 'package.json', root).href;
        for (const name of names) parent = import.meta.resolve(name, parent);
        return parent;
      })));
    `,
  ], { cwd: root, encoding: "utf8", timeout: 30_000 }));
  consumers = resolved.map((entry, index) => {
    const require = createRequire(entry);
    return { route: routes[index], entry: fileURLToPath(entry), require,
      packageRoot: path.dirname(require.resolve("picomatch/package.json")) };
  });
  return consumers;
}

function securityProbe(picomatch) {
  for (const pattern of ["+(*)", "+(*a)", "*(*a)", "+(a*)", "+(a*b)", "*(*.js)"]) {
    assert.doesNotMatch(picomatch.makeRe(pattern).source, /\)[+*]/, `unbounded repeat: ${pattern}`);
  }
  for (const pattern of ["+(*a)", "*(*a)", "+(*a)c"]) {
    for (const options of [{}, { capture: true }]) {
      assert.equal(picomatch.isMatch("a".repeat(50) + "b", pattern, options), false);
    }
  }
  for (const pattern of ["+(*?a)", "+(*[ab])", "+(*a|b)", '+(["a]*b)']) {
    const regex = picomatch.makeRe(pattern);
    assert.equal(regex.test(pattern), true, "complex bare-star branches use the literal safeguard");
    assert.equal(regex.test("a".repeat(50) + "!"), false);
  }
  for (const { pattern, input, options } of [
    { pattern: "+([*a)", input: "[a".repeat(40) + "!", options: {} },
    { pattern: "+(a[*b)", input: "a[b".repeat(40) + "!", options: {} },
    { pattern: "+([*a])", input: "[a]".repeat(40) + "!", options: { nobracket: true } },
    { pattern: '+([]"]*a)', input: "]a".repeat(40) + "!", options: {} },
  ]) {
    const regex = picomatch.makeRe(pattern, options);
    assert.equal(regex.test(pattern), true, "unmatched or disabled brackets cannot hide a wildcard");
    assert.equal(picomatch.isMatch(input, pattern, options), false);
  }
}

function runProbe(packageRoot) {
  return spawnSync(process.execPath, ["--max-old-space-size=128", "--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(${JSON.stringify(pathToFileURL(path.join(packageRoot, "package.json")).href)});
    (${securityProbe.toString()})(require(${JSON.stringify(packageRoot)}));
  `], { cwd: root, encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024 });
}

test("picomatch's exact repair is registered and runs before registry audit", () => {
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].version, "4.0.5");
  assert.ok(routes.length > 0);
  assert.equal(new Set(routes).size, routes.length);
  const workspace = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /^  picomatch@4\.0\.5: patches\/picomatch@4\.0\.5\.patch$/m);
  const patch = readFileSync(path.join(root, patchPath));
  const hash = createHash("sha256").update(patch).digest("hex");
  const lock = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  assert.ok(lock.includes(`  picomatch@4.0.5: ${hash}\n`));
  assert.ok(lock.includes(`  picomatch@4.0.5(patch_hash=${hash}):`));
  assert.ok(patch.includes(Buffer.from("+++ b/lib/parse.js")));
  const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  assert.ok(scripts["check:dependency-audit"].split(" && ")[0].includes("scripts/check-picomatch-patch.test.mjs"));
});

test("every reviewed route consumes the tested repair and preserves ordinary matching", async () => {
  const seen = new Set();
  for (const consumer of resolveConsumers()) {
    const manifest = JSON.parse(readFileSync(path.join(consumer.packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.version, "4.0.5", consumer.route);
    assert.equal(manifest.license, "MIT");
    const physical = realpathSync(consumer.packageRoot);
    if (seen.has(physical)) continue;
    seen.add(physical);
    for (const picomatch of [consumer.require("picomatch"), (await import(pathToFileURL(consumer.entry).href)).default]) {
      assert.equal(picomatch.isMatch("src/main.ts", "src/**/*.ts"), true);
      assert.equal(picomatch.isMatch("src/main.js", "src/**/*.ts"), false);
      assert.equal(picomatch.isMatch(".env", "*"), false);
      assert.equal(picomatch.isMatch(".env", "*", { dot: true }), true);
      assert.equal(picomatch.isMatch("abcabc", "+(abc)"), true);
      assert.equal(picomatch.isMatch("foobar", "*(foo|bar)"), true);
      const patterns = ["+(*)", "+(*a)", "*(*a)", "+(a*)", "+(a*b)", "*(*.js)", "x+(*a)y"];
      const inputs = ["", "a", "aa", "ab", "a.a", ".a", "a/b", "abc", "foo.js", "foo.ts", "xaay"];
      for (const options of [{}, { dot: true }, { windows: true }, { bash: true }]) {
        for (const pattern of patterns) {
          for (const input of inputs) {
            assert.deepEqual(picomatch.makeRe(pattern, options).exec(input),
              picomatch.makeRe(pattern, { ...options, maxExtglobRecursion: false }).exec(input),
              JSON.stringify({ pattern, input, options }));
          }
        }
      }
      const captured = picomatch.makeRe("+(*a)", { capture: true });
      assert.deepEqual(Array.from(captured.exec("+(*a)")), ["+(*a)"]);
      assert.equal(captured.test("aaa"), false);
      for (const pattern of ['+("*a")', "+(\\*a)"]) {
        assert.equal(picomatch.makeRe(pattern).source,
          picomatch.makeRe(pattern, { maxExtglobRecursion: false }).source);
        assert.equal(picomatch.isMatch("*a*a", pattern), true);
      }
      assert.equal(picomatch.makeRe("+([*]a)").source,
        picomatch.makeRe("+([*]a)", { maxExtglobRecursion: false }).source);
      assert.equal(picomatch.isMatch("*a*a", "+([*]a)"), true);
      for (const { pattern, input } of [
        { pattern: "+([]*a])", input: "aaa" },
        { pattern: "+([[:alpha:]*])", input: "a*" },
      ]) {
        assert.equal(picomatch.makeRe(pattern).source,
          picomatch.makeRe(pattern, { maxExtglobRecursion: false }).source);
        assert.equal(picomatch.isMatch(input, pattern), true);
      }
      assert.equal(picomatch.makeRe("+(a*)", { contains: true }).test("+(a*)"), true);
      assert.equal(picomatch.makeRe("+(a*)", { contains: true }).test("aaaa"), false);
      assert.equal(picomatch.isMatch("safe-path", "path", { contains: true }), true);
      for (const newline of ["\n", "\r", "\u2028", "\u2029"]) {
        const pattern = `+(a*${newline}b)`;
        assert.equal(picomatch.isMatch(`a${newline}ba${newline}b`, pattern), true);
        assert.equal(picomatch.makeRe(pattern, { bash: true }).test(pattern), true);
        assert.equal(picomatch.isMatch(`a${newline}ba${newline}b`, pattern, { bash: true }), false);
      }
    }
  }
});

test("malicious matches complete within a child deadline and the reversed original fails", t => {
  const packages = [...new Set(resolveConsumers().map(consumer => realpathSync(consumer.packageRoot)))];
  assert.ok(packages.length > 0);
  for (const packageRoot of packages) {
    const result = runProbe(packageRoot);
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const parent = path.join(root, "artifacts/picomatch-remediation");
    mkdirSync(parent, { recursive: true });
    const control = mkdtempSync(path.join(parent, "original-"));
    t.after(() => rmSync(control, { recursive: true, force: true }));
    cpSync(packageRoot, control, { recursive: true });
    execFileSync("git", ["apply", "--reverse", `--directory=${path.relative(root, control)}`,
      path.join(root, patchPath)], { cwd: root, encoding: "utf8" });
    const original = runProbe(control);
    assert.ifError(original.error);
    assert.equal(original.status, 1, "the published original must fail the same structural safety probe");
    assert.match(original.stderr, /unbounded repeat:/);
  }
});
