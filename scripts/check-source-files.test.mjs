import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectFiles } from "./source-files.mjs";

test("shared traversal preserves root, extension and ignored-directory policies", () => {
  const root = mkdtempSync(join(tmpdir(), "aervox-source-files-"));
  try {
    for (const file of ["src/z.ts", "src/a.css", "src/out/generated.ts", "src/notes.md"]) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), "");
    }
    const options = { cwd: root, extensions: /\.(ts|css)$/, ignoreDirectories: /(^|\/)out(\/|$)/, sorted: true };
    assert.deepEqual(collectFiles(["src", "missing"], options), ["src/a.css", "src/z.ts"]);
    assert.deepEqual(collectFiles([join(root, "src")], { ...options, extensions: /\.ts$/ }), ["src/z.ts"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
