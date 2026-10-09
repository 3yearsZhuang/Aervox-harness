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
const BIG_PAYLOAD = Buffer.alloc(3 * 1024 * 1024, 7);
let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.on("error", () => undefined); // 客户端中止后写入不抛未捕获错误
    if (req.url === "/model.bin" || req.url?.startsWith("/model.bin")) {
      const range = req.headers.range;
      if (range) {
        const match = /bytes=(\d+)-/.exec(range);
        if (match) {
          const start = Number(match[1]);
          if (start >= PAYLOAD.length) {
            res.writeHead(416, { "Content-Range": `bytes */${PAYLOAD.length}` });
            res.end();
            return;
          }
          const slice = PAYLOAD.subarray(start);
          res.writeHead(206, {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(slice.length),
            "Content-Range": `bytes ${start}-${PAYLOAD.length - 1}/${PAYLOAD.length}`,
          });
          res.end(slice);
          return;
        }
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(PAYLOAD.length) });
      res.end(PAYLOAD);
      return;
    }
    if (req.url === "/no-range.bin") {
      // 忽略 Range 的服务端（始终 200 全量）
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(PAYLOAD.length) });
      res.end(PAYLOAD);
      return;
    }
    if (req.url === "/not-found") {
      res.writeHead(404);
      res.end("missing");
      return;
    }
    if (req.url === "/re-range-fail.bin") {
      // Range 请求 → 416；回退整量请求 → 500 错误正文（复现“错误正文被注册为模型”窗口）
      if (req.headers.range) {
        res.writeHead(416, { "Content-Range": `bytes */${PAYLOAD.length}` });
        res.end();
        return;
      }
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("server-error");
      return;
    }
    if (req.url === "/misaligned.bin") {
      // 206 起点与请求偏移不符（错位）
      if (req.headers.range) {
        const slice = PAYLOAD.subarray(0, Math.floor(PAYLOAD.length / 2));
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(slice.length),
          "Content-Range": `bytes 0-${slice.length - 1}/${PAYLOAD.length}`,
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(PAYLOAD.length) });
      res.end(PAYLOAD);
      return;
    }
    if (req.url === "/no-range-header.bin") {
      // 206 但缺少 Content-Range 头
      if (req.headers.range) {
        const slice = PAYLOAD.subarray(Math.floor(PAYLOAD.length / 2));
        res.writeHead(206, { "Content-Type": "application/octet-stream", "Content-Length": String(slice.length) });
        res.end(slice);
        return;
      }
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(PAYLOAD.length) });
      res.end(PAYLOAD);
      return;
    }
    if (req.url === "/partial-always.bin") {
      // 无 Range 请求也返回部分内容（协议异常）
      const half = PAYLOAD.subarray(0, Math.floor(PAYLOAD.length / 2));
      res.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(half.length),
        "Content-Range": `bytes 0-${half.length - 1}/${PAYLOAD.length}`,
      });
      res.end(half);
      return;
    }
    if (req.url === "/truncated.bin") {
      // 声明全量长度但提前断流：写完半量后立即 FIN（不等 keep-alive 超时）
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(PAYLOAD.length) });
      res.write(PAYLOAD.subarray(0, Math.floor(PAYLOAD.length / 2)));
      setTimeout(() => {
        try {
          res.socket?.end();
        } catch {
          // 已关闭
        }
      }, 10);
      return;
    }
    if (req.url === "/slow.bin") {
      // 慢速分块：为时长上限提供确定性窗口
      res.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": String(PAYLOAD.length) });
      setTimeout(() => res.write(PAYLOAD.subarray(0, 16)), 300);
      setTimeout(() => { try { res.end(PAYLOAD.subarray(16)); } catch { /* 已中止 */ } }, 600);
      return;
    }
    if (req.url === "/big.bin") {
      const range = req.headers.range;
      const start = range ? Number(/bytes=(\d+)-/.exec(String(range))?.[1] ?? 0) : 0;
      const slice = BIG_PAYLOAD.subarray(start);
      res.writeHead(start > 0 ? 206 : 200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(slice.length),
        ...(start > 0 ? { "Content-Range": `bytes ${start}-${BIG_PAYLOAD.length - 1}/${BIG_PAYLOAD.length}` } : {}),
      });
      res.end(slice);
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

  it("断点续传：携带 Range 从 206 追加并做全文件校验（CR-054 迭代）", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    const half = PAYLOAD.subarray(0, Math.floor(PAYLOAD.length / 2));
    try {
      // 预置半截 .part，模拟中断
      await fs.writeFile(`${dest}.part`, half);
      const expectedSha = createHash("sha256").update(PAYLOAD).digest("hex");
      const progress: number[] = [];
      const result = await downloadToFile({
        url: `${baseUrl}/model.bin`,
        destPath: dest,
        sha256: expectedSha,
        onProgress: (p) => progress.push(p.receivedBytes),
      });
      expect(result.receivedBytes).toBe(PAYLOAD.length);
      expect(result.sha256).toBe(expectedSha);
      expect(result.transferredBytes).toBe(PAYLOAD.length - half.length);
      expect(await fs.readFile(dest, "utf8")).toBe(PAYLOAD.toString("utf8"));
      expect(progress[0]).toBeGreaterThanOrEqual(half.length);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("服务端不支持 Range（200 全量）时回退整量覆盖（CR-054 迭代）", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    try {
      await fs.writeFile(`${dest}.part`, Buffer.from("partial-garbage"));
      const result = await downloadToFile({
        url: `${baseUrl}/no-range.bin`,
        destPath: dest,
      });
      expect(result.receivedBytes).toBe(PAYLOAD.length);
      expect(result.transferredBytes).toBe(PAYLOAD.length);
      expect(await fs.readFile(dest, "utf8")).toBe(PAYLOAD.toString("utf8"));
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

  it("416 回退重取后仍复查成功状态：错误正文不注册为模型", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    try {
      await fs.writeFile(`${dest}.part`, PAYLOAD.subarray(0, 4)); // 触发 Range → 416 → 回退整量 → 500
      await expect(
        downloadToFile({ url: `${baseUrl}/re-range-fail.bin`, destPath: dest }),
      ).rejects.toMatchObject({ kind: "http", httpStatus: 500 });
      await expect(fs.access(dest)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("206 起点错位时丢弃残片整量重下（不拼接错位字节）", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    const expectedSha = createHash("sha256").update(PAYLOAD).digest("hex");
    try {
      await fs.writeFile(`${dest}.part`, Buffer.from("misaligned-garbage"));
      const result = await downloadToFile({ url: `${baseUrl}/misaligned.bin`, destPath: dest, sha256: expectedSha });
      expect(result.receivedBytes).toBe(PAYLOAD.length);
      expect(result.transferredBytes).toBe(PAYLOAD.length);
      expect(result.sha256).toBe(expectedSha);
      expect(await fs.readFile(dest, "utf8")).toBe(PAYLOAD.toString("utf8"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("206 缺少 Content-Range 时丢弃残片整量重下", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    try {
      await fs.writeFile(`${dest}.part`, Buffer.from("stale-part"));
      const result = await downloadToFile({ url: `${baseUrl}/no-range-header.bin`, destPath: dest });
      expect(result.receivedBytes).toBe(PAYLOAD.length);
      expect(await fs.readFile(dest, "utf8")).toBe(PAYLOAD.toString("utf8"));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("无 Range 请求返回的意外 206 被拒绝（不落部分内容为模型）", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    try {
      await expect(
        downloadToFile({ url: `${baseUrl}/partial-always.bin`, destPath: dest }),
      ).rejects.toMatchObject({ kind: "http" });
      await expect(fs.access(dest)).rejects.toThrow();
      await expect(fs.access(`${dest}.part`)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("已知总长下截断流不注册正式文件，保留 .part 供续传", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    try {
      await expect(
        downloadToFile({ url: `${baseUrl}/truncated.bin`, destPath: dest }),
      ).rejects.toMatchObject({ kind: "io" });
      await expect(fs.access(dest)).rejects.toThrow();
      expect((await fs.stat(`${dest}.part`)).size).toBe(Math.floor(PAYLOAD.length / 2));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("超出体积上限时中止并清理残片", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    try {
      await expect(
        downloadToFile({ url: `${baseUrl}/model.bin`, destPath: dest, maxBytes: 16 }),
      ).rejects.toMatchObject({ kind: "io" });
      await expect(fs.access(dest)).rejects.toThrow();
      await expect(fs.access(`${dest}.part`)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("超出时长上限时中止并清理残片", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    try {
      await expect(
        downloadToFile({ url: `${baseUrl}/slow.bin`, destPath: dest, maxDurationMs: 80 }),
      ).rejects.toMatchObject({ kind: "io" });
      await expect(fs.access(dest)).rejects.toThrow();
      await expect(fs.access(`${dest}.part`)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("大残片续传：前缀哈希流式重算且全文件校验一致（多 MB）", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "aervox-mrdl-"));
    const dest = path.join(dir, "model.gguf");
    const half = Math.floor(BIG_PAYLOAD.length / 2);
    const expectedSha = createHash("sha256").update(BIG_PAYLOAD).digest("hex");
    try {
      await fs.writeFile(`${dest}.part`, BIG_PAYLOAD.subarray(0, half));
      const result = await downloadToFile({ url: `${baseUrl}/big.bin`, destPath: dest, sha256: expectedSha });
      expect(result.receivedBytes).toBe(BIG_PAYLOAD.length);
      expect(result.transferredBytes).toBe(BIG_PAYLOAD.length - half);
      expect(result.sha256).toBe(expectedSha);
      expect((await fs.stat(dest)).size).toBe(BIG_PAYLOAD.length);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});