import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const patchPath = "patches/deepmerge@4.3.1.patch";
const dependencyPaths = [
  ["@langchain/community", "@browserbasehq/stagehand", "deepmerge"],
  ["@langchain/community", "html-to-text", "deepmerge"],
  ["llamaindex", "@llamaindex/node-parser/html", "html-to-text", "deepmerge"],
];

// Resolve with each real parent's exports. node-parser only exports subpaths,
// and its html entry owns the html-to-text dependency in the third audit path.
const resolvedPaths = JSON.parse(execFileSync(process.execPath, [
  "--experimental-import-meta-resolve", "--input-type=module", "-e", `
    const paths = ${JSON.stringify(dependencyPaths)};
    const start = ${JSON.stringify(pathToFileURL(path.join(root, "research/deletion-fault-testing/package.json")).href)};
    console.log(JSON.stringify(paths.map(names => {
      let parent = start;
      return names.map(name => {
        parent = import.meta.resolve(name, parent);
        return parent;
      });
    })));
  `,
], { cwd: root, encoding: "utf8" }));

function assertUnpoisoned(value) {
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(value.isAdmin, undefined);
  assert.equal(Object.hasOwn(value, "isAdmin"), false);
  const descriptor = Object.getOwnPropertyDescriptor(value, "__proto__");
  if (descriptor) {
    assert.equal(descriptor.value.isAdmin, true);
    assert.equal(descriptor.enumerable, true);
    assert.equal(descriptor.writable, true);
    assert.equal(descriptor.configurable, true);
    assert.equal(descriptor.get, undefined);
    assert.equal(descriptor.set, undefined);
  }
  assert.equal(Object.prototype.isAdmin, undefined);
  assert.equal(({}).isAdmin, undefined);
}

function assertPrototypeSafety(merge) {
  const payload = () => JSON.parse('{"__proto__":{"isAdmin":true}}');
  // GHSA-gcqx-w48m-w2h4 / upstream issue #273: source writes with a
  // null-prototype target, or nested null/undefined/primitive placeholders.
  assertUnpoisoned(merge(Object.create(null), payload()));
  for (const session of [null, undefined, 0, "placeholder", false]) {
    assertUnpoisoned(merge({ session }, { session: payload() }).session);
  }
  // The target-copy loop is independently vulnerable, even with an empty source.
  assertUnpoisoned(merge(payload(), {}));
  assertUnpoisoned(merge({ session: payload() }, {}).session);
  const ownTarget = () => JSON.parse('{"__proto__":{}}');
  assertUnpoisoned(merge(ownTarget(), payload()));
  // Exercise the third write site: the result of a custom merge function.
  const custom = merge(ownTarget(), payload(), {
    customMerge: key => key === "__proto__" ? () => ({ isAdmin: true }) : undefined,
  });
  assertUnpoisoned(custom);
  assert.ok(Object.hasOwn(custom, "__proto__"));
  assertUnpoisoned(merge(payload(), {}, { clone: false }));
}

function assertMergeSemantics(merge) {
  const target = { nested: { left: true }, values: [{ a: 1 }] };
  const source = { nested: { right: true }, values: [{ b: 2 }] };
  const merged = merge(target, source);
  assert.deepEqual(merged, { nested: { left: true, right: true }, values: [{ a: 1 }, { b: 2 }] });
  assert.notEqual(merged.nested, target.nested);
  assert.notEqual(merged.values[0], target.values[0]);
  assert.deepEqual(target, { nested: { left: true }, values: [{ a: 1 }] });
  assert.deepEqual(source, { nested: { right: true }, values: [{ b: 2 }] });
  assert.deepEqual(merge.all([{ x: { a: 1 } }, { x: { b: 2 } }, { y: 3 }]), { x: { a: 1, b: 2 }, y: 3 });
  assert.deepEqual(merge.all([]), {});
  assert.throws(() => merge.all({}), /first argument should be an array/);
  assert.deepEqual(merge([1], { x: 2 }), { x: 2 });
  assert.deepEqual(merge({ x: 2 }, [1]), [1]);
  assert.equal(merge({}, { nested: source.nested }, { clone: false }).nested, source.nested);
  const date = new Date(0);
  const regexp = /example/;
  assert.equal(merge({}, { date, regexp }).date, date);
  assert.equal(merge({}, { date, regexp }).regexp, regexp);
  const symbol = Symbol("enumerable");
  const hidden = Symbol("hidden");
  const symbolSource = { [symbol]: { x: true } };
  Object.defineProperty(symbolSource, hidden, { value: 1 });
  const symbolResult = merge({}, symbolSource);
  assert.deepEqual(symbolResult[symbol], { x: true });
  assert.equal(Object.hasOwn(symbolResult, hidden), false);
  // Preserve valid own constructor/prototype fields and inherited-key guards.
  assert.deepEqual(merge({ constructor: { left: 1 }, prototype: { a: 1 } }, {
    constructor: { right: 2 }, prototype: { b: 2 },
  }), { constructor: { left: 1, right: 2 }, prototype: { a: 1, b: 2 } });
  assert.equal(Object.hasOwn(merge({}, { constructor: { bad: true } }), "constructor"), false);
  assert.equal(Object.hasOwn(merge({}, { toString: "bad" }), "toString"), false);
  assert.deepEqual(merge({ config: { x: 1 } }, { config: { y: 2 } }, {
    customMerge: key => key === "config" ? (left, right) => ({ sum: left.x + right.y }) : undefined,
  }), { config: { sum: 3 } });
  assert.deepEqual(merge({ values: [1] }, { values: [2] }, {
    arrayMerge: (_left, right, options) => right.map(value => options.cloneUnlessOtherwiseSpecified(value, options)),
  }), { values: [2] });
  const instance = new (class Example { constructor() { this.value = 1; } })();
  assert.equal(merge({}, { instance }, {
    isMergeableObject: value => value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype,
  }).instance, instance);
}

test("deepmerge's exact patch is registered, locked and required before dependency audit", () => {
  const workspace = readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8");
  assert.match(workspace, /^  deepmerge@4\.3\.1: patches\/deepmerge@4\.3\.1\.patch$/m);
  const patch = readFileSync(path.join(root, patchPath));
  const hash = createHash("sha256").update(patch).digest("hex");
  const lock = readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
  assert.match(lock, new RegExp(`^  deepmerge@4\\.3\\.1: ${hash}$`, "m"));
  assert.match(lock, new RegExp(`^  deepmerge@4\\.3\\.1\\(patch_hash=${hash}\\): \\{\\}$`, "m"));
  for (const entry of ["index.js", "dist/cjs.js", "dist/umd.js"]) {
    assert.ok(patch.includes(Buffer.from(`+++ b/${entry}`)), `${entry} is patched`);
  }
  const scripts = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).scripts;
  assert.match(scripts["check:dependency-audit"], /^node --test scripts\/check-deepmerge-patch\.test\.mjs && node scripts\/check-dependency-audit\.mjs$/);
  assert.match(scripts["check:guards"], /node --test scripts\/check-\*\.test\.mjs/);
});

for (const [index, names] of dependencyPaths.entries()) {
  const chain = resolvedPaths[index];
  const parent = fileURLToPath(chain.at(-2));
  const require = createRequire(parent);
  const cjsEntry = require.resolve("deepmerge");
  const esmEntry = fileURLToPath(chain.at(-1));
  const packageRoot = path.dirname(path.dirname(cjsEntry));

  test(`deepmerge's actual ${names.join(" > ")} CJS and ESM entries resist poisoning`, async () => {
    assert.equal(realpathSync(cjsEntry), realpathSync(esmEntry));
    assert.equal(path.relative(packageRoot, cjsEntry), "dist/cjs.js");
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(manifest.version, "4.3.1");
    assert.equal(manifest.license, "MIT");
    for (const merge of [require("deepmerge"), (await import(chain.at(-1))).default]) {
      assertPrototypeSafety(merge);
      assertMergeSemantics(merge);
    }
  });
}

const packageRoot = path.dirname(path.dirname(fileURLToPath(resolvedPaths[0].at(-1))));
const require = createRequire(path.join(packageRoot, "package.json"));

test("deepmerge's published UMD entry preserves merge semantics and resists poisoning", () => {
  const merge = require("./dist/umd.js");
  assertPrototypeSafety(merge);
  assertMergeSemantics(merge);
});

test("deepmerge's source entry is patched along with its bundled default predicate", () => {
  // index.js imports a devDependency omitted from deepmerge's published runtime
  // dependencies. Supply the very same predicate inlined by its published build.
  const bundledSource = readFileSync(path.join(packageRoot, "dist/cjs.js"), "utf8");
  const predicate = new Function(`${bundledSource.slice(0, bundledSource.indexOf("function emptyTarget"))}; return isMergeableObject;`)();
  const module = { exports: {} };
  new Function("require", "module", readFileSync(path.join(packageRoot, "index.js"), "utf8"))(
    name => { assert.equal(name, "is-mergeable-object"); return predicate; }, module,
  );
  assertPrototypeSafety(module.exports);
  assertMergeSemantics(module.exports);
});
