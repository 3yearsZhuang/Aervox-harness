/**
 * Aervox｜思隅 @aervox/api — 最小 ZIP 解包工具（CAP-020 Skill 安装用）
 *
 * 依据 central directory 解析 ZIP（尺寸以中央目录为准，兼容 data descriptor），
 * 支持 STORE（0）与 DEFLATE（8，zlib.inflateRaw）。不引入第三方依赖，
 * 覆盖面足够常见 SKILL.md 压缩包；zip64（0xFFFFFFFF 尺寸）显式拒绝。
 *
 * 安全校验（对齐 reference/AstrBot skill_manager.py install_skill_from_zip）：
 * - 拒绝绝对路径、路径穿越（..）、__MACOSX 条目、非法字符；
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

function isPathSafe(name: string): boolean {
  if (!name) return false;
  if (name.startsWith("/")) return false;
  if (/^[A-Za-z]:/.test(name)) return false;
  const parts = name.split("/");
  if (parts.some((p) => p === ".." || p === "." || p === "")) return false;
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

    const name = readAscii(buffer, cursor + 46, nameLen);
    cursor += 46 + nameLen + extraLen + commentLen;

    // 安全：拒绝绝对路径 / 穿越；忽略 __MACOSX
    if (isIgnoredEntry(name)) continue;
    if (!isPathSafe(name)) {
      throw new Error(`Invalid zip: unsafe entry path "${name}"`);
    }

    const isDirectory = name.endsWith("/");
    if (isDirectory) {
      entries.push({ name: name.slice(0, -1), isDirectory: true, data: Buffer.alloc(0) });
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
