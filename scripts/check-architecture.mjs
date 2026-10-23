import { readFileSync } from "node:fs";
import { collectFiles } from "./source-files.mjs";
import { extractImports, resolveRepoRelative, stripImportSuffix } from "./source-imports.mjs";
import { discoverWorkspaces, workspaceOwner } from "./workspaces.mjs";

const names = values => values.split(" ").filter(Boolean).map(v => `@aervox/${v}`);
/** Reviewed allowed dependencies; package declarations alone cannot grant an architecture edge. */
export const ALLOWED_DEPENDENCIES = new Map(Object.entries({
  api: names("config host-runtime"), cli: names("api-client"), mobile: names("web"),
  desktop: names("api-client contracts native-runtime ui ui-host live2d public plugin-companion-ui plugin-focus-mode plugin-panels-ui plugin-proactive-ui plugin-workbench-ui"),
  web: names("api-client contracts ui ui-host live2d public plugin-focus-mode plugin-panels-ui plugin-proactive-ui plugin-workbench-ui"),
  worker: names("config contracts core diary host-agent host-runtime observability process-coordination repositories schema"),
  contracts: [], config: [], core: [], schema: [], "native-runtime": [], observability: [], "practice-review": [],
  "process-coordination": [], "sync-runtime": [], live2d: [], public: [], "ui-host": [],
  "api-client": names("contracts"), ui: names("contracts api-client"), diary: names("contracts"),
  "host-agent": names("core observability repositories schema"), "host-plugin-api": names("core contracts"),
  repositories: names("contracts schema native-runtime sync-runtime process-coordination"),
  "host-runtime": names("config contracts core diary host-agent host-plugin-api native-runtime observability repositories schema practice-review process-coordination plugin-focus-mode plugin-bot-onebot plugin-bot-weixin"),
  "plugin-focus-mode": names("api-client contracts core host-plugin-api ui"),
  "plugin-bot-onebot": names("host-plugin-api"), "plugin-bot-weixin": names("host-plugin-api"),
  "plugin-companion-ui": names("api-client contracts ui ui-host"), "plugin-panels-ui": names("api-client contracts ui"),
  "plugin-proactive-ui": names("api-client contracts ui ui-host"), "plugin-workbench-ui": names("api-client contracts ui ui-host"),
}).map(([key, value]) => [`@aervox/${key}`, new Set(value)]));

export function inspectDependency(from, to) {
  if (from === to) return null;
  if (!ALLOWED_DEPENDENCIES.has(from)) return `undeclared architecture owner: ${from}`;
  if (!ALLOWED_DEPENDENCIES.get(from).has(to)) return `architecture dependency is not allowed: ${from} -> ${to}`;
  return null;
}

export function findCycles(edges, kind) {
  const graph = new Map();
  for (const edge of edges) {
    if (kind && edge.kind !== kind) continue;
    if (!graph.has(edge.from)) graph.set(edge.from, new Set());
    graph.get(edge.from).add(edge.to);
  }
  let counter = 0;
  const indexes = new Map(), low = new Map(), stack = [], active = new Set(), cycles = [];
  function visit(node) {
    indexes.set(node, counter); low.set(node, counter++); stack.push(node); active.add(node);
    for (const to of graph.get(node) ?? []) {
      if (!indexes.has(to)) { visit(to); low.set(node, Math.min(low.get(node), low.get(to))); }
      else if (active.has(to)) low.set(node, Math.min(low.get(node), indexes.get(to)));
    }
    if (low.get(node) === indexes.get(node)) {
      const component = []; let current;
      do { current = stack.pop(); active.delete(current); component.push(current); } while (current !== node);
      if (component.length > 1) cycles.push(component.sort());
    }
  }
  for (const node of graph.keys()) if (!indexes.has(node)) visit(node);
  return cycles;
}

export function auditArchitecture({ sources = null } = {}) {
  const workspaces = discoverWorkspaces().filter(w => !w.relDir.startsWith("research/"));
  const files = sources ? [...sources.keys()] : collectFiles(workspaces.map(w => `${w.relDir}/src`), { extensions: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/, ignoreDirectories: /(^|\/)(node_modules|dist|out|reference|\.git)(\/|$)/ });
  const edges = [], moduleEdges = [], violations = [];
  const moduleOwner = file => file?.match(/^packages\/host-runtime\/src\/modules\/[^/]+\/[^/]+/)?.[0];
  for (const file of files) {
    const owner = workspaceOwner(file, workspaces);
    let imports;
    try { imports = extractImports(sources?.get(file) ?? readFileSync(file, "utf8"), file, true); }
    catch (error) { violations.push(`${file}: ${error.message}`); continue; }
    for (const { specifier, kind } of imports) {
      const target = resolveRepoRelative(file, specifier);
      const normalized = stripImportSuffix(specifier);
      if ((normalized.startsWith(".") || normalized.startsWith("@/")) && target === null) violations.push(`${file}: source relative import cannot be resolved: ${specifier}`);
      const to = target ? workspaceOwner(target, workspaces)?.name : workspaces.find(w => normalized === w.name || normalized.startsWith(`${w.name}/`))?.name;
      if (to && owner.name !== to) {
        edges.push({ from: owner.name, to, kind });
        const error = inspectDependency(owner.name, to);
        if (error) violations.push(`${file}: ${error}`);
      }
      if (owner.name === "@aervox/sync-runtime" && /^(?:@libsql\/|drizzle-orm)/.test(specifier)) violations.push(`${file}: sync transport must consume SyncChangesetPort, not a database client`);
      const fromModule = moduleOwner(file), toModule = moduleOwner(target);
      if (fromModule && toModule && fromModule !== toModule) moduleEdges.push({ from: fromModule, to: toModule, kind });
    }
  }
  for (const [label, graph] of [["workspace", edges], ["host module", moduleEdges]]) {
    for (const cycle of findCycles(graph)) violations.push(`${label} dependency cycle (including types): ${cycle.join(" -> ")}`);
  }
  return { files: files.length, edges, moduleEdges, violations };
}

if (process.argv[1]?.endsWith("check-architecture.mjs")) {
  const result = auditArchitecture();
  if (result.violations.length) {
    result.violations.forEach(error => console.error(error)); process.exitCode = 1;
  } else console.log(`Architecture passed: ${result.files} source files, ${result.edges.filter(e => e.kind === "runtime").length} runtime and ${result.edges.filter(e => e.kind === "type").length} type edges, no cycles`);
}
