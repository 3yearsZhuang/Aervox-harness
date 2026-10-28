import { readdirSync, lstatSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { assertCoreSubmodule } from './core-submodule.mjs';

export function collectFiles(roots, { extensions, ignoreDirectories, sorted = false, cwd = process.cwd() }) {
  assertCoreSubmodule(cwd);
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let stat;
      try { stat = lstatSync(full); } catch { continue; }
      if (stat.isSymbolicLink()) continue;
      const rel = relative(cwd, full).split(sep).join("/");
      if (stat.isDirectory()) {
        if (!ignoreDirectories.test(rel)) walk(full);
      } else if (stat.isFile() && extensions.test(rel)) out.push(rel);
    }
  };
  for (const root of roots) {
    const dir = resolve(cwd, root);
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat?.isDirectory() && !stat.isSymbolicLink()) walk(dir);
  }
  return sorted ? out.sort() : out;
}
