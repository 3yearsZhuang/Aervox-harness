import { existsSync, statSync } from "node:fs";
import { join, relative, sep, dirname, resolve } from "node:path";
import { parse } from "@babel/parser";

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
    const visit = node => {
      if (!node || typeof node !== "object" || typeof node.type !== "string") return;
      if ((node.type === "CallExpression" && node.callee?.type === "Identifier" && node.callee.name === "require") || node.type === "TSExternalModuleReference") {
        const argument = node.type === "TSExternalModuleReference" ? node.expression : node.arguments[0];
        if (argument?.type === "StringLiteral") out.push({ specifier: argument.value, kind: "runtime" });
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
        if (Array.isArray(child)) child.forEach(visit);
        else if (child && typeof child === "object") visit(child);
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

const CANDIDATE_EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".vue", "/index.ts"];
/** NodeNext 以 .js 引用 .ts 源：对 JS 扩展名做 TS 源回退 */
const JS_TO_TS = [
  [".js", [".ts", ".tsx"]],
  [".mjs", [".mts", ".ts"]],
  [".cjs", [".cts", ".ts"]],
];

/** 相对导入（./ ../）解析为仓库相对路径；解析不到返回 null */
export function resolveRepoRelative(fromRelFile, specifier) {
  specifier = stripImportSuffix(specifier);
  const hostPath = specifier.startsWith("@aervox/host-runtime/")
    ? specifier.slice("@aervox/host-runtime/".length) : null;
  const appAlias = specifier.startsWith("@/")
    ? (fromRelFile.startsWith("apps/desktop/") ? "apps/desktop/src/renderer/src" : fromRelFile.startsWith("apps/web/") ? "apps/web/src" : null) : null;
  if (hostPath === null && appAlias === null && !specifier.startsWith(".")) return null;
  const baseDir = dirname(join(process.cwd(), fromRelFile));
  const absTarget = appAlias !== null ? resolve(process.cwd(), appAlias, specifier.slice(2))
    : hostPath === null ? resolve(baseDir, specifier) : resolve(process.cwd(), "packages/host-runtime/src", hostPath);
  for (const ext of CANDIDATE_EXTS) {
    const candidate = absTarget + ext;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return relative(process.cwd(), candidate).split(sep).join("/");
    }
  }
  const jsMap = JS_TO_TS.find(([js]) => absTarget.endsWith(js));
  if (jsMap) {
    const stem = absTarget.slice(0, -jsMap[0].length);
    for (const tsExt of jsMap[1]) {
      const candidate = stem + tsExt;
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return relative(process.cwd(), candidate).split(sep).join("/");
      }
    }
  }
  return null;
}
