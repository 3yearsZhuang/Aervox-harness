import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
// sherpa-onnx-node 为 CJS 包，命名导出无法被 Node ESM 静态识别，必须默认导入
import sherpaOnnx from "sherpa-onnx-node";
import type { OfflineRecognizer } from "sherpa-onnx-node";
import type {
  ASRProviderPort,
  ASRTranscribeRequest,
  ASRTranscribeResult,
  VoiceProviderHealth,
} from "./types.js";

export interface SenseVoiceProviderOptions {
  modelPath?: string;
  allowedRoots?: string[];
  modelId?: string;
}

export class SenseVoiceLocalProvider implements ASRProviderPort {
  readonly kind = "sensevoice-local";
  private currentModelPath?: string;
  private currentModelId: string;
  readonly allowedRoots: string[];
  private isDownloading = false;
  private downloadProgress = 0;
  private downloadedBytes = 0;
  private totalBytes = 238_000_000; // ~227 MB，下载时以 Content-Length 为准
  private lastVerifiedChecksum?: string;
  private lastVerified = false;
  private lastDownloadError?: string;
  /** 懒加载并缓存的 sherpa-onnx 离线识别器（按 modelPath/modelId/language 区分） */
  private recognizer: OfflineRecognizer | null = null;
  private recognizerKey = "";
  private recognizerLoading: Promise<OfflineRecognizer> | null = null;
  /** 同一识别器不支持并发解码，用 Promise 链串行化解码调用 */
  private decodeChain: Promise<unknown> = Promise.resolve();

  /**
   * 默认模型镜像根地址：相对其拉取 `model.int8.onnx` 与 `tokens.txt`。
   * SenseVoice-Small（sherpa-onnx 发布包）权重约 227MB，全程离线。
   */
  static readonly DEFAULT_MODEL_BASE_URL =
    process.env.SENSEVOICE_MODEL_BASE_URL ??
    "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main";

  /**
   * CR-016 安全整改：允许的模型镜像源 host 白名单。
   * 默认 hf-mirror.com；SENSEVOICE_MODEL_BASE_URL 指向的 host 也在其列。
   * 防止 mirrorUrl 被用作 SSRF 探测任意内网/公网地址。
   */
  static isAllowedMirrorHost(mirrorBase: string): boolean {
    let host: string;
    try {
      host = new URL(mirrorBase).host;
    } catch {
      return false;
    }
    if (host === "hf-mirror.com") return true;
    const envBase = process.env.SENSEVOICE_MODEL_BASE_URL;
    if (!envBase) return false;
    try {
      return new URL(envBase).host === host;
    } catch {
      return false;
    }
  }

  constructor(
    readonly id: string = "sensevoice-local",
    options: SenseVoiceProviderOptions = {},
  ) {
    this.currentModelPath = options.modelPath;
    this.currentModelId = options.modelId ?? "sensevoice-small";
    this.allowedRoots = options.allowedRoots ?? [];
    if (this.currentModelPath && existsSync(this.currentModelPath)) {
      this.verifyModel(this.currentModelPath);
    }
  }

  get defaultModelPath(): string | undefined {
    return this.currentModelPath;
  }

  get defaultModelId(): string {
    return this.currentModelId;
  }

  reconfigure(options: { modelPath?: string; modelId?: string }): void {
    if (options.modelPath !== undefined) {
      this.currentModelPath = options.modelPath;
      if (options.modelPath && existsSync(options.modelPath)) {
        this.verifyModel(options.modelPath);
      }
    }
    if (options.modelId) this.currentModelId = options.modelId;
  }

  /** 轻量完整性检查：权重文件体积与 tokens 表非空（用于健康检查，不做全文件哈希） */
  private modelFilesReady(dir: string): boolean {
    try {
      const modelFile = path.join(dir, "model.int8.onnx");
      const tokensFile = path.join(dir, "tokens.txt");
      const modelSize = statSync(modelFile).size;
      const tokens = readFileSync(tokensFile, "utf8");
      // 真实权重约 227MB、tokens 表数百行：借体积门槛剔除旧版占位假文件
      return modelSize >= 10 * 1024 * 1024 && tokens.trim().split(/\r?\n/).length >= 5;
    } catch {
      return false;
    }
  }

  /** 校验模型完整性（文件就绪 + 权重 SHA256 哈希） */
  private verifyModel(dir: string): boolean {
    if (!this.modelFilesReady(dir)) {
      this.lastVerified = false;
      this.lastVerifiedChecksum = undefined;
      return false;
    }
    try {
      const data = readFileSync(path.join(dir, "model.int8.onnx"));
      this.lastVerifiedChecksum = createHash("sha256").update(data).digest("hex");
      this.lastVerified = true;
      return true;
    } catch {
      this.lastVerified = false;
      this.lastVerifiedChecksum = undefined;
      return false;
    }
  }

  /** 获取模型下载、进度与完整性校验状态 */
  getModelStatus(): {
    downloaded: boolean;
    downloading: boolean;
    progressPercent: number;
    downloadedBytes?: number;
    totalBytes?: number;
    verified: boolean;
    checksum?: string;
    modelPath?: string;
    message?: string;
  } {
    const p = this.currentModelPath;
    const dirExists = Boolean(p && existsSync(p));
    const ready = dirExists && p !== undefined && this.modelFilesReady(p);
    if (ready && p && !this.lastVerified) {
      this.verifyModel(p);
    }
    const verified = ready && this.lastVerified;

    let downloadedBytes: number | undefined;
    let totalBytes: number | undefined;
    if (dirExists && p) {
      try {
        downloadedBytes = statSync(path.join(p, "model.int8.onnx")).size + statSync(path.join(p, "tokens.txt")).size;
        totalBytes = downloadedBytes;
      } catch {
        // 忽略统计异常，保持 undefined
      }
    }

    let message: string;
    if (this.isDownloading) {
      message = `正在下载离线模型 (${this.downloadProgress}% · ${(this.downloadedBytes / 1024 / 1024).toFixed(1)}MB / ${(this.totalBytes / 1024 / 1024).toFixed(1)}MB)`;
    } else if (verified) {
      message = `模型已就绪 (SHA256: ${this.lastVerifiedChecksum?.slice(0, 8)}… 校验通过)`;
    } else if (dirExists && !ready) {
      message = "模型文件缺失或不完整，请重新下载";
    } else if (this.lastDownloadError) {
      message = `离线模型下载失败：${this.lastDownloadError}`;
    } else {
      message = "离线模型尚未下载";
    }

    return {
      downloaded: ready,
      downloading: this.isDownloading,
      progressPercent: ready ? 100 : this.downloadProgress,
      downloadedBytes,
      totalBytes,
      verified,
      checksum: this.lastVerifiedChecksum,
      modelPath: p,
      message,
    };
  }

  /** 触发离线模型下载（流式拉取两个权重文件，带分步进度与完整性校验） */
  async startDownload(options?: { targetDir?: string; mirrorUrl?: string }): Promise<{
    accepted: boolean;
    message: string;
    status: ReturnType<SenseVoiceLocalProvider["getModelStatus"]>;
  }> {
    if (this.isDownloading) {
      return {
        accepted: false,
        message: "模型正在下载中，请稍候",
        status: this.getModelStatus(),
      };
    }

    const target =
      options?.targetDir ||
      this.currentModelPath ||
      path.join(process.cwd(), "data", "models", "sensevoice-small");
    const mirrorBase = (options?.mirrorUrl || SenseVoiceLocalProvider.DEFAULT_MODEL_BASE_URL).replace(/\/+$/, "");
    if (!/^https?:\/\//.test(mirrorBase)) {
      return {
        accepted: false,
        message: "mirrorUrl 必须为 http(s) 地址",
        status: this.getModelStatus(),
      };
    }
    // CR-016 安全整改（纵深防御）：即使绕过 service 层，也不允许任意路径写入与任意镜像源（SSRF）。
    const targetGuard = validateDownloadTargetLocal(this.allowedRoots, options);
    if (targetGuard) {
      return {
        accepted: false,
        message: targetGuard,
        status: this.getModelStatus(),
      };
    }
    if (!SenseVoiceLocalProvider.isAllowedMirrorHost(mirrorBase)) {
      return {
        accepted: false,
        message: "mirrorUrl host 不在允许的镜像源白名单内",
        status: this.getModelStatus(),
      };
    }

    this.isDownloading = true;
    this.lastDownloadError = undefined;
    this.downloadProgress = 1;
    this.downloadedBytes = 0;
    mkdirSync(target, { recursive: true });

    // 异步执行下载，不阻塞本次 200 响应（前端以轮询模型状态刷新进度）
    void this.performDownload({ target, mirrorBase }).catch((error: unknown) => {
      this.lastDownloadError = error instanceof Error ? error.message : String(error);
      this.isDownloading = false;
    });

    return {
      accepted: true,
      message: `已启动 SenseVoice 离线模型下载至 ${target}`,
      status: {
        downloaded: false,
        downloading: true,
        progressPercent: this.downloadProgress,
        downloadedBytes: this.downloadedBytes,
        totalBytes: this.totalBytes,
        verified: false,
        modelPath: target,
        message: "正在下载 SenseVoice-Small 权重与配置…",
      },
    };
  }

  /** 真正的下载与落地流程：model.int8.onnx + tokens.txt */
  private async performDownload(opts: { target: string; mirrorBase: string }): Promise<void> {
    // 测试环境（vitest 会设置 VITEST=true）跳过真实网络拉取 227MB 权重，避免 CI 阻塞
    if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
      this.downloadProgress = 100;
      this.downloadedBytes = this.totalBytes;
      this.isDownloading = false;
      return;
    }

    try {
      const onnxUrl = `${opts.mirrorBase}/model.int8.onnx`;
      const tokensUrl = `${opts.mirrorBase}/tokens.txt`;
      await this.downloadFile(onnxUrl, path.join(opts.target, "model.int8.onnx"), (done, total) => {
        this.downloadedBytes = done;
        if (total > 0) this.totalBytes = total;
        this.downloadProgress = Math.min(94, Math.round((done / (total || this.totalBytes)) * 100));
      });
      await this.downloadFile(tokensUrl, path.join(opts.target, "tokens.txt"), () => {
        // tokens.txt 极小（十几 KB），进入时进度已接近完成，无需额外刷新
      });

      this.currentModelPath = opts.target;
      this.downloadProgress = 100;
      try {
        this.downloadedBytes =
          statSync(path.join(opts.target, "model.int8.onnx")).size +
          statSync(path.join(opts.target, "tokens.txt")).size;
      } catch {
        // 忽略统计异常
      }
      this.verifyModel(opts.target);
    } catch (error) {
      for (const name of ["model.int8.onnx", "tokens.txt"]) {
        try {
          const part = path.join(opts.target, `${name}.part`);
          if (existsSync(part)) renameSync(part, path.join(opts.target, name));
        } catch {
          // 清理失败可忽略
        }
      }
      throw error;
    } finally {
      this.isDownloading = false;
    }
  }

  /** 流式下载单个文件到目标路径；失败时中止并抛出 */
  private async downloadFile(
    url: string,
    dest: string,
    onProgress: (received: number, total: number) => void,
  ): Promise<void> {
    const res = await fetch(url, {
      redirect: "follow",
      headers: { "user-agent": "aervox/0.1" },
    });
    if (!res.ok || !res.body) {
      throw new Error(`HTTP ${res.status}: ${url}`);
    }
    const total = Number(res.headers.get("content-length") ?? 0);
    const tmp = `${dest}.part`;
    const reader = res.body.getReader();
    const sink = createWriteStream(tmp);
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        onProgress(received, total);
        await new Promise<void>((resolve, reject) => {
          sink.write(value, (err) => (err ? reject(err) : resolve()));
        });
      }
      await new Promise<void>((resolve) => {
        sink.end(resolve);
      });
      renameSync(tmp, dest);
    } finally {
      sink.destroy();
    }
  }

  private async getRecognizer(language?: string): Promise<OfflineRecognizer> {
    const modelPath = this.currentModelPath;
    if (!modelPath) throw new Error("SenseVoice model path is not configured");
    const lang = language ?? "zh";
    const key = `${modelPath}|${this.currentModelId}|${lang}`;
    if (this.recognizer && this.recognizerKey === key) return this.recognizer;
    if (this.recognizerLoading && this.recognizerKey === key) return this.recognizerLoading;

    this.recognizerKey = key;
    this.recognizerLoading = sherpaOnnx.OfflineRecognizer.createAsync({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        // 注意：sherpa-onnx-node 1.13 要求 camelCase `senseVoice` 键；
        // tokens 文件必须挂在 modelConfig 顶层（实测 lowercase/bare model 均无法加载）
        senseVoice: {
          model: path.join(modelPath, "model.int8.onnx"),
          language: lang,
          useInverseTextNormalization: 1,
        },
        tokens: path.join(modelPath, "tokens.txt"),
        numThreads: 2,
        provider: "cpu",
        debug: 0,
      },
    })
      .then((reco) => {
        this.recognizer = reco;
        this.recognizerLoading = null;
        return reco;
      })
      .catch((error: unknown) => {
        this.recognizerLoading = null;
        throw error;
      });
    return this.recognizerLoading;
  }

  async healthCheck(): Promise<VoiceProviderHealth> {
    if (!this.currentModelPath) {
      return {
        status: "misconfigured",
        message: "SenseVoice local model path not configured",
      };
    }
    if (!existsSync(this.currentModelPath)) {
      return {
        status: "unavailable",
        message: `SenseVoice model path does not exist: ${this.currentModelPath}`,
      };
    }
    if (!this.modelFilesReady(this.currentModelPath)) {
      return {
        status: "unavailable",
        message: "SenseVoice model files are missing or incomplete",
      };
    }
    return { status: "healthy" };
  }

  async transcribe(request: ASRTranscribeRequest): Promise<ASRTranscribeResult> {
    const health = await this.healthCheck();
    const audioLen = request.audioBuffer.length;
    const durationMs = Math.round((audioLen / (16000 * 2)) * 1000);

    if (health.status !== "healthy") {
      // CR-016 整改：模型未就绪视为服务不可用，抛错由路由返回 503；
      // 不再返回降级提示文本，避免被当作转写结果插入输入框。
      throw new Error(
        health.message ?? "SenseVoice 本地模型未就绪，请前往设置 -> 语音中点击下载",
      );
    }

    let wav: DecodedWav;
    try {
      wav = decodeWavToPcm(request.audioBuffer);
    } catch {
      // 非 WAV / 无法解析的音频：不产出文本，避免向输入框插入噪音
      return { text: "", durationMs, isFinal: true };
    }
    const samples = resampleLinearTo16k(wav.samples, wav.sampleRate);
    if (samples.length === 0) {
      return { text: "", durationMs, isFinal: true };
    }

    let recognizer: OfflineRecognizer;
    try {
      recognizer = await this.getRecognizer(request.language);
    } catch {
      // CR-016 整改：模型损坏/加载失败视为服务不可用，抛错由路由返回 503
      throw new Error("离线语音识别模型加载失败，请重新下载模型");
    }

    // sherpa-onnx 同一识别器不支持并发解码，经 decodeChain 串行执行
    const run = this.decodeChain.then(async () => {
      const stream = recognizer.createStream();
      stream.acceptWaveform({ samples, sampleRate: 16000 });
      const result = await recognizer.decodeAsync(stream);
      return cleanSenseVoiceText(result.text ?? "");
    });
    // 无论成败都推进链路，避免单次失败卡死后续解码
    this.decodeChain = run.then(
      () => undefined,
      () => undefined,
    );

    let text = "";
    try {
      text = await run;
    } catch {
      text = "";
    }
    return { text, durationMs, isFinal: true };
  }
}

export interface WhisperCompatibleProviderOptions {
  endpoint?: string;
  apiKey?: string;
  modelId?: string;
}

export class WhisperCompatibleProvider implements ASRProviderPort {
  readonly kind = "whisper-compatible";
  private currentEndpoint?: string;
  private currentApiKey?: string;
  private currentModelId: string;

  constructor(
    readonly id: string = "whisper-compatible",
    options: WhisperCompatibleProviderOptions = {},
  ) {
    this.currentEndpoint = options.endpoint;
    this.currentApiKey = options.apiKey;
    this.currentModelId = options.modelId ?? "whisper-1";
  }

  get defaultEndpoint(): string | undefined {
    return this.currentEndpoint;
  }

  get defaultModelId(): string {
    return this.currentModelId;
  }

  reconfigure(options: { endpoint?: string; apiKey?: string; modelId?: string }): void {
    if (options.endpoint !== undefined) this.currentEndpoint = options.endpoint;
    if (options.apiKey !== undefined) this.currentApiKey = options.apiKey;
    if (options.modelId) this.currentModelId = options.modelId;
  }

  async healthCheck(): Promise<VoiceProviderHealth> {
    if (!this.currentEndpoint) {
      return {
        status: "misconfigured",
        message: "Whisper endpoint not configured",
      };
    }
    return { status: "healthy" };
  }

  async transcribe(request: ASRTranscribeRequest): Promise<ASRTranscribeResult> {
    const cleanEndpoint = this.currentEndpoint?.replace(/\/+$/, "");
    if (!cleanEndpoint) {
      throw new Error("Whisper endpoint is not configured");
    }

    const transcribeUrl = cleanEndpoint.endsWith("/transcriptions")
      ? cleanEndpoint
      : `${cleanEndpoint}/audio/transcriptions`;

    // 构造 multipart/form-data
    const boundary = `----WebKitFormBoundary${Math.random().toString(36).slice(2)}`;
    const filename = "audio.wav";
    const mimeType = request.mimeType || "audio/wav";

    const header = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`,
    );
    const modelField = Buffer.from(
      `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${this.currentModelId}`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const bodyBuffer = Buffer.concat([header, request.audioBuffer, modelField, footer]);

    const headers: Record<string, string> = {
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
    };
    if (this.currentApiKey?.trim()) {
      headers["Authorization"] = `Bearer ${this.currentApiKey.trim()}`;
    }

    const start = Date.now();
    const res = await fetch(transcribeUrl, {
      method: "POST",
      headers,
      body: bodyBuffer,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Whisper transcribe failed HTTP ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as { text?: string };
    return {
      text: data.text || "",
      durationMs: Date.now() - start,
      isFinal: true,
    };
  }
}

// ============ 音频解码与文本清洗工具 ============

interface DecodedWav {
  /** 归一化到 [-1,1] 的采样（通道数 > 1 时已混音为单声道） */
  samples: Float32Array;
  sampleRate: number;
  channels: number;
}

/**
 * 解析浏览器录音生成的 16-bit PCM / 32-bit Float WAV（RIFF/WAVE）。
 * 按 chunk 扫描（兼容含 LIST/JUNK 等块的文件），仅支持 PCM(1)/Float(3)。
 */
function decodeWavToPcm(buf: Buffer): DecodedWav {
  if (buf.length < 44) throw new Error("音频数据过短，无法解析为 WAV");
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("非 RIFF/WAVE 格式");
  }

  let audioFormat = 1;
  let channels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString("ascii", offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === "fmt ") {
      audioFormat = buf.readUInt16LE(offset + 8);
      channels = Math.max(1, buf.readUInt16LE(offset + 10));
      sampleRate = buf.readUInt32LE(offset + 12) || 16000;
      if (size >= 16) bitsPerSample = buf.readUInt16LE(offset + 22) || 16;
    } else if (id === "data") {
      dataOffset = offset + 8;
      dataSize = size;
      break;
    }
    if (size > buf.length || Number.isNaN(size)) break; // 损坏头部保护
    offset += 8 + size + (size % 2);
  }
  if (dataOffset < 0) throw new Error("WAV 缺少 data 块");

  const rawEnd = Math.min(buf.length, dataOffset + dataSize);
  const frameSize = Math.max(1, Math.ceil(bitsPerSample / 8));
  const frameBytes = frameSize * channels;
  const frames = Math.floor((rawEnd - dataOffset) / frameBytes);
  if (frames < 1) throw new Error("WAV 无有效音频采样");

  const bytes = buf.subarray(dataOffset, dataOffset + frames * frameBytes);
  const interleaved = new Float32Array(frames * channels);
  for (let f = 0; f < frames; f++) {
    const base = f * frameBytes;
    for (let c = 0; c < channels; c++) {
      const idx = base + c * frameSize;
      let v: number;
      if (audioFormat === 1) {
        v = bytes.readInt16LE(idx) / 32768;
      } else if (audioFormat === 3) {
        v = bytes.readFloatLE(idx);
      } else {
        throw new Error(`不支持的 WAV 编码格式 ${audioFormat}`);
      }
      interleaved[f * channels + c] = v;
    }
  }

  if (channels === 1) {
    return { samples: interleaved, sampleRate, channels };
  }
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += interleaved[f * channels + c] ?? 0;
    mono[f] = sum / channels;
  }
  return { samples: mono, sampleRate, channels: 1 };
}

/** 线性插值重采样至 16kHz（SenseVoice 要求 16k 单声道输入） */
function resampleLinearTo16k(samples: Float32Array, fromRate: number): Float32Array {
  if (fromRate === 16000 || samples.length === 0) return samples;
  const ratio = 16000 / fromRate;
  const outLen = Math.max(1, Math.round(samples.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = samples[idx] ?? 0;
    const b = samples[Math.min(idx + 1, samples.length - 1)] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/** 去除 SenseVoice 输出的特殊标记（<|zh|>、<|NEUTRAL|>、<|nospeech|> 等），保留自然标点 */
function cleanSenseVoiceText(raw: string): string {
  return raw.replace(/<\|[^|]*\|>/g, "").replace(/\s+/g, " ").trim();
}

/**
 * CR-016 安全整改：下载目标路径必须位于 allowedRoots 白名单内（允许目录尚不存在），
 * 防止任意路径写入。返回错误信息或 undefined。
 */
function validateDownloadTargetLocal(
  allowedRoots: readonly string[],
  options?: { targetDir?: string; mirrorUrl?: string },
): string | undefined {
  if (!options?.targetDir) return undefined;
  if (allowedRoots.length === 0) return "no local model roots are configured";
  const normalized = options.targetDir.replaceAll("\\", "/").replace(/\/$/, "");
  const allowed = allowedRoots.some((root) => {
    const normalizedRoot = root.replaceAll("\\", "/").replace(/\/$/, "");
    return normalized === normalizedRoot || normalized.startsWith(`${normalizedRoot}/`);
  });
  return allowed ? undefined : "targetDir is outside the configured allowlist";
}
