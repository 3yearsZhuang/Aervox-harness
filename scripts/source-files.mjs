import { readdirSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

export function collectFiles(roots, { extensions, ignoreDirectories, sorted = false, cwd = process.cwd() }) {
  const out = [];
  const walk = dir => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      let stat;
      try { stat = statSync(full); } catch { continue; }
      const rel = relative(cwd, full).split(sep).join("/");
      if (stat.isDirectory()) {
        if (!ignoreDirectories.test(rel)) walk(full);
      } else if (extensions.test(rel)) out.push(rel);
    }
  };
  for (const root of roots) {
    const dir = resolve(cwd, root);
    if (statSync(dir, { throwIfNoEntry: false })) walk(dir);
  }
  return sorted ? out.sort() : out;
}
