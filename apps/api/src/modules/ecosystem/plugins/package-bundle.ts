/**
 * Aervox｜思隅 @aervox/api — 插件打包、分发包预检与集市引擎（CAP-020）
 *
 * 职责：
 * 1. 内存安全解包与安全校验（防目录穿越、超限文件、非法路径）；
 * 2. 安装前预检（inspectPluginBundle）：严格对齐 PRD CAP-020 验收门禁，
 *    提供发布者、版本、SHA-256、所需权限、数据范围与能力明细；
 * 3. 分发包原子安装（installPluginFromBundle）：从 .aervox-plugin / zip
 *    解包并完整同步插件、工具、技能、配置 Schema、Page 资源与主动规则；
 * 4. 插件打包导出（exportPluginBundle）：生成标准的 .aervox-plugin 单文件分发包；
 * 5. 官方与出厂插件集市（listMarketPlugins / installFromMarket）。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  pluginManifestSchema,
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
import { parseFrontmatter, isValidSkillName } from "../skills/skill-manager.js";
import type { PluginBundleStore } from "./bundle-store.js";
import type { PluginConfigService } from "./config-service.js";
import type { PluginService } from "./service.js";

/** 单条目路径安全校验（拒绝绝对路径、.. 段、反斜杠穿越、超限路径） */
export function isSafeZipEntryPath(name: string): boolean {
  if (!name || name.length > 512) return false;
  const normalized = name.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return false;
  const parts = normalized.split("/");
  if (parts.some((p) => p === ".." || p === ".")) return false;
  return true;
}

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

/**
 * 预检插件分发包（内存解包与静态结构分析，零副作用）
 */
export async function inspectPluginBundle(
  bytes: Uint8Array,
  deps?: { extensionRepo?: SqliteExtensionRepository },
): Promise<PluginPackageInspection> {
  const checksum = createHash("sha256").update(bytes).digest("hex");

  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch (e) {
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

  // 1. 配置 Schema 存在性
  const hasConfig = Boolean(
    files["config.schema.json"] || manifest.spec.config,
  );

  // 2. 收集技能
  const skills: Array<{ name: string; description: string }> = [];
  if (manifest.spec.skills) {
    for (const s of manifest.spec.skills) {
      skills.push({
        name: s.name,
        description: s.description ?? "",
      });
    }
  }

  const rootSkillBytes = files["SKILL.md"] ?? files["skill.md"];
  if (rootSkillBytes && !skills.some((s) => s.name === pluginId)) {
    const text = strFromU8(rootSkillBytes);
    const fm = parseFrontmatter(text);
    skills.push({
      name: fm.name || pluginId,
      description: fm.description || manifest.metadata.description || "",
    });
  }

  for (const [entryName, content] of Object.entries(files)) {
    if (entryName.startsWith("skills/") && (entryName.endsWith("/SKILL.md") || entryName.endsWith("/skill.md"))) {
      const parts = entryName.split("/");
      if (parts.length >= 3 && parts[1]) {
        const skillName = parts[1];
        if (!skills.some((s) => s.name === skillName)) {
          const fm = parseFrontmatter(strFromU8(content));
          skills.push({
            name: skillName,
            description: fm.description || "",
          });
        }
      }
    }
  }

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
  const permissions: string[] = [];
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
    isValid: true,
    issues: [],
  };
}

/**
 * 从分发包安装插件
 */
export async function installPluginFromBundle(
  bytes: Uint8Array,
  options: { overwrite?: boolean } = {},
  deps: BundleEngineDeps,
): Promise<PluginModel> {
  const inspection = await inspectPluginBundle(bytes, {
    extensionRepo: deps.extensionRepo,
  });

  if (!inspection.isValid) {
    throw new Error(`Invalid plugin package: ${inspection.issues.join("; ")}`);
  }

  if (inspection.alreadyInstalled && !options.overwrite) {
    throw new PluginAlreadyExistsError(
      `Plugin "${inspection.id}" is already installed (v${inspection.installedVersion}). Use overwrite=true to replace.`,
    );
  }

  // 覆盖安装时先卸载既有插件及能力
  if (inspection.alreadyInstalled && options.overwrite) {
    await deps.service.uninstallPlugin(inspection.id);
  }

  const files = unzipSync(bytes);
  const manifestBytes =
    files["plugin.manifest.json"] ?? files["manifest.json"]!;
  const manifest = pluginManifestSchema.parse(
    JSON.parse(strFromU8(manifestBytes)),
  );
  const pluginId = manifest.metadata.id;

  // 1. 组装技能定义
  const declaredSkills: PluginDeclaredSkill[] = [];
  if (manifest.spec.skills) {
    for (const s of manifest.spec.skills) {
      declaredSkills.push({
        name: s.name,
        description: s.description,
        content: s.content ?? "",
      });
    }
  }

  const rootSkillBytes = files["SKILL.md"] ?? files["skill.md"];
  if (rootSkillBytes && !declaredSkills.some((s) => s.name === pluginId)) {
    const content = strFromU8(rootSkillBytes);
    declaredSkills.push({
      name: pluginId,
      description: manifest.metadata.description,
      content,
    });
  }

  for (const [entryName, contentBytes] of Object.entries(files)) {
    if (entryName.startsWith("skills/") && (entryName.endsWith("/SKILL.md") || entryName.endsWith("/skill.md"))) {
      const parts = entryName.split("/");
      if (parts.length >= 3 && parts[1]) {
        const skillName = parts[1];
        if (!declaredSkills.some((s) => s.name === skillName)) {
          declaredSkills.push({
            name: skillName,
            content: strFromU8(contentBytes),
          });
        }
      }
    }
  }

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

  // 3. 安装插件主记录、工具、技能与主动规则
  const created = await deps.service.installPlugin({
    id: pluginId,
    publisher: manifest.metadata.publisher,
    version: manifest.metadata.version,
    checksum: `sha256:${inspection.checksum}`,
    signature: inspection.signature,
    permissions: inspection.permissions,
    installSource: "package",
    tools: declaredTools,
    skills: declaredSkills,
    proactiveSpec: manifest.spec.proactive,
  });

  // 4. 注册并持久化配置 Schema（若存在）
  const schemaBytes = files["config.schema.json"];
  if (schemaBytes) {
    try {
      const schemaJson = JSON.parse(strFromU8(schemaBytes));
      await deps.configService.registerConfigSchema(pluginId, schemaJson);
    } catch (e) {
      console.warn(`[plugins] failed to register config schema for ${pluginId}`, e);
    }
  }

  // 5. 解包注册 Page 及其静态资源
  if (manifest.spec.pages && manifest.spec.pages.length > 0) {
    for (const page of manifest.spec.pages) {
      try {
        await deps.configService.registerPage(pluginId, page);
      } catch (e) {
        console.warn(`[plugins] failed to register page ${page.id} for ${pluginId}`, e);
      }

      // 提取 pages/<pageId>/ 下的所有静态资产并写入 BundleStore
      const prefix = `pages/${page.id}/`;
      for (const [filePath, fileData] of Object.entries(files)) {
        if (filePath.startsWith(prefix) && !filePath.endsWith("/")) {
          const relInside = filePath.slice(prefix.length);
          try {
            await deps.bundleStore.writeAsset(
              pluginId,
              page.id,
              relInside,
              Buffer.from(fileData),
            );
          } catch (e) {
            console.warn(`[plugins] failed to write asset ${filePath}`, e);
          }
        }
      }
    }
  }

  return created;
}

/**
 * 导出插件分发包（.aervox-plugin，标准 ZIP 归档）
 */
export async function exportPluginBundle(
  pluginId: string,
  deps: BundleEngineDeps,
): Promise<{ filename: string; bytes: Uint8Array; checksum: string }> {
  const plugin = await deps.extensionRepo.getPlugin(pluginId);
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
  const bytes = zipSync(zipFiles, { level: 6 });
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
 * 从出厂源一键安装插件
 */
export async function installFromMarket(
  pluginId: string,
  deps: BundleEngineDeps,
): Promise<PluginModel> {
  const pluginDir = path.join(deps.builtinPluginsSourceRoot, pluginId);
  const manifestPath = path.join(pluginDir, "plugin.manifest.json");

  try {
    await fs.access(manifestPath);
  } catch {
    throw new Error(`Market plugin "${pluginId}" not found in source registry.`);
  }

  const zipFiles: Record<string, Uint8Array> = {};
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
  await readDirRecursive(pluginDir, "");

  const bytes = zipSync(zipFiles, { level: 6 });
  return installPluginFromBundle(bytes, { overwrite: true }, deps);
}
