/**
 * Aervox｜思隅 @aervox/api — 本地模型流式下载器（CR-054）
 *
 * 原生 fetch 流式下载（无新增运行时依赖）：
 * - 落地到 `<models>/<file>.part`，完成校验后原子 rename 为正式路径；
 * - 断点续传：已存在 `.part` 时携带 `Range` 从已有字节继续；仅接受与本地偏移一致且覆盖
 *   实体末尾的 `206 Content-Range`；错位/换实体/缺头部时丢弃残片整量重下（自愈），
 *   不拼接错位字节；
 * - 前缀哈希按块流式重算（不整读 `.part`）；已知总长时核对实际字节数，截断不落正式文件；
 * - 流式计算 SHA-256（用户提供校验值时强制校验，不匹配则删除产物并报错）；
 * - 体积/时长上限（maxBytes / maxDurationMs）超限中止并清理残片；
 * - 进度回调（receivedBytes 为含既有续传字节的总量，totalBytes 取 Content-Length，未知则为 null）。
 */
import { createHash, type Hash } from "node:crypto";
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
  /** 单文件体积上限（bytes）；0 或缺省不限 */
  maxBytes?: number;
  /** 单次下载时长上限（ms）；0 或缺省不限 */
  maxDurationMs?: number;
  /** 模型根目录；提供时要求 destPath 为其直接子文件（纵深防御，防越根写入） */
  rootDir?: string;
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

/** 哈希读取块大小（前缀重算的内存占用与模型体积无关） */
const HASH_READ_CHUNK_BYTES = 1024 * 1024;

/** 把文件前 `bytes` 字节按块流式送入已有 hasher（不整读文件） */
async function hashFilePrefixInto(hasher: Hash, filePath: string, bytes: number): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(HASH_READ_CHUNK_BYTES);
    let remaining = bytes;
    let position = 0;
    while (remaining > 0) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, remaining), position);
      if (bytesRead <= 0) throw new Error(`残片实际长度不足（期望 ${bytes} 字节）`);
      hasher.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
    }
  } finally {
    await handle.close();
  }
}

/** 解析 Content-Length（缺失/非法返回 null） */
function parseContentLength(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 校验 206 响应与本地续传基准是否一致：起点等于期望偏移、长度与 Content-Length 一致、
 * 且区间覆盖实体末尾（防止把错位/换实体的字节拼进残片）。一致返回 null，否则返回原因。
 */
function describeRangeMismatch(res: Response, expectedOffset: number): string | null {
  const contentRange = res.headers.get("content-range");
  const match = contentRange ? /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(contentRange.trim()) : null;
  if (!match) return `缺少有效 Content-Range（${contentRange ?? "无"}）`;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = match[3] === "*" ? null : Number(match[3]);
  if (start !== expectedOffset) return `起点错位（期望 ${expectedOffset}，实际 ${start}）`;
  if (end < start) return `区间非法（${contentRange}）`;
  const length = parseContentLength(res.headers.get("content-length"));
  if (length !== null && end - start + 1 !== length) {
    return `长度与 Content-Length 不一致（${contentRange}，content-length=${length}）`;
  }
  if (total !== null && end !== total - 1) return `区间未覆盖实体末尾（${contentRange}）`;
  return null;
}

async function httpFailure(res: Response): Promise<ModelDownloadError> {
  const snippet = await res.text().catch(() => "");
  return new ModelDownloadError(`服务返回 HTTP ${res.status}: ${snippet.slice(0, 120)}`, "http", res.status);
}

/** 流式下载：把 body 写入 <destPath>.part，校验成功后 rename 为 destPath */
export async function downloadToFile(options: DownloadOptions): Promise<DownloadResult> {
  const partPath = `${options.destPath}.part`;
  const maxBytes = options.maxBytes ?? 0;
  const maxDurationMs = options.maxDurationMs ?? 0;

  if (options.rootDir) {
    const root = path.resolve(options.rootDir);
    if (path.dirname(path.resolve(options.destPath)) !== root) {
      throw new ModelDownloadError(`下载目标不在模型目录内：${path.basename(options.destPath)}`, "io");
    }
  }

  // 体积/时长上限：超限与用户取消区分（用户取消保持 aborted 语义）
  const limitController = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, limitController.signal]) : limitController.signal;
  let limitReason: "bytes" | "duration" | null = null;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  if (maxDurationMs > 0) {
    durationTimer = setTimeout(() => {
      limitReason = "duration";
      limitController.abort();
    }, maxDurationMs);
  }
  const limitError = (): ModelDownloadError => new ModelDownloadError(
    limitReason === "duration" ? `下载超时（> ${maxDurationMs}ms）` : `累计字节超出上限（> ${maxBytes} bytes）`,
    "io",
  );

  try {
    // 检测既有 .part（断点续传基准），用户显式值优先
    let resumeOffset = 0;
    try {
      const stat = await fs.stat(partPath);
      if (stat.isFile()) resumeOffset = options.resumeOffsetBytes ?? stat.size;
    } catch {
      // 无既有 .part，从头下载
    }

    const request = async (headers?: Record<string, string>): Promise<Response> => {
      try {
        return await fetch(options.url, { redirect: "follow", signal, headers });
      } catch (error) {
        if (limitReason) throw limitError();
        if (options.signal?.aborted) throw new ModelDownloadError("下载已取消", "aborted");
        throw new ModelDownloadError(
          error instanceof Error ? `网络请求失败: ${error.message}` : "网络请求失败",
          "io",
        );
      }
    };

    // 取得可用响应：416/405 回退整量（回退后同样复查成功状态）；206 校验偏移与实体，
    // 不一致时丢弃残片重下（自愈），任何响应都必须带 Body。
    const resolveResponse = async (): Promise<{ res: Response; resuming: boolean; offset: number }> => {
      let offset = resumeOffset;
      let res = await request(offset > 0 ? { Range: `bytes=${offset}-` } : undefined);
      if ((!res.ok || !res.body) && (res.status === 416 || res.status === 405) && offset > 0) {
        res = await request();
        offset = 0;
      }
      if (!res.ok || !res.body) throw await httpFailure(res);
      if (res.status !== 206) return { res, resuming: false, offset: 0 };
      const mismatch = describeRangeMismatch(res, offset);
      if (!mismatch) return { res, resuming: offset > 0, offset };
      if (offset === 0) {
        throw new ModelDownloadError(`服务返回意外的部分内容：${mismatch}`, "http", res.status);
      }
      await res.body?.cancel().catch(() => undefined);
      await fs.rm(partPath, { force: true }).catch(() => undefined);
      const retry = await request();
      if (!retry.ok || !retry.body) throw await httpFailure(retry);
      if (retry.status === 206) {
        throw new ModelDownloadError(
          `服务在整量请求下仍返回部分内容：${describeRangeMismatch(retry, 0) ?? "状态异常"}`,
          "http",
          retry.status,
        );
      }
      return { res: retry, resuming: false, offset: 0 };
    };

    const resolved = await resolveResponse();
    const res = resolved.res;
    const resuming = resolved.resuming;
    resumeOffset = resolved.offset;

    const contentLength = parseContentLength(res.headers.get("content-length"));
    const totalBytes = contentLength === null ? null : resuming ? resumeOffset + contentLength : contentLength;
    if (maxBytes > 0 && totalBytes !== null && totalBytes > maxBytes) {
      throw new ModelDownloadError(`模型体积超出上限（${totalBytes} > ${maxBytes} bytes）`, "io");
    }

    await fs.mkdir(path.dirname(options.destPath), { recursive: true });

    const hasher = createHash("sha256");
    // 续传时先对既有部分流式重算 SHA-256 前缀（全文件校验；内存占用与模型体积无关）
    if (resuming) {
      try {
        await hashFilePrefixInto(hasher, partPath, resumeOffset);
      } catch (error) {
        throw new ModelDownloadError(
          error instanceof Error ? `续传残片不可读：${error.message}` : "续传残片不可读",
          "io",
        );
      }
    }

    if (!res.body) {
      throw new ModelDownloadError("响应无 Body（无法下载）", "io");
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
          if (maxBytes > 0 && resumeOffset + transferredBytes > maxBytes) {
            limitReason = "bytes";
            limitController.abort();
            break;
          }
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
      if (limitReason) {
        await fs.rm(partPath, { force: true }).catch(() => undefined);
        throw limitError();
      }
      // 中断保留 .part 供续传；仅在主动取消时保留残片
      if (error instanceof Error && error.name === "AbortError") {
        throw new ModelDownloadError("下载已取消", "aborted");
      }
      throw new ModelDownloadError(error instanceof Error ? error.message : "读取响应失败", "io");
    }

    if (limitReason) {
      await fs.rm(partPath, { force: true }).catch(() => undefined);
      throw limitError();
    }

    // 已知总长时核对实际字节数：截断/超发都视为不完整（保留 .part 供续传）
    const receivedBytes = resumeOffset + transferredBytes;
    if (totalBytes !== null && receivedBytes !== totalBytes) {
      throw new ModelDownloadError(`下载字节数不完整（收到 ${receivedBytes} / 期望 ${totalBytes}）`, "io");
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
    return { receivedBytes, sha256: digest, transferredBytes };
  } finally {
    if (durationTimer) clearTimeout(durationTimer);
  }
}
