/**
 * Aervox｜思隅 @aervox/api — 最小 ZIP 解包工具（CAP-020 Skill 安装用）
 *
 * 依据 central directory 解析 ZIP（尺寸以中央目录为准，兼容 data descriptor），
 * 支持 STORE（0）与 DEFLATE（8，zlib.inflateRaw）。不引入第三方依赖，
 * 覆盖面足够常见 SKILL.md 压缩包；zip64（0xFFFFFFFF 尺寸）显式拒绝。
 *
 * 安全校验（对齐 reference/AstrBot skill_manager.py install_skill_from_zip）：
 * - 条目路径先规范化（反斜杠统一为 /、去除 ./ 段与空段）再校验，
 *   兼容 Windows 工具与 `zip -r x.zip .` 打包的 ./ 前缀条目；
 * - 拒绝绝对路径、路径穿越（..）、__MACOSX 条目；
 * - 由调用方按 SKILL.md 存在性与目录名规范二次过滤。
 */
import zlib from "node:zlib";

const EOCD_SIG = 0x06054b50;
const CD_ENTRY_SIG = 0x02014b50;
const LOCAL_HEADER_SIG = 0x04034b50;
const ZIP64_MARKER = 0xffffffff;
const MAX_ENTRY_NAME_LEN = 1024;

export interface ZipEntry {
  /** 标准化路径（/ 分隔） */
  name: string;
  /** 是否为目录条目（名字以 / 结尾） */
  isDirectory: boolean;
  data: Buffer;
}

/** 校验并读取 EOCD（从文件尾部 64KB 内扫描） */
function findEocd(buffer: Buffer): { offset: number; count: number; cdOffset: number } {
  if (buffer.length < 22) throw new Error("Invalid zip: too short");
  const start = Math.max(0, buffer.length - (65557 + 22));
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      const count = buffer.readUInt16LE(i + 10);
      const cdOffset = buffer.readUInt32LE(i + 16);
      return { offset: i, count, cdOffset };
    }
  }
  throw new Error("Invalid zip: end of central directory not found");
}

function readAscii(buffer: Buffer, offset: number, length: number): string {
  return buffer.subarray(offset, offset + length).toString("utf8");
}

/** 条目路径规范化：反斜杠统一为 /，去除 ./ 段与空段（兼容 Windows 压缩包与 `zip -r x.zip .` 打包） */
function normalizeEntryPath(name: string): string {
  const parts: string[] = [];
  for (const part of name.replace(/\\/g, "/").split("/")) {
    if (part === "" || part === ".") continue;
    parts.push(part);
  }
  return parts.join("/");
}

function isPathSafe(name: string): boolean {
  if (!name) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  // 规范化后绝对路径段已被消除，仅剩 .. 段需要拒绝（反斜杠穿越也因此被覆盖）
  if (name.split("/").some((p) => p === "..")) return false;
  return true;
}

function isIgnoredEntry(name: string): boolean {
  return name.split("/")[0] === "__MACOSX";
}

/** 解包 ZIP 为条目列表（保留目录条目，供调用方判断结构） */
export function unzip(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== LOCAL_HEADER_SIG) {
    throw new Error("Invalid zip: not a zip archive");
  }

  const { count, cdOffset } = findEocd(buffer);
  const entries: ZipEntry[] = [];
  let cursor = cdOffset;

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== CD_ENTRY_SIG) {
      throw new Error("Invalid zip: central directory corrupted");
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const uncompSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);

    if (nameLen > MAX_ENTRY_NAME_LEN) {
      throw new Error("Invalid zip: entry name too long");
    }
    if (compSize === ZIP64_MARKER || uncompSize === ZIP64_MARKER) {
      throw new Error("Unsupported zip: zip64 entries not supported");
    }

    const rawName = readAscii(buffer, cursor + 46, nameLen);
    cursor += 46 + nameLen + extraLen + commentLen;

    // 目录条目：原始名以 / 或 \ 结尾（规范化会去掉尾段，需先判定）
    const isDirectory = rawName.endsWith("/") || rawName.endsWith("\\");

    // 安全：先规范化（./ 段、空段、反斜杠），全部段被消除的条目（如根 "./"）直接跳过；
    // 再拒绝 __MACOSX 与残余穿越/盘符路径
    const name = normalizeEntryPath(rawName);
    if (!name) continue;
    if (isIgnoredEntry(name)) continue;
    if (!isPathSafe(name)) {
      throw new Error(`Invalid zip: unsafe entry path "${rawName}"`);
    }

    if (isDirectory) {
      entries.push({ name, isDirectory: true, data: Buffer.alloc(0) });
      continue;
    }

    // 依据 local header 定位压缩数据起点（local header 固定 30 字节 + 本地名字/扩展长度）
    if (buffer.readUInt32LE(localOffset) !== LOCAL_HEADER_SIG) {
      throw new Error("Invalid zip: local header corrupted");
    }
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buffer.subarray(dataStart, dataStart + compSize);

    let data: Buffer;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`Unsupported zip: compression method ${method}`);
    }
    if (data.length !== uncompSize) {
      throw new Error("Invalid zip: size mismatch after decompression");
    }
    entries.push({ name, isDirectory: false, data });
  }

  return entries;
}
