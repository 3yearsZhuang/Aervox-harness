/** Self-contained codec serialized into the archive worker; no application imports. */
export function boundedUnpack(
  bytes: Uint8Array,
  limits: { expandedBytes: number; entryBytes: number; entries: number },
  normalize: (name: string) => string | null,
  codec: Pick<typeof import("node:zlib"), "inflateRawSync" | "crc32">,
): Record<string, Uint8Array> {
  const buffer = Buffer.from(bytes);
  const invalid = () => new Error("Invalid zip archive");
  const range = (offset: number, length: number) => {
    if (offset < 0 || length < 0 || offset + length > buffer.length) throw invalid();
  };
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50 && i + 22 + buffer.readUInt16LE(i + 20) === buffer.length) { eocd = i; break; }
  }
  if (eocd < 0) throw invalid();
  const count = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (count === 65535 || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("Unsupported zip: zip64");
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6) || buffer.readUInt16LE(eocd + 8) !== count) throw invalid();
  if (cdOffset + cdSize !== eocd) throw invalid();
  if (count > limits.entries) throw new Error("Archive exceeds entry limit");
  let cursor = cdOffset;
  let expanded = 0;
  const names = new Set<string>();
  const entries: Array<{ name: string | null; size: number; compressed: number; start: number; method: number; crc: number }> = [];
  for (let i = 0; i < count; i++) {
    range(cursor, 46);
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const size = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const local = buffer.readUInt32LE(cursor + 42);
    if ([compressed, size, local].includes(0xffffffff)) throw new Error("Unsupported zip: zip64");
    if ((flags & 1) || ![0, 8].includes(method) || buffer.readUInt16LE(cursor + 34)) throw new Error("Unsupported zip encoding");
    if (nameLength > 1024) throw new Error("Archive entry name exceeds limit");
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocd) throw invalid();
    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    const name = normalize(rawName);
    if (name !== null) {
      // Collision checks must also protect case-insensitive macOS/Windows filesystems.
      const key = name.replace(/\/$/, "").toLowerCase();
      if (names.has(key)) throw new Error("Duplicate archive entry: " + name);
      names.add(key);
    }
    expanded += Math.max(size, compressed);
    if (size > limits.entryBytes || compressed > limits.entryBytes || expanded > limits.expandedBytes) throw new Error("Archive exceeds expansion limits");
    range(local, 30);
    if (buffer.readUInt32LE(local) !== 0x04034b50 || buffer.readUInt16LE(local + 8) !== method || buffer.readUInt16LE(local + 6) !== flags) throw invalid();
    const localNameLength = buffer.readUInt16LE(local + 26);
    const start = local + 30 + localNameLength + buffer.readUInt16LE(local + 28);
    if (start + compressed > cdOffset) throw invalid();
    if (buffer.subarray(local + 30, local + 30 + localNameLength).toString("utf8") !== rawName) throw invalid();
    entries.push({ name, size, compressed, start, method, crc });
    cursor = next;
  }
  if (cursor !== eocd) throw invalid();
  // A file cannot also be an ancestor directory, regardless of archive entry order.
  // Check normalized paths before inflating or allowing a caller to replace files.
  const fileNames = new Set(entries.flatMap(entry => entry.name !== null && !entry.name.endsWith("/") ? [entry.name.toLowerCase()] : []));
  for (const { name } of entries) {
    if (name === null) continue;
    let parent = name.replace(/\/$/, "").toLowerCase();
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      if (fileNames.has(parent)) throw invalid();
    }
  }
  const result: Record<string, Uint8Array> = Object.create(null);
  for (const entry of entries) {
    if (entry.name === null) continue;
    const compressed = buffer.subarray(entry.start, entry.start + entry.compressed);
    // Cap actual output independently of advertised sizes, including forged small headers.
    let data: Uint8Array;
    try {
      data = entry.method === 0 ? compressed : codec.inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.size) });
    } catch (error: unknown) {
      // Malformed or over-expanding DEFLATE is input failure; worker infrastructure errors still propagate.
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "Z_DATA_ERROR" || code === "Z_BUF_ERROR" || code === "ERR_BUFFER_TOO_LARGE") throw invalid();
      throw error;
    }
    if (data.byteLength !== entry.size || codec.crc32(data) !== entry.crc) throw new Error("Invalid zip: size or checksum mismatch");
    result[entry.name] = data;
  }
  return result;
}
