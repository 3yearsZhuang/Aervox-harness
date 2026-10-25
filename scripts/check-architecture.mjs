import { parse } from "@babel/parser";
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
      if (component.length > 1 || graph.get(node)?.has(node)) cycles.push(component.sort());
    }
  }
  for (const node of graph.keys()) if (!indexes.has(node)) visit(node);
  return cycles;
}

/** Exact physical Schema cycle: both table references are deferred by Drizzle references callbacks. */
export const LAZY_SCHEMA_CYCLES = [{
  files: ["packages/schema/src/memories.ts", "packages/schema/src/provenance.ts"],
  imports: [
    { from: "packages/schema/src/memories.ts", to: "packages/schema/src/provenance.ts", names: ["memoryRevisions"] },
    { from: "packages/schema/src/provenance.ts", to: "packages/schema/src/memories.ts", names: ["memoryRecords"] },
  ],
  reason: "Mutual physical foreign keys use only Drizzle .references(() => table.id); no eager table read is permitted.",
}];

/** An exception cannot authorize arbitrary eager reads inside an otherwise approved file pair. */
export function inspectLazySchemaImport(source, file, target, expectedNames, resolveSource = resolveRepoRelative) {
  const runtimeImports = extractImports(source, file, true).filter(edge => edge.kind === "runtime" && resolveSource(file, edge.specifier) === target);
  if (runtimeImports.length !== 1) return false;
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const names = new Set();
  for (const node of ast.program.body) {
    if (node.type !== "ImportDeclaration" || node.importKind === "type" || resolveSource(file, node.source.value) !== target) continue;
    for (const specifier of node.specifiers) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type" || specifier.local.name !== specifier.imported.name) return false;
      names.add(specifier.local.name);
    }
  }
  if ([...names].sort().join() !== [...expectedNames].sort().join()) return false;
  let valid = true, references = 0;
  const visit = (node, ancestors = []) => {
    if (!node || typeof node !== "object" || typeof node.type !== "string") return;
    if (node.type === "ImportDeclaration" || node.type === "TSTypeAliasDeclaration" || node.type === "TSInterfaceDeclaration") return;
    const parent = ancestors.at(-1);
    if (node.type === "Identifier" && names.has(node.name)) {
      const nonReference = parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
      if (!nonReference) {
        references++;
        const lazy = ancestors.some((ancestor, index) => ancestor.type === "ArrowFunctionExpression"
          && ancestors[index - 1]?.type === "CallExpression" && ancestors[index - 1].arguments[0] === ancestor
          && ancestors[index - 1].callee?.type === "MemberExpression"
          && ancestors[index - 1].callee.property?.name === "references");
        if (!lazy) valid = false;
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => visit(child, [...ancestors, node]));
      else if (value && typeof value === "object") visit(value, [...ancestors, node]);
    }
  };
  visit(ast.program);
  return valid && references > 0;
}

export function auditArchitecture({ sources = null } = {}) {
  const workspaces = discoverWorkspaces().filter(w => !w.relDir.startsWith("research/"));
  const files = sources ? [...sources.keys()] : collectFiles(workspaces.map(w => `${w.relDir}/src`), { extensions: /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue)$/, ignoreDirectories: /(^|\/)(node_modules|dist|out|reference|\.git)(\/|$)/ });
  const fileSet = new Set(files), text = new Map();
  const resolveSource = (from, specifier) => resolveRepoRelative(from, specifier, { workspaces, files: fileSet });
  const edges = [], moduleEdges = [], fileEdges = [], violations = [];
  const moduleOwner = file => file?.match(/^packages\/host-runtime\/src\/modules\/[^/]+\/[^/]+/)?.[0];
  for (const file of files) {
    const owner = workspaceOwner(file, workspaces);
    let imports;
    try {
      text.set(file, sources?.get(file) ?? readFileSync(file, "utf8"));
      imports = extractImports(text.get(file), file, true);
    } catch (error) { violations.push(`${file}: ${error.message}`); continue; }
    for (const { specifier, kind } of imports) {
      const target = resolveSource(file, specifier);
      const normalized = stripImportSuffix(specifier);
      const targetWorkspace = workspaces.find(w => normalized === w.name || normalized.startsWith(`${w.name}/`));
      if ((normalized.startsWith(".") || normalized.startsWith("@/") || targetWorkspace) && target === null) {
        violations.push(`${file}: source import or declared workspace export cannot be resolved: ${specifier}`);
      }
      const to = target ? workspaceOwner(target, workspaces)?.name : targetWorkspace?.name;
      if (to && owner?.name !== to) {
        edges.push({ from: owner?.name, to, kind });
        const error = inspectDependency(owner?.name, to);
        if (error) violations.push(`${file}: ${error}`);
      }
      if (target && fileSet.has(target)) fileEdges.push({ from: file, to: target, kind });
      if (owner?.name === "@aervox/sync-runtime" && /^(?:@libsql\/|drizzle-orm)/.test(specifier)) violations.push(`${file}: sync transport must consume SyncChangesetPort, not a database client`);
      const fromModule = moduleOwner(file), toModule = moduleOwner(target);
      if (fromModule && toModule && fromModule !== toModule) moduleEdges.push({ from: fromModule, to: toModule, kind });
    }
  }
  const graphs = Object.fromEntries([["workspace", edges], ["directModule", moduleEdges], ["file", fileEdges]].map(([layer, graph]) => [layer, {
    edges: graph, runtimeCycles: findCycles(graph, "runtime"), combinedCycles: findCycles(graph),
  }]));
  // Logical workspace/module cycles remain forbidden, even when one edge is erased at runtime.
  for (const [label, graph] of [["workspace", graphs.workspace], ["direct host module", graphs.directModule]]) {
    for (const cycle of graph.combinedCycles) violations.push(`${label} dependency cycle (including types): ${cycle.join(" -> ")}`);
  }
  const approvedRuntimeCycles = [];
  for (const cycle of graphs.file.runtimeCycles) {
    const approved = LAZY_SCHEMA_CYCLES.find(entry => [...entry.files].sort().join() === cycle.join());
    if (approved && approved.imports.every(edge => text.has(edge.from)
      && inspectLazySchemaImport(text.get(edge.from), edge.from, edge.to, edge.names, resolveSource))) {
      approvedRuntimeCycles.push({ files: cycle, reason: approved.reason });
    } else violations.push(`source file runtime dependency cycle: ${cycle.join(" -> ")}`);
  }
  return { files: files.length, edges, moduleEdges, fileEdges, graphs, approvedRuntimeCycles, violations };
}

if (process.argv[1]?.endsWith("check-architecture.mjs")) {
  const result = auditArchitecture();
  for (const [layer, graph] of Object.entries(result.graphs)) {
    console.log(`${layer}: ${graph.edges.filter(e => e.kind === "runtime").length} runtime edges, ${graph.edges.filter(e => e.kind === "type").length} type edges; ${graph.runtimeCycles.length} runtime SCCs, ${graph.combinedCycles.length} SCCs including types`);
  }
  for (const cycle of result.approvedRuntimeCycles) console.log(`Approved lazy Schema FK SCC: ${cycle.files.join(", ")} (${cycle.reason})`);
  for (const cycle of result.graphs.file.combinedCycles) {
    if (result.graphs.file.runtimeCycles.some(runtime => runtime.length === cycle.length && runtime.every(file => cycle.includes(file)))) continue;
    console.log(`File SCC requiring type edges (${cycle.length} files):\n${cycle.map(file => `  ${file}`).join("\n")}`);
  }
  if (result.violations.length) {
    result.violations.forEach(error => console.error(error)); process.exitCode = 1;
  } else console.log(`Architecture passed: ${result.files} source files; no unapproved runtime file cycles. Type-inclusive SCCs are reported above, not claimed absent.`);
}
