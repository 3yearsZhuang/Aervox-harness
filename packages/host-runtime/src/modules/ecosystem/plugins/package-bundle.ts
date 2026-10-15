/**
 * Aervox｜思隅 @aervox/api — 插件打包、分发包预检与集市引擎（CAP-020）
 *
 * 职责：
 * 1. 内存安全解包与安全校验（防目录穿越、超限文件、非法路径）；
 * 2. 安装前预检（inspectPluginBundle）：严格对齐 PRD CAP-020 验收门禁，
 *    提供发布者、版本、SHA-256、所需权限、数据范围与能力明细；
 * 3. 分发包预检与顺序安装（installPluginFromBundle）：从 .aervox-plugin / zip
 *    解包并完整同步插件、工具、技能、配置 Schema、Page 资源与主动规则；
 * 4. 插件打包导出（exportPluginBundle）：生成标准的 .aervox-plugin 单文件分发包；
 * 5. 官方与出厂插件集市（listMarketPlugins / installFromMarket）。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { strFromU8, strToU8 } from "fflate";
import { executeArchive, ARCHIVE_LIMITS, isSafeArchivePath } from "../../../shared/archive-worker.js";
import {
  pluginManifestSchema,
  validatePluginBundleFiles,
  type PluginConfigField,
  type PluginManifest,
  type PluginPackageInspection,
  type PluginMarketItem,
  type PluginDeclaredTool,
  type PluginDeclaredSkill,
} from "@aervox/contracts";
import type {
  SqliteExtensionRepository,
  SqlitePluginConfigRepository,
  SqlitePluginPageRepository,
  SqliteSkillRegistryRepository,
  SqliteToolRegistryRepository,
  PluginModel,
} from "@aervox/repositories";
import { withSkillMutation, parseFrontmatter, isValidSkillName } from "../skills/index.js";
import type { PluginBundleStore } from "./bundle-store.js";
import type { PluginConfigService } from "./config-service.js";
import type { PluginService } from "./service.js";
import { parseConfigSchema, diffSchema, validateValues } from "./config-schema.js";

export const PLUGIN_ARCHIVE_LIMITS = ARCHIVE_LIMITS;

/** Bound declared and actual expansion before accepting archive contents. */
async function unpackPluginBundle(bytes: Uint8Array, signal?: AbortSignal): Promise<Record<string, Uint8Array>> {
  return executeArchive({ kind: "unpack", input: bytes, limits: PLUGIN_ARCHIVE_LIMITS, isSafePath: isSafeZipEntryPath, signal });
}

/** 单条目路径安全校验（拒绝绝对路径、.. 段、反斜杠穿越、超限路径） */
export const isSafeZipEntryPath = isSafeArchivePath;

export class PluginAlreadyExistsError extends Error {
  readonly code = "PLUGIN_ALREADY_EXISTS";
  constructor(message: string) {
    super(message);
    this.name = "PluginAlreadyExistsError";
  }
}

export interface BundleEngineDeps {
  extensionRepo: SqliteExtensionRepository;
  configRepo: SqlitePluginConfigRepository;
  pageRepo: SqlitePluginPageRepository;
  registry: SqliteToolRegistryRepository;
  skillRegistry: SqliteSkillRegistryRepository;
  skillsRoot: string;
  configService: PluginConfigService;
  bundleStore: PluginBundleStore;
  builtinPluginsSourceRoot: string;
  service: PluginService;
}

/** Resolve the same names, descriptions and source bytes for preview and activation. */
function resolveBundleSkills(
  manifest: PluginManifest,
  files: Readonly<Record<string, Uint8Array>>,
): { skills: Array<PluginDeclaredSkill & { content: string; description: string }>; issues: string[] } {
  const skills: Array<PluginDeclaredSkill & { content: string; description: string }> = [];
  const issues: string[] = [];
  const names = new Set<string>();
  const claimedEntries = new Set<string>();
  const readEntry = (entry: string): string | undefined => {
    const bytes = files[entry];
    if (!bytes?.length) {
      issues.push(`Missing or empty skill entry: ${entry}`);
      return undefined;
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      issues.push(`Invalid UTF-8 skill entry: ${entry}`);
      return undefined;
    }
  };
  const add = (name: string, content: string, description?: string) => {
    if (names.has(name)) return;
    names.add(name);
    skills.push({ name, content, description: description ?? (parseFrontmatter(content).description || name) });
  };

  // Explicit named declarations take precedence over conventional file discovery.
  for (const skill of manifest.spec.skills ?? []) {
    if (skill.entry) claimedEntries.add(skill.entry);
    const content = skill.entry ? readEntry(skill.entry) : skill.content ?? "";
    if (content !== undefined) add(skill.name, content, skill.description);
  }

  const rootEntry = manifest.spec.skill ?? (files["SKILL.md"] ? "SKILL.md" : files["skill.md"] ? "skill.md" : undefined);
  if (rootEntry) {
    if (!claimedEntries.has(rootEntry) && !names.has(manifest.metadata.id)) {
      const content = readEntry(rootEntry);
      if (content !== undefined) {
        add(manifest.metadata.id, content, parseFrontmatter(content).description || manifest.metadata.description);
      }
    }
    claimedEntries.add(rootEntry);
  }

  // Stable ordering also makes SKILL.md win over skill.md if both are present.
  for (const entry of Object.keys(files).sort()) {
    if (claimedEntries.has(entry) || !entry.startsWith("skills/") || (!entry.endsWith("/SKILL.md") && !entry.endsWith("/skill.md"))) continue;
    const name = entry.split("/")[1];
    if (!name || names.has(name)) continue;
    const content = readEntry(entry);
    if (content !== undefined) add(name, content);
  }
  return { skills, issues };
}

/**
 * 预检插件分发包（内存解包与静态结构分析，零副作用）
 */
export async function inspectPluginBundle(
  bytes: Uint8Array,
  deps?: { extensionRepo?: SqliteExtensionRepository },
  signal?: AbortSignal,
): Promise<PluginPackageInspection> {
  const checksum = createHash("sha256").update(bytes).digest("hex");

  let files: Record<string, Uint8Array>;
  try {
    files = await unpackPluginBundle(bytes, signal);
  } catch (e) {
    signal?.throwIfAborted();
    return {
      id: "",
      displayName: "",
      publisher: "",
      version: "",
      description: "",
      license: "",
      checksum,
      signature: null,
      permissions: [],
      dataScope: [],
      tools: [],
      skills: [],
      pages: [],
      proactive: { sensors: [], triggers: [] },
      hasConfig: false,
      alreadyInstalled: false,
      installedVersion: null,
      isValid: false,
      issues: [
        "Corrupted or invalid ZIP archive: " +
          (e instanceof Error ? e.message : String(e)),
      ],
    };
  }

  // 安全路径核验
  for (const entryName of Object.keys(files)) {
    if (!isSafeZipEntryPath(entryName)) {
      return {
        id: "",
        displayName: "",
        publisher: "",
        version: "",
        description: "",
        license: "",
        checksum,
        signature: null,
        permissions: [],
        dataScope: [],
        tools: [],
        skills: [],
        pages: [],
        proactive: { sensors: [], triggers: [] },
        hasConfig: false,
        alreadyInstalled: false,
        installedVersion: null,
        isValid: false,
        issues: [`Unsafe entry path in archive: ${entryName}`],
      };
    }
  }

  const manifestBytes =
    files["plugin.manifest.json"] ?? files["manifest.json"];
  if (!manifestBytes) {
    return {
      id: "",
      displayName: "",
      publisher: "",
      version: "",
      description: "",
      license: "",
      checksum,
      signature: null,
      permissions: [],
      dataScope: [],
      tools: [],
      skills: [],
      pages: [],
      proactive: { sensors: [], triggers: [] },
      hasConfig: false,
      alreadyInstalled: false,
      installedVersion: null,
      isValid: false,
      issues: ["Missing plugin.manifest.json in archive root"],
    };
  }

  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(strFromU8(manifestBytes));
  } catch {
    return {
      id: "",
      displayName: "",
      publisher: "",
      version: "",
      description: "",
      license: "",
      checksum,
      signature: null,
      permissions: [],
      dataScope: [],
      tools: [],
      skills: [],
      pages: [],
      proactive: { sensors: [], triggers: [] },
      hasConfig: false,
      alreadyInstalled: false,
      installedVersion: null,
      isValid: false,
      issues: ["Invalid JSON in plugin.manifest.json"],
    };
  }

  const parsed = pluginManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    return {
      id: "",
      displayName: "",
      publisher: "",
      version: "",
      description: "",
      license: "",
      checksum,
      signature: null,
      permissions: [],
      dataScope: [],
      tools: [],
      skills: [],
      pages: [],
      proactive: { sensors: [], triggers: [] },
      hasConfig: false,
      alreadyInstalled: false,
      installedVersion: null,
      isValid: false,
      issues: parsed.error.issues.map(
        (issue) => `${issue.path.join(".")}: ${issue.message}`,
      ),
    };
  }

  const manifest = parsed.data;
  const pluginId = manifest.metadata.id;
  const issues: string[] = [];
  const configEntry = manifest.spec.config?.entry ?? "config.schema.json";
  if (manifest.spec.config || files[configEntry]) {
    try {
      if (!files[configEntry]) throw new Error(`Missing config entry: ${configEntry}`);
      parseConfigSchema(JSON.parse(strFromU8(files[configEntry])));
    } catch (error) {
      issues.push(error instanceof Error ? error.message : "Invalid config schema");
    }
  }
  const validation = validatePluginBundleFiles(files);
  issues.push(...validation.issues.map(issue => `${issue.path}: ${issue.message}`));
  const pageIds = new Set<string>();
  for (const page of manifest.spec.pages ?? []) {
    if (pageIds.has(page.id)) issues.push(`Duplicate page: ${page.id}`);
    pageIds.add(page.id);
    if (!page.entry.startsWith(`pages/${page.id}/`) || !files[page.entry]?.length) {
      issues.push(`Missing or invalid page entry: ${page.entry}`);
    }
  }

  // 1. 配置 Schema 存在性
  const hasConfig = Boolean(
    files[configEntry] || manifest.spec.config,
  );

  // 2. 收集技能
  const resolvedSkills = resolveBundleSkills(manifest, files);
  issues.push(...resolvedSkills.issues);
  const skills = resolvedSkills.skills.map(({ name, description }) => ({ name, description }));

  // 3. 收集工具
  const tools: Array<{
    name: string;
    description: string;
    category: string;
    safetyLevel: string;
  }> = [];
  if (manifest.spec.tools) {
    for (const t of manifest.spec.tools) {
      tools.push({
        name: t.name,
        description: t.description ?? "",
        category: t.category ?? "plugin",
        safetyLevel: t.safetyLevel ?? "guarded",
      });
    }
  }

  // 4. 收集页面
  const pages: Array<{
    id: string;
    title: string | Record<string, string>;
    entry: string;
  }> = [];
  if (manifest.spec.pages) {
    for (const p of manifest.spec.pages) {
      pages.push({
        id: p.id,
        title: p.title,
        entry: p.entry,
      });
    }
  }

  // 5. 收集主动智能感知源与规则
  const sensors = manifest.spec.proactive?.sensors ?? [];
  const triggers = (manifest.spec.proactive?.triggers ?? []).map((t) => ({
    ruleId: t.ruleId,
    name: t.name,
    triggerType: t.triggerType,
  }));

  // 6. 权限与数据范围推断（严格对齐 PRD CAP-020）
  const permissions: string[] = [...validation.permissions];
  const dataScope: string[] = [];

  for (const sensor of sensors) {
    permissions.push(`proactive.sensor:${sensor.sourceId}`);
    if (sensor.sourceId === "system.idle_state") {
      dataScope.push("系统键鼠活动与空闲时长监测（仅元数据，不含窗口及击键内容）");
    } else {
      dataScope.push(`感知源数据: ${sensor.sourceId}`);
    }
  }

  for (const page of pages) {
    const pageDecl = manifest.spec.pages?.find((p) => p.id === page.id);
    if (pageDecl?.capabilities) {
      for (const cap of pageDecl.capabilities) {
        permissions.push(`page:${cap}`);
      }
    }
    dataScope.push(`独立沙箱前端扩展页面 (${page.id})`);
  }

  if (manifest.spec.mcpServers?.length) {
    for (const s of manifest.spec.mcpServers) {
      permissions.push(`mcp.server:${s}`);
    }
    dataScope.push("外部 MCP 服务端点连接");
  }

  if (hasConfig) {
    dataScope.push("插件本地配置与 Secret 密钥存取");
  }

  if (skills.length > 0) {
    dataScope.push("大语言模型会话提示词与领域心智扩展");
  }

  if (tools.length > 0) {
    dataScope.push("AI 会话工具调用与本地业务闭环");
  }

  // 7. 查询是否已安装
  for (const skill of skills) {
    if (!isValidSkillName(skill.name)) issues.push(`Invalid skill name: ${skill.name}`);
  }
  let alreadyInstalled = false;
  let installedVersion: string | null = null;
  if (deps?.extensionRepo) {
    try {
      const existing = await deps.extensionRepo.getPlugin(pluginId);
      if (existing) {
        alreadyInstalled = true;
        installedVersion = existing.version;
      }
    } catch {
      // 忽略查询失败
    }
  }

  return {
    id: pluginId,
    displayName: manifest.metadata.displayName,
    publisher: manifest.metadata.publisher,
    version: manifest.metadata.version,
    description: manifest.metadata.description ?? "",
    license: manifest.metadata.license ?? "AGPL-3.0-or-later",
    checksum,
    signature: null,
    permissions,
    dataScope: [...new Set(dataScope)],
    tools,
    skills,
    pages,
    proactive: {
      sensors: sensors.map((s) => ({
        sourceId: s.sourceId,
        description: s.description,
      })),
      triggers,
    },
    hasConfig,
    alreadyInstalled,
    installedVersion,
    isValid: issues.length === 0,
    issues,
  };
}

/**
 * 从分发包安装插件
 */
export async function installPluginFromBundle(
  bytes: Uint8Array,
  options: { overwrite?: boolean; signal?: AbortSignal } = {},
  deps: BundleEngineDeps,
): Promise<PluginModel> {
  const inspection = await inspectPluginBundle(bytes, {
    extensionRepo: deps.extensionRepo,
  }, options.signal);

  if (!inspection.isValid) {
    throw new Error(`Invalid plugin package: ${inspection.issues.join("; ")}`);
  }

  if (inspection.alreadyInstalled && !options.overwrite) {
    throw new PluginAlreadyExistsError(
      `Plugin "${inspection.id}" is already installed (v${inspection.installedVersion}). Use overwrite=true to replace.`,
    );
  }

  // Worker admission, timeout and decoding can fail even after successful inspection.
  // Finish those fallible steps while the existing plugin and its data are intact.
  const files = await unpackPluginBundle(bytes, options.signal);
  const manifestBytes =
    files["plugin.manifest.json"] ?? files["manifest.json"]!;
  const manifest = pluginManifestSchema.parse(
    JSON.parse(strFromU8(manifestBytes)),
  );
  const pluginId = manifest.metadata.id;

  // 1. 组装技能定义
  const resolvedSkills = resolveBundleSkills(manifest, files);
  if (resolvedSkills.issues.length) throw new Error(`Invalid plugin skills: ${resolvedSkills.issues.join("; ")}`);
  const declaredSkills = resolvedSkills.skills;

  // 2. 组装工具定义
  const declaredTools: PluginDeclaredTool[] = [];
  if (manifest.spec.tools) {
    for (const t of manifest.spec.tools) {
      declaredTools.push({
        id: t.id,
        name: t.name,
        description: t.description ?? "",
        category: t.category ?? "plugin",
        safetyLevel: t.safetyLevel,
        requiredPermissions: t.requiredPermissions,
        inputSchema: t.inputSchema,
        priority: t.priority,
      });
    }
  }

  return withSkillMutation(deps.skillsRoot, async () => {
    await deps.service.checkSkillOwnership(pluginId, declaredSkills, false);
    // Recheck after acquiring the lock; another install may have completed during preparation.
    const existing = await deps.extensionRepo.getPlugin(pluginId);
    if (existing && !options.overwrite) throw new PluginAlreadyExistsError(`Plugin "${pluginId}" is already installed.`);
    options.signal?.throwIfAborted();
    const schemaBytes = files[manifest.spec.config?.entry ?? "config.schema.json"];
    const fields = schemaBytes ? parseConfigSchema(JSON.parse(strFromU8(schemaBytes))) : undefined;
    const stored = await deps.configRepo.getConfig({workspaceId: "local", subjectUserId: "local"}, pluginId);
    const previousFields = (existing?.configSchemaJson ?? []) as PluginConfigField[];
    // Type changes require an explicit migration; never silently reinterpret saved values or Secrets.
    const checkTypes = (before: PluginConfigField[], after: PluginConfigField[]) => {
      for (const previous of before) {
        const next = after.find(field => field.key === previous.key);
        if (!next) continue;
        if (next.type !== previous.type) throw new Error(`Plugin configuration migration required: ${previous.key}`);
        if (previous.children && next.children) checkTypes(previous.children, next.children);
        if (previous.items && next.items) checkTypes([previous.items], [next.items]);
      }
    };
    if (fields) checkTypes(previousFields, fields);
    const migration = fields && stored ? diffSchema(fields, stored.valuesJson as Record<string, unknown>) : undefined;
    if (migration && fields) {
      const result = validateValues(fields, migration.defaults);
      if (result.issues.length) throw new Error(`Plugin configuration migration required: ${result.issues.map(issue => issue.key).join(", ")}`);
    }
    const staged = await deps.bundleStore.stageBundle(pluginId, files, bytes, declaredSkills);
    try {
      options.signal?.throwIfAborted();
      const created = await deps.service.activatePreparedBundle({
        plugin: {
          id: pluginId, publisher: manifest.metadata.publisher, version: manifest.metadata.version,
          checksum: `sha256:${inspection.checksum}`, signature: inspection.signature,
          permissions: inspection.permissions, installSource: "package",
          configSchemaJson: fields ?? existing?.configSchemaJson ?? null,
          configSchemaVersion: 1, proactiveSpecJson: manifest.spec.proactive ?? null,
        },
        generation: staged.generation, expectedGeneration: existing?.bundleGeneration ?? null,
        expectedChecksum: existing?.checksum ?? null, expectedConfigRevision: stored?.revision ?? 0, expectedSchema: existing?.configSchemaJson ?? null,
        tools: declaredTools.map(tool => {
          const id = tool.id ?? tool.name;
          return { ...tool, id: id.startsWith(`${pluginId}.`) ? id : `${pluginId}.${id}`,
            description: tool.description ?? "", category: tool.category ?? "plugin", pluginId, builtin: false };
        }),
        skills: declaredSkills.map(skill => ({
          id: skill.name, name: skill.name, description: skill.description,
          source: "plugin", readonly: true, pluginId, contentPath: staged.skillPaths.get(skill.name)!,
        })),
        pages: (manifest.spec.pages ?? []).map(page => ({
          pluginId, pageId: page.id, title: page.title, description: page.description,
          entry: page.entry, capabilities: page.capabilities, checksum: page.checksum,
        })),
        ...(migration && stored ? {config: {
          expectedRevision: stored.revision, values: migration.defaults,
          orphanedValues: { ...(stored.orphanedValuesJson as Record<string, unknown> ?? {}), ...migration.orphaned },
        }} : {}),
      });
      return created;
    } catch (error) {
      await deps.bundleStore.discardGeneration(pluginId, staged.generation).catch(() => undefined);
      throw error;
    }
  });
}

/**
 * 导出插件分发包（.aervox-plugin，标准 ZIP 归档）
 */
export async function exportPluginBundle(
  pluginId: string,
  deps: BundleEngineDeps,
  signal?: AbortSignal,
): Promise<{ filename: string; bytes: Uint8Array; checksum: string }> {
  const plugin = await deps.extensionRepo.getPlugin(pluginId);
  if (plugin?.bundleGeneration) {
    signal?.throwIfAborted();
    const bytes = await deps.bundleStore.readOriginalBundle(pluginId, plugin.bundleGeneration);
    return { filename: `${pluginId}-${plugin.version}.aervox-plugin`, bytes,
      checksum: createHash("sha256").update(bytes).digest("hex") };
  }
  const zipFiles: Record<string, Uint8Array> = {};

  // 优先尝试从出厂源目录拷贝完整静态文件
  const sourceDir = path.join(deps.builtinPluginsSourceRoot, pluginId);
  let hasSourceDir = false;
  try {
    const stat = await fs.stat(sourceDir);
    hasSourceDir = stat.isDirectory();
  } catch {
    hasSourceDir = false;
  }

  if (hasSourceDir) {
    // 递归读取内置源码目录
    async function readDirRecursive(dir: string, base: string) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.join(base, entry.name).replace(/\\/g, "/");
        if (entry.isDirectory()) {
          await readDirRecursive(full, rel);
        } else {
          const data = await fs.readFile(full);
          zipFiles[rel] = new Uint8Array(data);
        }
      }
    }
    await readDirRecursive(sourceDir, "");
  }

  // 若无内置源码目录或动态已安装插件，从仓储和文件系统聚合
  if (!zipFiles["plugin.manifest.json"] && !zipFiles["manifest.json"]) {
    if (!plugin) {
      throw new Error(`Plugin not found: ${pluginId}`);
    }

    // 收集 pages
    const pages = await deps.pageRepo.listPages(pluginId);
    for (const page of pages) {
      const existingBytes = Object.values(zipFiles).reduce((sum, value) => sum + value.byteLength, 0);
      const assets = await deps.bundleStore.exportPageAssets(pluginId, page.pageId, {
        entries: PLUGIN_ARCHIVE_LIMITS.entries - Object.keys(zipFiles).length,
        bytes: PLUGIN_ARCHIVE_LIMITS.expandedBytes - existingBytes,
        entryBytes: PLUGIN_ARCHIVE_LIMITS.entryBytes,
      });
      for (const [name, content] of Object.entries(assets)) zipFiles[`pages/${page.pageId}/${name}`] = content;
    }
    const manifest: PluginManifest = {
      apiVersion: "aervox.dev/v1",
      kind: "PluginManifest",
      metadata: {
        id: plugin.id,
        displayName: plugin.id,
        publisher: plugin.publisher,
        version: plugin.version,
        description: `Exported plugin: ${plugin.id}`,
        license: "AGPL-3.0-or-later",
      },
      spec: {
        pages: pages.map((p) => ({
          id: p.pageId,
          title:
            typeof p.title === "string" ||
            (p.title && typeof p.title === "object")
              ? (p.title as string | Record<string, string>)
              : p.pageId,
          description:
            typeof p.description === "string" ||
            (p.description && typeof p.description === "object")
              ? (p.description as string | Record<string, string>)
              : undefined,
          entry: p.entry,
          capabilities: (p.capabilitiesJson ?? []) as never,
        })),
        proactive: plugin.proactiveSpecJson as never,
      },
    };

    zipFiles["plugin.manifest.json"] = strToU8(
      JSON.stringify(manifest, null, 2),
    );

    // 收集配置 schema
    try {
      const schema = await deps.configService.getConfigSchema(pluginId);
      if (schema && Array.isArray(schema.fields) && schema.fields.length > 0) {
        zipFiles["config.schema.json"] = strToU8(
          JSON.stringify(
            {
              apiVersion: "aervox.dev/v1",
              kind: "PluginConfigSchema",
              schemaVersion: schema.schemaVersion ?? 1,
              fields: schema.fields,
            },
            null,
            2,
          ),
        );
      }
    } catch {
      // 忽略未配置 schema
    }

    // 收集技能
    const pluginSkillDir = path.join(deps.skillsRoot, pluginId);
    try {
      const skillEntries = await fs.readdir(pluginSkillDir, {
        withFileTypes: true,
      });
      for (const sEntry of skillEntries) {
        if (sEntry.isDirectory()) {
          const skillFile = path.join(pluginSkillDir, sEntry.name, "SKILL.md");
          try {
            const data = await fs.readFile(skillFile);
            zipFiles[`skills/${sEntry.name}/SKILL.md`] = new Uint8Array(data);
          } catch {
            // 忽略未找到
          }
        }
      }
    } catch {
      // 忽略未找到技能目录
    }
  }

  const version = plugin?.version ?? "1.0.0";
  const bytes = await executeArchive<Uint8Array>({ kind: "pack", input: zipFiles, limits: PLUGIN_ARCHIVE_LIMITS, isSafePath: isSafeZipEntryPath, signal });
  const checksum = createHash("sha256").update(bytes).digest("hex");
  const filename = `${pluginId}-${version}.aervox-plugin`;

  return { filename, bytes, checksum };
}

/**
 * 获取官方与出厂插件集市条目
 */
export async function listMarketPlugins(
  deps: Pick<BundleEngineDeps, "extensionRepo" | "builtinPluginsSourceRoot">,
): Promise<PluginMarketItem[]> {
  const items: PluginMarketItem[] = [];
  const installedPlugins = await deps.extensionRepo.listPlugins();
  const installedMap = new Map<string, PluginModel>();
  for (const p of installedPlugins) {
    installedMap.set(p.id, p);
  }

  try {
    const entries = await fs.readdir(deps.builtinPluginsSourceRoot, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pluginDir = path.join(deps.builtinPluginsSourceRoot, entry.name);
      const manifestPath = path.join(pluginDir, "plugin.manifest.json");
      const schemaPath = path.join(pluginDir, "config.schema.json");

      let manifestRaw: string;
      try {
        manifestRaw = await fs.readFile(manifestPath, "utf8");
      } catch {
        continue;
      }

      const parsed = pluginManifestSchema.safeParse(JSON.parse(manifestRaw));
      if (!parsed.success) continue;

      const manifest = parsed.data;
      const pluginId = manifest.metadata.id;
      const installed = installedMap.get(pluginId);

      let hasConfig = false;
      try {
        await fs.access(schemaPath);
        hasConfig = true;
      } catch {
        hasConfig = false;
      }

      let skillsCount = 0;
      try {
        await fs.access(path.join(pluginDir, "SKILL.md"));
        skillsCount = 1;
      } catch {
        skillsCount = manifest.spec.skills?.length ?? 0;
      }

      const sensorsCount = manifest.spec.proactive?.sensors?.length ?? 0;
      const triggersCount = manifest.spec.proactive?.triggers?.length ?? 0;
      const toolsCount = manifest.spec.tools?.length ?? 0;
      const pagesCount = manifest.spec.pages?.length ?? 0;

      items.push({
        id: pluginId,
        displayName: manifest.metadata.displayName,
        publisher: manifest.metadata.publisher,
        version: manifest.metadata.version,
        description: manifest.metadata.description ?? "",
        license: manifest.metadata.license ?? "AGPL-3.0-or-later",
        source: "builtin",
        installed: Boolean(installed),
        installedVersion: installed?.version ?? null,
        hasUpdate: Boolean(installed && installed.version !== manifest.metadata.version),
        capabilities: {
          hasConfig,
          sensorsCount,
          triggersCount,
          toolsCount,
          skillsCount,
          pagesCount,
        },
      });
    }
  } catch {
    // 静默降级
  }

  return items;
}

/**
 * 出厂源打包允许清单（fail-closed）。
 *
 * 与 `scripts/export-plugins.mjs` 的 `DIST_FILENAMES` / `DIST_DIR_PREFIXES` 必须一致，
 * 由 `apps/api/test/plugin-bundle-allowlist.test.ts` 机器断言（防止两份清单漂移）。
 *
 * 背景：出厂源目录同时承载实现源码、测试与依赖链接，早期实现的目录递归打包会把
 * `node_modules`（其下为指向工作区包的符号链接）、`src/` 与构建产物一并压入安装包，
 * 既膨胀校验和载体又触发 EISDIR。此处只收声明与资源。
 */
export const PLUGIN_BUNDLE_FILENAMES: readonly string[] = [
  "plugin.manifest.json",
  "manifest.json",
  "config.schema.json",
  "SKILL.md",
  "skill.md",
];

export const PLUGIN_BUNDLE_DIR_PREFIXES: readonly string[] = ["skills/", "pages/"];

/** 仅本地开发用的载体：明确排除，且不视为契约缺陷 */
export const PLUGIN_BUNDLE_LOCAL_FILENAMES: readonly string[] = [
  "package.json",
  "tsconfig.json",
  "tsconfig.ui.json",
  "vitest.config.ts",
  "vitest.config.js",
  "pnpm-lock.yaml",
  "README.md",
  ".gitignore",
  ".DS_Store",
];

export const PLUGIN_BUNDLE_LOCAL_DIR_PREFIXES: readonly string[] = [
  "src/",
  "dist/",
  "node_modules/",
  "test/",
  "tests/",
  "__tests__/",
  ".turbo/",
];

/** 判断出厂源目录内的相对路径在分发包中的角色：dist | local | unknown（与导出脚本同构） */
export function classifyPluginBundleEntry(rel: string, isDirectory = false): "dist" | "local" | "unknown" {
  const asDir = isDirectory ? `${rel}/` : rel;
  if (!isDirectory && PLUGIN_BUNDLE_FILENAMES.includes(rel)) return "dist";
  if (PLUGIN_BUNDLE_DIR_PREFIXES.some((prefix) => asDir.startsWith(prefix))) return "dist";
  if (PLUGIN_BUNDLE_LOCAL_FILENAMES.includes(rel)) return "local";
  if (PLUGIN_BUNDLE_LOCAL_DIR_PREFIXES.some((prefix) => asDir.startsWith(prefix))) return "local";
  return "unknown";
}

/** 收集出厂源目录中属于分发包的文件（键为包内相对路径） */
export async function collectMarketBundleFiles(
  pluginDir: string,
): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = {};

  const readAllowedRecursive = async (dir: string, base: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = path.join(dir, entry.name);
      const rel = `${base}${entry.name}`;
      const role = classifyPluginBundleEntry(rel, entry.isDirectory());
      if (role === "local") continue;
      // 未知角色属于**契约缺陷**（既可能是漏发资源，也可能是泄露实现），fail-closed 拒绝而非静默跳过
      if (role === "unknown") {
        throw new Error(
          `出厂源目录存在未登记角色的条目：${rel}。请在允许清单中显式归类后再打包（fail-closed）。`,
        );
      }
      if (entry.isDirectory()) {
        await readAllowedRecursive(full, `${rel}/`);
        continue;
      }
      const data = await fs.readFile(full);
      files[rel] = new Uint8Array(data);
    }
  };

  await readAllowedRecursive(pluginDir, "");
  return files;
}

/**
 * 从出厂源一键安装插件
 */
export async function installFromMarket(
  pluginId: string,
  deps: BundleEngineDeps,
  signal?: AbortSignal,
): Promise<PluginModel> {
  const pluginDir = path.join(deps.builtinPluginsSourceRoot, pluginId);
  const manifestPath = path.join(pluginDir, "plugin.manifest.json");

  try {
    await fs.access(manifestPath);
  } catch {
    throw new Error(`Market plugin "${pluginId}" not found in source registry.`);
  }

  const zipFiles = await collectMarketBundleFiles(pluginDir);
  const bytes = await executeArchive<Uint8Array>({ kind: "pack", input: zipFiles, limits: PLUGIN_ARCHIVE_LIMITS, isSafePath: isSafeZipEntryPath, signal });
  return installPluginFromBundle(bytes, { overwrite: true, signal }, deps);
}
