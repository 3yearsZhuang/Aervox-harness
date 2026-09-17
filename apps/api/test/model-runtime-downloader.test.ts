/**
 * Aervox｜思隅 @aervox/api — 本地模型流式下载器测试（CR-054）
 *
 * 起一个真实 Node http 服务器 serve 小体积 payload，验证：
 * 流式进度、SHA-256 校验、.part 原子改名、校验失败清理、HTTP 错误分类。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { downloadToFile, ModelDownloadError } from "../src/modules/ecosystem/model-runtime/downloader.js";

const PAYLOAD = Buffer.from("Aervox local model runtime download probe\n".repeat(1024));
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/model.bin") {
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(PAYLOAD.length) });
      res.end(PAYLOAD);
      return;
    }
    if (req.url === "/not-found") {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("downloadToFile (CR-054)", () => {
  it("流式下载：进度回调、落盘、SHA-256 精确匹配", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    const expectedSha = createHash("sha256").update(PAYLOAD).digest("hex");
    const progresses: number[] = [];
    try {
      const result = await downloadToFile({
        url: `${baseUrl}/model.bin`,
        destPath: dest,
        sha256: expectedSha,
        onProgress: (p) => progresses.push(p.receivedBytes),
      });
      expect(result.receivedBytes).toBe(PAYLOAD.length);
      expect(result.sha256).toBe(expectedSha);
      // 校验通过后才 rename：正式路径存在且 .part 残留不存在
      expect(await fs.readFile(dest, "utf8")).toBe(PAYLOAD.toString("utf8"));
      await expect(fs.access(`${dest}.part`)).rejects.toThrow();
      expect(progresses.length).toBeGreaterThan(0);
      expect(progresses.at(-1)).toBe(PAYLOAD.length);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("SHA-256 不匹配时删除 .part 并抛出 checksum 错误", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    try {
      await expect(
        downloadToFile({ url: `${baseUrl}/model.bin`, destPath: dest, sha256: "0".repeat(64) }),
      ).rejects.toMatchObject({ kind: "checksum" });
      await expect(fs.access(dest)).rejects.toThrow();
      await expect(fs.access(`${dest}.part`)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("HTTP 非 200 归类为 http 错误", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    try {
      await expect(
        downloadToFile({ url: `${baseUrl}/not-found`, destPath: dest }),
      ).rejects.toMatchObject({ kind: "http", httpStatus: 404 });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("网络不可达归类为 io 错误", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    try {
      // 使用保留端口 1 的地址确保不可达
      await expect(
        downloadToFile({ url: "http://127.0.0.1:1/model.gguf", destPath: dest }),
      ).rejects.toThrow(ModelDownloadError);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});