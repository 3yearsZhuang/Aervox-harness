import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function validExpiry(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value;
}

/** Every version and dependency path must be reviewed; network/schema errors fail closed. */
export function assessAudit(report, exceptions, today = new Date().toISOString().slice(0, 10)) {
  if (!report || report.error || !report.advisories || typeof report.advisories !== "object" || Array.isArray(report.advisories)) throw new Error("Invalid dependency audit response");
  if (!Array.isArray(exceptions) || exceptions.some(entry => !entry || !Array.isArray(entry.paths) || !entry.paths.length || entry.paths.some(path => typeof path !== "string" || !path))) throw new Error("Invalid dependency audit exceptions");
  const outstanding = [];
  const reviewed = [];
  const used = exceptions.map(() => new Set());
  for (const advisory of Object.values(report.advisories)) {
    if (!advisory.github_advisory_id || !advisory.module_name || !Array.isArray(advisory.findings) || !advisory.findings.length) throw new Error("Incomplete dependency advisory");
    for (const finding of advisory.findings) {
      if (!finding.version || !Array.isArray(finding.paths) || !finding.paths.length) throw new Error("Incomplete dependency finding");
      for (const path of finding.paths) {
        const key = `${advisory.github_advisory_id} ${advisory.module_name}@${finding.version} ${path}`;
        const index = exceptions.findIndex(entry => entry.advisory === advisory.github_advisory_id && entry.package === advisory.module_name && entry.version === finding.version && entry.paths?.includes(path));
        const entry = exceptions[index];
        if (entry && entry.owner && entry.reason && validExpiry(entry.expiresOn) && entry.expiresOn >= today) {
          used[index].add(path); reviewed.push(key);
        } else outstanding.push(key);
      }
    }
  }
  const stale = exceptions.flatMap((entry, index) => {
    const paths = entry.paths.filter(path => !used[index].has(path));
    return paths.length ? [{ ...entry, paths }] : [];
  });
  return { outstanding, reviewed, stale };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = spawnSync("pnpm", ["audit", "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (result.error || ![0, 1].includes(result.status)) throw result.error ?? new Error(result.stderr || "Dependency audit failed");
    const exceptions = JSON.parse(readFileSync(new URL("./dependency-audit-exceptions.json", import.meta.url), "utf8"));
    const assessment = assessAudit(JSON.parse(result.stdout), exceptions);
    console.log(`Dependency audit: ${assessment.outstanding.length} unreviewed paths; ${assessment.reviewed.length} reviewed paths; ${assessment.stale.length} expired or obsolete exceptions.`);
    for (const finding of assessment.outstanding) console.error(finding);
    for (const entry of assessment.stale) console.error(`Review exception: ${entry.advisory} ${entry.package}@${entry.version} ${entry.paths.join(", ")}`);
    if (assessment.outstanding.length || assessment.stale.length) process.exitCode = 1;
  } catch (error) { console.error(String(error)); process.exitCode = 1; }
}
