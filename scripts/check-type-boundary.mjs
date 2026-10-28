/**
 * Aervox｜思隅 类型边界守卫（Contracts DTO 单一真源）
 *
 * 机器事实源：ADR-016「底座边界冻结」与 @aervox/contracts（唯一 DTO 事实源）。
 * 规则：
 * 禁止下游包（apps/*、packages/api-client/*、packages/ui/*）在本地手写重复声明
 * 已由 @aervox/contracts 导出的类型/接口，强制使用 `import from "@aervox/contracts"`。
 *
 * 用法：
 *   node scripts/check-type-boundary.mjs
 */

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parse } from "@babel/parser";

const CONTRACTS_SRC_DIR = "packages/contracts/src";
const TARGET_DIRS = [
  "packages/api-client/src",
  "packages/ui/src",
  "apps/web/src",
  "apps/desktop/src",
  "apps/api/src",
  "packages/host-runtime/src",
  "apps/worker/src",
  "apps/cli/src",
  "apps/mobile/src",
];

/**
 * 插件实现目录（实现内聚于 `plugins/<id>/src`，与宿主同受本规则约束）。
 * 动态发现而非硬编码，避免新增插件时漏检。
 */
export function discoverPluginSourceDirs(pluginsRoot = "plugins") {
  if (!existsSync(pluginsRoot)) return [];
  return readdirSync(pluginsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(pluginsRoot, entry.name, "src"))
    .filter((dir) => existsSync(dir));
}

const SOURCE_EXT_RE = /\.(ts|tsx|vue)$/;
const SCRIPT_BLOCK_RE = /<script\b[^>]*>([\s\S]*?)<\/script>/g;

export function collectContractExports(contractsDir = CONTRACTS_SRC_DIR) {
  const exportedNames = new Set();
  if (!existsSync(contractsDir)) return exportedNames;

  for (const entry of readdirSync(contractsDir)) {
    if (!entry.endsWith(".ts")) continue;
    const full = join(contractsDir, entry);
    const content = readFileSync(full, "utf8");
    let ast;
    try {
      ast = parse(content, { sourceType: "module", plugins: ["typescript"] });
    } catch (error) {
      throw new Error(`Cannot parse contract source ${full}: ${error.message}`);
    }
    for (const node of ast.program.body) {
      if (node.type === "ExportNamedDeclaration") {
        if (node.declaration) {
          if (node.declaration.id?.name) {
            exportedNames.add(node.declaration.id.name);
          }
          if (node.declaration.declarations) {
            for (const d of node.declaration.declarations) {
              if (d.id?.name) exportedNames.add(d.id.name);
            }
          }
        }
        if (node.specifiers) {
          for (const s of node.specifiers) {
            if (s.exported?.name) {
              exportedNames.add(s.exported.name);
            }
          }
        }
      }
    }
  }
  return exportedNames;
}

export function inspectFileForDuplicateTypes(filePath, content, exportedNames) {
  const duplicates = [];
  const inspectCode = (code, jsx = /\.[jt]sx$/.test(filePath)) => {
    let ast;
    try {
      ast = parse(code, { sourceType: "module", plugins: jsx ? ["typescript", "jsx"] : ["typescript"] });
    } catch (error) {
      throw new Error(`Cannot parse governed type source ${filePath}: ${error.message}`);
    }
    for (const node of ast.program.body) {
      let decl = node;
      if (node.type === "ExportNamedDeclaration" && node.declaration) {
        decl = node.declaration;
      }
      if (decl.type === "TSInterfaceDeclaration" || decl.type === "TSTypeAliasDeclaration") {
        const name = decl.id?.name;
        if (name && exportedNames.has(name)) {
          duplicates.push({
            file: filePath,
            name,
            line: decl.loc?.start?.line ?? 0,
            column: decl.loc?.start?.column ?? 0,
          });
        }
      }
    }
  };

  if (filePath.endsWith(".vue")) {
    for (const match of content.matchAll(SCRIPT_BLOCK_RE)) {
      inspectCode(match[1], /\blang\s*=\s*["'](?:t|j)sx["']/.test(match[0].split(">", 1)[0]));
    }
  } else {
    inspectCode(content);
  }

  return duplicates;
}

export function runInspection(
  targetDirs = [...TARGET_DIRS, ...discoverPluginSourceDirs("plugins"), ...discoverPluginSourceDirs("plugins/surfaces")],
  contractsDir = CONTRACTS_SRC_DIR,
) {
  const exportedNames = collectContractExports(contractsDir);
  const duplicates = [];

  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const stat = statSync(full, { throwIfNoEntry: false });
      if (!stat) continue;
      if (stat.isDirectory()) {
        walk(full);
      } else if (SOURCE_EXT_RE.test(entry)) {
        const content = readFileSync(full, "utf8");
        const rel = relative(process.cwd(), full).split(sep).join("/");
        duplicates.push(...inspectFileForDuplicateTypes(rel, content, exportedNames));
      }
    }
  };

  for (const d of targetDirs) {
    walk(d);
  }

  return duplicates;
}

/** Explicit migrated wire contracts, not a structural similarity detector for arbitrary types. */
export const DTO_ALIAS_CONTRACTS = new Map([
  ["packages/api-client/src/useAervoxMcp.ts", {
    McpPresetDto: "McpPresetServer", McpServerConfigDto: "McpServerConfig", McpServerToolDto: "McpServerToolEntry",
  }],
  ["packages/host-runtime/src/modules/ecosystem/mcp/service.ts", {
    McpPresetDto: "McpPresetServer", McpServerDto: "McpServerConfig", McpServerToolDto: "McpServerToolEntry",
  }],
  ["packages/api-client/src/useAervoxVoice.ts", {
    LocalVoiceConfigDto: "LocalVoiceConfigDraft", RemoteVoiceConfigDto: "RemoteVoiceConfigDraft",
    VoiceRemoteTestConnectionResultDto: "VoiceRemoteTestOutput", VoiceModelDto: "VoiceModelOutput",
    VoiceSynthesisResultDto: "VoiceSynthesisOutput", VoicePresetDto: "VoicePreset",
    VoiceInputConfigRefDto: "VoiceInputConfigOutput", VoicePresetListDto: "VoicePresetListResponse",
  }],
]);

/** Mixed owners retain unrelated projections; only these migrated names are governed. */
export const SCOPED_DTO_ALIAS_CONTRACTS = new Map([
  ["packages/api-client/src/useAervoxPersonas.ts", {
    PersonaDto: "Persona", PersonaRevisionConfigDto: "PersonaRevisionConfig", PersonaRevisionDto: "PersonaRevision",
    ActivePersonaSelectionDto: "ActivePersonaSelection", CreatePersonaInputDto: "CreatePersonaRequest", UpdatePersonaInputDto: "UpdatePersonaRequest",
  }],
]);

export const SCHEMA_TYPE_CONTRACTS = new Map([
  ["packages/contracts/src/persona-api.ts", {
    CreatePersonaRequest: ["input", "createPersonaRequestSchema"], UpdatePersonaRequest: ["input", "updatePersonaRequestSchema"],
    PersonaListResponse: ["output", "personaListResponseSchema"], PersonaDetailResponse: ["output", "personaDetailResponseSchema"],
    PersonaMutationResponse: ["output", "personaMutationResponseSchema"], PersonaImportResponse: ["output", "personaImportResponseSchema"],
    PersonaBundleResponse: ["output", "personaBundleResponseSchema"],
  }],
  ["plugins/focus-mode/src/contracts/terms.ts", {
    ExtractedTerm: ["infer", "extractedTermSchema"], TermsExtractedEventData: ["infer", "termsExtractedEventDataSchema"],
    TermExploreKind: ["infer", "termExploreKindSchema"], TermExploreRequest: ["infer", "termExploreRequestSchema"],
    TermExploreResponse: ["infer", "termExploreResponseSchema"],
  }],
  ["packages/contracts/src/mcp-schemas.ts", {
    McpPresetServer: ["infer", "mcpPresetServerSchema"], McpServerConfig: ["infer", "mcpServerConfigSchema"],
    McpServerToolEntry: ["infer", "mcpServerToolEntrySchema"],
  }],
  ["packages/contracts/src/persona-schemas.ts", {
    VoicePreset: ["infer", "voicePresetSchema"], VoicePresetListResponse: ["infer", "voicePresetListResponseSchema"],
    LocalVoiceConfigInput: ["input", "localVoiceConfigSchema"], LocalVoiceConfigOutput: ["output", "localVoiceConfigResponseSchema"],
    RemoteVoiceConfigInput: ["input", "remoteVoiceConfigSchema"], RemoteVoiceConfigOutput: ["output", "remoteVoiceConfigResponseSchema"],
    VoiceInputConfigOutput: ["output", "voiceInputConfigResponseSchema"], VoiceModelOutput: ["output", "voiceModelSchema"],
    VoiceSynthesisInput: ["input", "voiceSynthesisRequestSchema"], VoiceSynthesisOutput: ["output", "voiceSynthesisResponseSchema"],
    VoiceRemoteTestOutput: ["output", "voiceRemoteTestConnectionResponseSchema"],
    LocalVoiceConfigDraft: ["input", "localVoiceConfigResponseSchema"], RemoteVoiceConfigDraft: ["input", "remoteVoiceConfigResponseSchema"],
  }],
]);

export function inspectDtoDerivations(file, source) {
  const strictAliases = DTO_ALIAS_CONTRACTS.get(file);
  const aliases = strictAliases ?? SCOPED_DTO_ALIAS_CONTRACTS.get(file), schemas = SCHEMA_TYPE_CONTRACTS.get(file);
  if (!aliases && !schemas) return [];
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const declarations = new Map(), imported = new Map(), violations = [];
  let zod = false;
  const add = (name, message, node) => violations.push({ file, name, message, line: node?.loc?.start?.line ?? 1, column: 0 });
  for (const node of ast.program.body) {
    const declaration = node.type === "ExportNamedDeclaration" ? node.declaration : node;
    if (declaration?.type === "TSInterfaceDeclaration" || declaration?.type === "TSTypeAliasDeclaration") {
      declarations.set(declaration.id.name, declaration);
      if (strictAliases && declaration.id.name.endsWith("Dto")) add(declaration.id.name, "Migrated public wire DTOs must alias @aervox/contracts; no handwritten DTO declaration in this owner", declaration);
    }
    if ((node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration") && node.source?.value === "@aervox/contracts") {
      for (const specifier of node.specifiers ?? []) {
        const local = specifier.local?.name ?? specifier.exported?.name;
        const name = specifier.imported?.name ?? specifier.local?.name;
        const alias = node.type === "ExportNamedDeclaration" ? specifier.exported?.name : local;
        imported.set(alias, name);
      }
    }
    if (node.type === "ImportDeclaration" && node.source?.value === "zod") zod ||= node.specifiers.some(specifier => specifier.imported?.name === "z" && specifier.local.name === "z");
  }
  for (const [alias, original] of Object.entries(aliases ?? {})) {
    if (declarations.has(alias) || imported.get(alias) !== original) add(alias, `Expected contract alias ${original} as ${alias} from @aervox/contracts`, declarations.get(alias));
  }
  for (const [name, [mode, schema]] of Object.entries(schemas ?? {})) {
    const declaration = declarations.get(name), type = declaration?.typeAnnotation;
    const parameter = (type?.typeParameters ?? type?.typeArguments)?.params?.[0];
    if (!zod || declaration?.type !== "TSTypeAliasDeclaration" || type?.type !== "TSTypeReference"
      || type.typeName?.left?.name !== "z" || type.typeName?.right?.name !== mode
      || parameter?.type !== "TSTypeQuery" || parameter.exprName?.name !== schema) {
      add(name, `Expected public DTO derived as z.${mode}<typeof ${schema}>`, declaration);
    }
  }
  return violations;
}

export function runDtoDerivationInspection() {
  const violations = [];
  for (const file of new Set([...DTO_ALIAS_CONTRACTS.keys(), ...SCOPED_DTO_ALIAS_CONTRACTS.keys(), ...SCHEMA_TYPE_CONTRACTS.keys()])) {
    if (!existsSync(file)) violations.push({ file, name: "<source>", line: 1, column: 0, message: "Missing explicitly governed DTO source" });
    else violations.push(...inspectDtoDerivations(file, readFileSync(file, "utf8")));
  }
  return violations;
}

if (process.argv[1]?.endsWith("check-type-boundary.mjs")) {
  const duplicates = [...runInspection(), ...runDtoDerivationInspection()];
  if (duplicates.length > 0) {
    console.error(`Type ownership failed: ${duplicates.length} violations`);
    for (const d of duplicates) console.error(`${d.file}:${d.line}:${d.column} ${d.name}: ${d.message ?? "local declaration conflicts with @aervox/contracts; import its type instead"}`);
    process.exit(1);
  }
  console.log("Type ownership passed: no same-name contract redeclarations; explicit migrated MCP/Voice/Persona/Terms aliases derive from their declared Schema. This is not semantic equivalence detection for arbitrary DTO names.");
}
