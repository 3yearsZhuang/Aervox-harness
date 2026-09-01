import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const svgPath = join(__dirname, "../../../packages/ui/src/assets/brand/aervox-app-icon.svg");
const buildDir = join(__dirname, "../build");

const sizes = [16, 32, 48, 64, 128, 256];

async function main() {
  mkdirSync(buildDir, { recursive: true });
  const svgBuffer = readFileSync(svgPath);

  const pngBuffers = [];
  for (const size of sizes) {
    const png = await sharp(svgBuffer, { density: 384 })
      .resize(size, size)
      .png()
      .toBuffer();
    pngBuffers.push({ size, png });
  }

  // Save 256x256 PNG for dev mode
  const bigPng = pngBuffers[pngBuffers.length - 1].png;
  writeFileSync(join(buildDir, "icon.png"), bigPng);

  // Build ICO file
  const ico = buildIco(pngBuffers);
  writeFileSync(join(buildDir, "icon.ico"), ico);

  // 打包源图：macOS icns 需 ≥512 源（electron-builder 由 1024 PNG 自动转 icns），
  // 高密度渲染后缩到目标尺寸，避免上采样模糊；Linux 取 512。
  for (const [name, size] of [["icon-512.png", 512], ["icon-1024.png", 1024]]) {
    const png = await sharp(svgBuffer, { density: 2400 })
      .resize(size, size)
      .png()
      .toBuffer();
    writeFileSync(join(buildDir, name), png);
  }

  console.log(`Generated icon.ico (${ico.length} bytes), icon.png (${bigPng.length} bytes), icon-512.png and icon-1024.png in ${buildDir}`);
}

function buildIco(entries) {
  const headerSize = 6;
  const dirEntrySize = 16;
  const dataOffset = headerSize + dirEntrySize * entries.length;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type = ICO
  header.writeUInt16LE(entries.length, 4); // count

  const dirEntries = [];
  const dataChunks = [];
  let currentOffset = dataOffset;

  for (const { size, png } of entries) {
    const entry = Buffer.alloc(dirEntrySize);
    entry.writeUInt8(size === 256 ? 0 : size, 0); // width (0 = 256)
    entry.writeUInt8(size === 256 ? 0 : size, 1); // height (0 = 256)
    entry.writeUInt8(0, 2); // colors (0 = no palette)
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // planes
    entry.writeUInt16LE(32, 6); // bit count
    entry.writeUInt32LE(png.length, 8); // size in bytes
    entry.writeUInt32LE(currentOffset, 12); // offset
    dirEntries.push(entry);
    dataChunks.push(png);
    currentOffset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...dataChunks]);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
