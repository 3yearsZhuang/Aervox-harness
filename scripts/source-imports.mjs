import { existsSync, statSync } from "node:fs";
import { join, relative, sep, dirname, resolve } from "node:path";
import { parse } from "@babel/parser";
import { discoverWorkspaces } from "./workspaces.mjs";

/** Scan raw SFC script blocks without interpreting tag-like JavaScript strings as new blocks. */
function vueScripts(source) {
  const fragments = [], external = [];
  const opening = /<!--|<script(?=[\s/>])/gi;
  let match;
  while ((match = opening.exec(source))) {
    if (match[0] === "<!--") {
      const end = source.indexOf("-->", opening.lastIndex);
      if (end < 0) throw new Error("unclosed Vue comment");
      opening.lastIndex = end + 3;
      continue;
    }
    const attributesStart = opening.lastIndex;
    let end = attributesStart, quote = null;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (end === source.length) throw new Error("unclosed Vue script opening tag");
    const rawAttributes = source.slice(attributesStart, end);
    const selfClosing = /\/\s*$/.test(rawAttributes);
    const attributes = new Map();
    for (const attribute of (selfClosing ? rawAttributes.replace(/\/\s*$/, "") : rawAttributes).matchAll(/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const name = attribute[1].toLowerCase();
      if (attributes.has(name)) throw new Error(`duplicate Vue script attribute: ${name}`);
      attributes.set(name, attribute[2] ?? attribute[3] ?? attribute[4] ?? null);
    }
    if (attributes.has("src")) {
      const src = attributes.get("src");
      if (!src || src.includes("&")) throw new Error("Vue script src must be an explicit static path without entities");
      external.push({ specifier: src, kind: "runtime" });
    }
    if (selfClosing) { opening.lastIndex = end + 1; continue; }
    const closing = /<\/script\s*>/gi;
    closing.lastIndex = end + 1;
    const close = closing.exec(source);
    if (!close) throw new Error("unclosed Vue script block");
    fragments.push({ text: source.slice(end + 1, close.index), file: /^(?:t|j)sx$/.test(attributes.get("lang")) ? "script.tsx" : "script.ts" });
    opening.lastIndex = closing.lastIndex;
  }
  return { fragments, external };
}

/** Shared AST import parser used by every architecture/removability check. */
export function extractImports(source, fileName, strict = false) {
  const { fragments, external: out } = fileName.endsWith(".vue") ? vueScripts(source) : { fragments: [{ text: source, file: fileName }], external: [] };
  for (const fragment of fragments) {
    const ast = parse(fragment.text, { sourceType: "module", plugins: /\.[jt]sx$/.test(fragment.file) ? ["typescript", "jsx"] : ["typescript"], createImportExpressions: true });
    const visit = (node, parent = null) => {
      if (!node || typeof node !== "object" || typeof node.type !== "string") return;
      if ((node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require") || node.type === "TSExternalModuleReference") {
        const argument = node.type === "TSExternalModuleReference" ? node.expression : node.arguments[0];
        if (argument?.type === "StringLiteral") out.push({ specifier: argument.value,
          kind: node.type === "TSExternalModuleReference" && parent?.type === "TSImportEqualsDeclaration" && parent.importKind === "type" ? "type" : "runtime" });
        else if (strict) throw new Error("纳管源码禁止无法静态解析的动态导入");
      }
      if (["ImportDeclaration", "ExportNamedDeclaration", "ExportAllDeclaration", "TSImportType", "ImportExpression"].includes(node.type)) {
        const arg = node.type === "TSImportType" ? node.argument ?? node.source : node.source;
        let specifier = arg?.value;
        if (!specifier && arg?.type === "TemplateLiteral" && arg.expressions.length === 0) specifier = arg.quasis[0].value.cooked;
        if (specifier) {
          const allType = node.specifiers?.length > 0 && node.specifiers.every(s => s.importKind === "type" || s.exportKind === "type");
          out.push({ specifier, kind: node.type === "TSImportType" || node.importKind === "type" || node.exportKind === "type" || allType ? "type" : "runtime" });
        } else if (strict && node.type === "ImportExpression") throw new Error("纳管源码禁止无法静态解析的动态导入");
      }
      for (const child of Object.values(node)) {
        if (Array.isArray(child)) child.forEach(value => visit(value, node));
        else if (child && typeof child === "object") visit(child, node);
      }
    };
    visit(ast.program);
  }
  return out;
}

export function extractSpecifiers(source, fileName, strict = false) {
  return extractImports(source, fileName, strict).map(entry => stripImportSuffix(entry.specifier));
}

/** Node/Vite URL suffixes do not change the source dependency; keep #package-import names intact. */
export function stripImportSuffix(specifier) {
  const suffix = specifier.search(/[?#]/);
  return suffix > 0 ? specifier.slice(0, suffix) : specifier;
}

const CANDIDATE_EXTS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs", ".vue", "/index.ts", "/index.tsx", "/index.js"];
/** NodeNext 以 .js 引用 .ts 源：对 JS 扩展名做 TS 源回退 */
const JS_TO_TS = [
  [".js", [".ts", ".tsx"]],
  [".mjs", [".mts", ".ts"]],
  [".cjs", [".cts", ".ts"]],
];

/** Resolve package export conditions to source without loading stale build output. */
function exportTarget(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(exportTarget).find(Boolean) ?? null;
  if (!value || typeof value !== "object") return null;
  for (const condition of ["source", "import", "default", "types"]) {
    const target = exportTarget(value[condition]);
    if (target) return target;
  }
  return null;
}

function workspaceExport(workspace, subpath) {
  const exports = workspace.manifest.exports;
  if (exports === undefined) return subpath === "." ? "./src/index.ts" : null;
  if (typeof exports === "string" || Array.isArray(exports) || !Object.keys(exports ?? {}).some(key => key.startsWith("."))) {
    return subpath === "." ? exportTarget(exports) : null;
  }
  if (Object.hasOwn(exports, subpath)) return exportTarget(exports[subpath]);
  const patterns = Object.keys(exports).filter(key => key.includes("*")).sort((a, b) => b.length - a.length);
  for (const key of patterns) {
    const [prefix, suffix] = key.split("*");
    if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
      const match = subpath.slice(prefix.length, suffix ? -suffix.length : undefined);
      const target = exportTarget(exports[key]);
      if (target) return target.replaceAll("*", match);
    }
  }
  return null;
}

let workspaceCache;
/** Relative, application alias and declared workspace exports resolve to current checkout source. */
export function resolveRepoRelative(fromRelFile, specifier, options = {}) {
  specifier = stripImportSuffix(specifier);
  const workspaces = options.workspaces ?? (workspaceCache ??= discoverWorkspaces());
  const workspace = workspaces.find(pkg => specifier === pkg.name || specifier.startsWith(`${pkg.name}/`));
  const appAlias = specifier.startsWith("@/")
    ? (fromRelFile.startsWith("apps/desktop/") ? "apps/desktop/src/renderer/src" : fromRelFile.startsWith("apps/web/") ? "apps/web/src" : null) : null;
  let absTarget;
  if (workspace) {
    const subpath = specifier === workspace.name ? "." : `.${specifier.slice(workspace.name.length)}`;
    // Private host paths must stay visible to boundary/removability checks. Resolving them
    // identifies the forbidden target; it does not grant a package export or import edge.
    const target = workspaceExport(workspace, subpath) ?? (workspace.name === "@aervox/host-runtime" && subpath !== "."
      ? `./src/${subpath.slice(2)}` : null);
    if (!target?.startsWith("./") || target.split("/").includes("..")) return null;
    // Build manifests publish dist, while source graphs must follow the source implementation.
    const sourceTarget = target.startsWith("./dist/")
      ? target.replace(/^\.\/dist\//, "./src/").replace(/\.d\.([cm]?ts)$/, ".$1") : target;
    absTarget = resolve(process.cwd(), workspace.relDir, sourceTarget);
  } else if (appAlias !== null) absTarget = resolve(process.cwd(), appAlias, specifier.slice(2));
  else if (specifier.startsWith(".")) absTarget = resolve(dirname(join(process.cwd(), fromRelFile)), specifier);
  else return null;
  const available = candidate => {
    const file = relative(process.cwd(), candidate).split(sep).join("/");
    if (options.files?.has(file) || (existsSync(candidate) && statSync(candidate).isFile())) return file;
    return null;
  };
  // NodeNext .js references must prefer .ts over incidental adjacent generated JS.
  const jsMap = JS_TO_TS.find(([js]) => absTarget.endsWith(js));
  if (jsMap) {
    const stem = absTarget.slice(0, -jsMap[0].length);
    for (const tsExt of jsMap[1]) { const file = available(stem + tsExt); if (file) return file; }
  }
  for (const ext of CANDIDATE_EXTS) { const file = available(absTarget + ext); if (file) return file; }
  return null;
}
