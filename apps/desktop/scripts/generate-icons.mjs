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

  console.log(`Generated icon.ico (${ico.length} bytes) and icon.png (${bigPng.length} bytes) in ${buildDir}`);
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
