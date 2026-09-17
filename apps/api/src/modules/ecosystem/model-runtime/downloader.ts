/**
 * Aervox｜思隅 @aervox/api — 本地模型流式下载器（CR-054）
 *
 * 原生 fetch 流式下载（无新增运行时依赖）：
 * - 落地到 `<models>/<file>.part`，完成校验后原子 rename 为正式路径（断点续下前的
 *   .part 残片在下次下载时被重新覆盖）；
 * - 流式计算 SHA-256（用户提供校验值时强制校验，不匹配则删除产物并报错）；
 * - 进度回调（receivedBytes / totalBytes，totalBytes 取 Content-Length，未知则为 undefined）。
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
}

export interface DownloadResult {
  receivedBytes: number;
  sha256: string;
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
  let receivedBytes = 0;

  let res: Response;
  try {
    res = await fetch(options.url, {
      redirect: "follow",
      signal: options.signal,
    });
  } catch (error) {
    throw new ModelDownloadError(
      error instanceof Error ? `网络请求失败: ${error.message}` : "网络请求失败",
      "io",
    );
  }
  if (!res.ok || !res.body) {
    throw new ModelDownloadError(
      `服务返回 HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 120)}`,
      "http",
      res.status,
    );
  }

  const totalBytes = (() => {
    const raw = res.headers.get("content-length");
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  })();

  await fs.mkdir(path.dirname(options.destPath), { recursive: true });
  const reader = res.body.getReader();
  try {
    // 使用文件句柄逐块 flush，避免把数 GB 模型整体缓冲进内存
    const handle = await fs.open(partPath, "w");
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hasher.update(value);
        receivedBytes += value.byteLength;
        await handle.write(value);
        options.onProgress?.({ receivedBytes, totalBytes });
      }
    } finally {
      await handle.close();
    }
  } catch (error) {
    await fs.rm(partPath, { force: true }).catch(() => undefined);
    throw error instanceof ModelDownloadError
      ? error
      : new ModelDownloadError(error instanceof Error ? error.message : "读取响应失败", "io");
  }

  const digest = hasher.digest("hex");
  if (options.sha256 && digest !== options.sha256.toLowerCase()) {
    await fs.rm(partPath, { force: true }).catch(() => undefined);
    throw new ModelDownloadError(
      `SHA-256 校验失败：期望 ${options.sha256}，实际 ${digest}`,
      "checksum",
    );
  }

  await fs.rename(partPath, options.destPath);
  return { receivedBytes, sha256: digest };
}