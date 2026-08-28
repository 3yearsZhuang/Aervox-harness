/**
 * Aervox｜思隅 @aervox/api — Skill 管理服务（CAP-020）
 *
 * 规则依据：reference/AstrBot astrbot/core/skills/skill_manager.py（SkillInfo、zip 安装、
 * frontmatter 描述、渐进式披露）。注册表（skill_registrations）为真源，内容本体
 * 落盘 <skillsRoot>/<name>/（SKILL.md + scripts/ + assets/）。
 *
 * 安全约束（对齐 AstrBot）：
 * - zip 安装经 unzip() 安全校验（路径穿越/绝对路径/__MACOSX/zip64 拒绝）；
 * - 技能目录名必须匹配 ^[\w.-]+$（Anthropic Skills 命名规范）；
 * - readonly（插件内置）技能拒绝删除，仅可启停。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SqliteSkillRegistryRepository, SkillRegistrationModel } from "@aervox/database";
import { buildSkillsPrompt } from "@aervox/agent-loop";
import { unzip } from "./zip.js";

/** 技能目录名合法字符集（Anthropic Skills 规范） */
const SKILL_NAME_RE = /^[\w.-]+$/;
/** 仓库根（apps/api/src/modules/skills 向上 4 级；dist 布局同深） */
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const DEFAULT_SKILLS_ROOT = path.join(repoRoot, "data", "skills");

export interface SkillInstallOptions {
  /** 单技能 zip（根含 SKILL.md）时的目标名；缺省报错 */
  name?: string;
  /** 已存在同名技能时是否覆盖（缺省 false，冲突即报错） */
  overwrite?: boolean;
}

export interface SkillContent {
  name: string;
  description: string;
  /** SKILL.md 全文 */
  content: string;
}

function normalizeSkillName(name: string): string {
  return name.trim().replace(/\s+/g, "_");
}

function isValidSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}
export { isValidSkillName };

/** 解析 SKILL.md YAML frontmatter 的 name/description（扁平 key: value，避免引入 YAML 依赖） */
export function parseFrontmatter(text: string): { name?: string; description: string } {
  if (!text.startsWith("---")) return { description: "" };
  const lines = text.split(/\r?\n/);
  if ((lines[0] ?? "").trim() !== "---") return { description: "" };

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? "").trim() === "---") {
      end = i;
      break;
    }
  }
  if (end < 0) return { description: "" };

  const result: { name?: string; description: string } = { description: "" };
  for (const line of lines.slice(1, end)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    if (key !== "name" && key !== "description") continue;
    const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "").trim();
    if (!value) continue;
    if (key === "name") result.name = value;
    else result.description = value;
  }
  return result;
}

export class SkillManager {
  constructor(
    private readonly registry: SqliteSkillRegistryRepository,
    readonly skillsRoot: string = DEFAULT_SKILLS_ROOT,
  ) {}

  /** 安装 zip（可含一个或多个技能目录；根含 SKILL.md 为单技能形态，需显式 name） */
  async installFromZip(zipData: Buffer, opts: SkillInstallOptions = {}): Promise<SkillRegistrationModel[]> {
    const entries = unzip(zipData);
    const files = entries.filter((e) => !e.isDirectory);
    if (files.length === 0) throw new Error("Zip archive is empty.");

    const hasRootSkillMd = files.some((f) => f.name === "SKILL.md" || f.name === "skill.md");
    const topDirs = [...new Set(files.map((f) => f.name.split("/")[0]))];

    const installed: SkillRegistrationModel[] = [];

    if (hasRootSkillMd) {
      // 单技能：根含 SKILL.md（文件路径即相对路径）
      const name = normalizeSkillName(opts.name ?? "");
      if (!isValidSkillName(name)) {
        throw new Error("Invalid skill name: name is required for a single-skill zip and must match [\\w.-]+");
      }
      installed.push(await this.installSkillFolder(name, files, opts.overwrite ?? false, false));
      return installed;
    }

    // 多技能：按顶层目录逐个安装（缺 SKILL.md 的目录跳过）
    for (const rawTopDir of topDirs) {
      const topDir = rawTopDir ?? "";
      const dirName = normalizeSkillName(topDir);
      if (!isValidSkillName(dirName)) continue;
      const subFiles = files.filter((f) => f.name.startsWith(`${topDir}/`));
      const hasSkillMd = subFiles.some((f) => f.name === `${topDir}/SKILL.md` || f.name === `${topDir}/skill.md`);
      if (!hasSkillMd) continue;
      installed.push(await this.installSkillFolder(dirName, subFiles, opts.overwrite ?? false, true));
    }

    if (installed.length === 0) {
      throw new Error("No valid SKILL.md found in the zip archive.");
    }
    return installed;
  }

  private async installSkillFolder(
    name: string,
    files: Array<{ name: string; data: Buffer }>,
    overwrite: boolean,
    stripFirstSegment: boolean,
  ): Promise<SkillRegistrationModel> {
    await fs.mkdir(this.skillsRoot, { recursive: true });
    const destDir = path.join(this.skillsRoot, name);
    const exists = await fs
      .access(destDir)
      .then(() => true)
      .catch(() => false);

    if (exists) {
      if (!overwrite) {
        throw new FileExistsError(`Skill ${name} already exists.`);
      }
      await fs.rm(destDir, { recursive: true, force: true });
    }
    await fs.mkdir(destDir, { recursive: true });

    // 逐个落盘，保留相对路径（unzip 已保证无穿越/绝对路径；SKILL.md 一并写入后统一归一化）
    for (const file of files) {
      const rel = stripFirstSegment ? file.name.split("/").slice(1).join("/") : file.name;
      if (!rel) continue;
      const destFile = path.join(destDir, rel);
      await fs.mkdir(path.dirname(destFile), { recursive: true });
      await fs.writeFile(destFile, file.data);
    }

    // SKILL.md 归一化（legacy skill.md → SKILL.md）
    const skillMd = path.join(destDir, "SKILL.md");
    const legacyMd = path.join(destDir, "skill.md");
    const hasCanonical = await fs
      .access(skillMd)
      .then(() => true)
      .catch(() => false);
    if (!hasCanonical) {
      const hasLegacy = await fs
        .access(legacyMd)
        .then(() => true)
        .catch(() => false);
      if (hasLegacy) await fs.rename(legacyMd, skillMd);
    }
    const content = await fs.readFile(skillMd, "utf8");
    const frontmatter = parseFrontmatter(content);
    const checksum = createHash("sha256").update(content).digest("hex");

    return this.registry.registerSkill({
      id: name,
      name,
      description: frontmatter.description || `Skill: ${name}`,
      source: "local",
      active: true,
      checksum,
      contentPath: skillMd,
    });
  }

  listSkills(activeOnly = false): Promise<SkillRegistrationModel[]> {
    return this.registry.listSkills(activeOnly);
  }

  getSkill(name: string): Promise<SkillRegistrationModel | null> {
    return this.registry.getSkill(name);
  }

  /** 读取技能 SKILL.md 全文（渐进式披露：模型决定使用后再读取） */
  async readSkillMarkdown(name: string): Promise<SkillContent | null> {
    const skill = await this.registry.getSkill(name);
    if (!skill) return null;
    const contentPath = skill.contentPath ?? path.join(this.skillsRoot, name, "SKILL.md");
    const content = await fs.readFile(contentPath, "utf8");
    return { name: skill.name, description: skill.description, content };
  }

  setActive(name: string, active: boolean): Promise<SkillRegistrationModel | null> {
   return this.registry.setActive(name, active);
 }

 /** 删除技能：readonly 拒绝；清理文件系统 + 注销注册表 */
 async deleteSkill(name: string): Promise<boolean> {
   const skill = await this.registry.getSkill(name);
   if (!skill) return false;
   if (skill.readonly === 1) return false;
   const dir = path.join(this.skillsRoot, name);
   await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
   return this.registry.unregisterSkill(name);
 }

  /** 读取技能文件夹内所有文件（供 Persona Bundle 导出与打包） */
  async readSkillFolderFiles(name: string): Promise<Array<{ relativePath: string; data: Buffer }> | null> {
    const skill = await this.registry.getSkill(name);
    if (!skill) return null;
    const dir = path.join(this.skillsRoot, name);
    try {
      const entries = await fs.readdir(dir, { recursive: true, withFileTypes: true });
      const files: Array<{ relativePath: string; data: Buffer }> = [];
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const parent = (entry as { parentPath?: string }).parentPath ?? dir;
        const fullPath = path.join(parent, entry.name);
        const relativePath = path.relative(dir, fullPath).replaceAll("\\", "/");
        const data = await fs.readFile(fullPath);
        files.push({ relativePath, data });
      }
      return files;
    } catch {
      return null;
    }
  }

 /** 构建渐进式披露提示词段（仅 active 技能） */
  async buildPrompt(allowedSkillNames?: readonly string[]): Promise<string> {
   const skills = await this.registry.exportSkills();
    const allowedSet = allowedSkillNames ? new Set(allowedSkillNames) : null;
    const filtered = allowedSet ? skills.filter((s) => allowedSet.has(s.name)) : skills;
    return buildSkillsPrompt(filtered.map((s) => ({ name: s.name, description: s.description })));
 }
}

/** 技能已存在冲突错误（路由层映射 409） */
export class FileExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileExistsError";
  }
}
