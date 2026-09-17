/**
 * Aervox｜思隅 @aervox/api — 本地模型流式下载器（CR-054）
 *
 * 原生 fetch 流式下载（无新增运行时依赖）：
 * - 落地到 `<models>/<file>.part`，完成校验后原子 rename 为正式路径；
 * - 断点续传：已存在 `.part` 时携带 `Range` 从已有字节继续；服务端以 206 响应则写追加
 *   （须先对既有部分重算 SHA-256 前缀），否则回退整量覆盖；
 * - 流式计算 SHA-256（用户提供校验值时强制校验，不匹配则删除产物并报错）；
 * - 进度回调（receivedBytes 为含既有续传字节的总量，totalBytes 取 Content-Length，未知则为 null）。
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface DownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

export interface DownloadOptions {
  url: string;
  destPath: string;
  sha256?: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
  /** 断点续传：基础偏移（启用后若服务端支持 Range 则追加写入）。缺省自动检测 .part */
  resumeOffsetBytes?: number;
  /** 限速（bytes/sec）；0 或缺省不限 */
  rateLimitBps?: number;
}

export interface DownloadResult {
  receivedBytes: number;
  sha256: string;
  /** 本次实际续传/新传的字节数（不含既有部分） */
  transferredBytes: number;
}

export class ModelDownloadError extends Error {
  constructor(
    message: string,
    readonly kind: "http" | "checksum" | "io" | "aborted",
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "ModelDownloadError";
  }
}

/** 流式下载：把 body 写入 <destPath>.part，校验成功后 rename 为 destPath */
export async function downloadToFile(options: DownloadOptions): Promise<DownloadResult> {
  const partPath = `${options.destPath}.part`;
  const hasher = createHash("sha256");

  // 检测既有 .part（断点续传基准），用户显式值优先
  let resumeOffset = 0;
  try {
    const stat = await fs.stat(partPath);
    if (stat.isFile()) resumeOffset = options.resumeOffsetBytes ?? stat.size;
  } catch {
    // 无既有 .part，从头下载
  }

  const headers: Record<string, string> = {};
  if (resumeOffset > 0) headers.Range = `bytes=${resumeOffset}-`;

  let res: Response;
  try {
    res = await fetch(options.url, {
      redirect: "follow",
      signal: options.signal,
      headers,
    });
  } catch (error) {
    throw new ModelDownloadError(
      error instanceof Error ? `网络请求失败: ${error.message}` : "网络请求失败",
      "io",
    );
  }
  if (!res.ok || !res.body) {
    // 服务端对 Range 返回 416（超出范围）时退回整量覆盖
    const follow = res.status === 416 || res.status === 405;
    if (!follow) {
      throw new ModelDownloadError(
        `服务返回 HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`,
        "http",
        res.status,
      );
    }
    res = await fetch(options.url, { redirect: "follow", signal: options.signal });
    resumeOffset = 0;
  }

  // 206 = 服务端接受续传（追加）；200 = 回退整量覆盖
  const resuming = resumeOffset > 0 && res.status === 206;
  if (!resuming) resumeOffset = 0;

  const totalBytes = (() => {
    const raw = res.headers.get("content-length");
    const parsed = raw ? Number(raw) : NaN;
    if (Number.isFinite(parsed) && parsed > 0) {
      return resuming ? resumeOffset + parsed : parsed;
    }
    return null;
  })();

  await fs.mkdir(path.dirname(options.destPath), { recursive: true });

  if (!res.body) {
    throw new ModelDownloadError("响应无 Body（无法下载）", "io");
  }

  // 续传时须先对既有部分计算 SHA-256 前缀（全文件校验）
  if (resuming) {
    const existing = await fs.readFile(partPath);
    hasher.update(existing);
  }

  const reader = res.body.getReader();
  let transferredBytes = 0;
  try {
    // 使用文件句柄逐块 flush，避免把数 GB 模型整体缓冲进内存
    const handle = await fs.open(partPath, resuming ? "a" : "w");
    try {
      const rateLimitBps = options.rateLimitBps ?? 0;
      let windowStart = Date.now();
      let windowBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
        transferredBytes += value.byteLength;
        await handle.write(value);
        options.onProgress?.({ receivedBytes: resumeOffset + transferredBytes, totalBytes });
        // 限速：以固定窗口滑动控制字节速率（窗口内不足的部分 sleep 补齐）
        if (rateLimitBps > 0) {
          windowBytes += value.byteLength;
          const elapsed = Date.now() - windowStart;
          const expectedMs = (windowBytes / rateLimitBps) * 1000;
          if (expectedMs > elapsed) {
            await new Promise((resolve) => setTimeout(resolve, expectedMs - elapsed));
          }
          if (windowBytes >= rateLimitBps) {
            windowStart = Date.now();
            windowBytes = 0;
          }
        }
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    // 中断保留 .part 供续传；仅在主动取消时保留残片
    if (error instanceof Error && error.name === "AbortError") {
      throw new ModelDownloadError("下载已取消", "aborted");
    }
    throw new ModelDownloadError(error instanceof Error ? error.message : "读取响应失败", "io");
  }

  const digest = hasher.digest("hex");
  if (options.sha256 && digest !== options.sha256.toLowerCase()) {
    // 校验失败：删除残片防止损坏数据续传
    await fs.rm(partPath, { force: true }).catch(() => undefined);
    throw new ModelDownloadError(
      `SHA-256 校验失败：期望 ${options.sha256}，实际 ${digest}`,
      "checksum",
    );
  }

  await fs.rename(partPath, options.destPath);
  return { receivedBytes: resumeOffset + transferredBytes, sha256: digest, transferredBytes };
}