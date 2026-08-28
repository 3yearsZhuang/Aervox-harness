/**
 * Aervox｜思隅 @aervox/api-client — 浏览器端录音与自适应静音断句控制器
 *
 * 参考 dsh-voice-local 核心机制：
 * 1. Web Audio API 16kHz 单声道采样；
 * 2. 持续跟踪环境底噪并动态计算 RMS 能量；
 * 3. 维持 250ms 前置环形缓冲（Pre-roll），防止吞首字；
 * 4. 说话停止后静音超过门限（如 700ms）触发断句回调，生成标准 WAV 编码切片。
 */

export interface VoiceInputRecorderOptions {
  sampleRate?: number;
  silenceThresholdMs?: number;
  preRollMs?: number;
  onSpeechStart?: () => void;
  onSpeechSegment?: (wavBuffer: Uint8Array) => void;
  onError?: (error: Error) => void;
}

export class VoiceInputRecorder {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;

  private isRunning = false;
  private isSpeaking = false;
  private silenceTimer: any = null;

  private readonly sampleRate: number;
  private readonly silenceThresholdMs: number;
  private readonly preRollMs: number;

  // 环形缓冲队列
  private preRollBuffer: Float32Array[] = [];
  private speechChunks: Float32Array[] = [];
  private noiseFloor = 0.01;

  constructor(private readonly options: VoiceInputRecorderOptions = {}) {
    this.sampleRate = options.sampleRate ?? 16000;
    this.silenceThresholdMs = options.silenceThresholdMs ?? 700;
    this.preRollMs = options.preRollMs ?? 250;
  }

  get active(): boolean {
    return this.isRunning;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;

    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("当前环境不支持录音 (navigator.mediaDevices 不可用)");
    }

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });

    const AudioContextClass =
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.audioContext = new AudioContextClass({ sampleRate: this.sampleRate });

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    // 使用 4096 buffer size 进行流式帧处理
    this.processorNode = this.audioContext.createScriptProcessor(4096, 1, 1);

    this.processorNode.onaudioprocess = (event) => {
      if (!this.isRunning) return;
      const inputData = event.inputBuffer.getChannelData(0);
      this.processAudioFrame(inputData);
    };

    this.sourceNode.connect(this.processorNode);
    this.processorNode.connect(this.audioContext.destination);

    this.isRunning = true;
    this.isSpeaking = false;
    this.preRollBuffer = [];
    this.speechChunks = [];
  }

  stop(): void {
    if (!this.isRunning) return;

    // 若停止时有尚未提交的语音片段，完成最后一次切片转写
    if (this.isSpeaking && this.speechChunks.length > 0) {
      this.flushSegment();
    }

    this.isRunning = false;
    this.isSpeaking = false;
    clearTimeout(this.silenceTimer);

    try {
      this.processorNode?.disconnect();
      this.sourceNode?.disconnect();
      this.mediaStream?.getTracks().forEach((t) => t.stop());
      if (this.audioContext?.state !== "closed") {
        void this.audioContext?.close();
      }
    } catch {
      // 忽略清理异常
    }

    this.processorNode = null;
    this.sourceNode = null;
    this.mediaStream = null;
    this.audioContext = null;
    this.preRollBuffer = [];
    this.speechChunks = [];
  }

  private processAudioFrame(frame: Float32Array): void {
    const copy = new Float32Array(frame);
    const rms = this.calculateRMS(copy);

    // 自适应跟踪环境底噪
    if (rms < this.noiseFloor * 1.5) {
      this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
    }

    const speechThreshold = Math.max(0.015, this.noiseFloor * 2.5);

    if (rms > speechThreshold) {
      if (!this.isSpeaking) {
        this.isSpeaking = true;
        this.options.onSpeechStart?.();
        // 将前置缓冲全部并入
        this.speechChunks.push(...this.preRollBuffer);
        this.preRollBuffer = [];
      }
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
      this.speechChunks.push(copy);
    } else {
      if (this.isSpeaking) {
        this.speechChunks.push(copy);
        if (!this.silenceTimer) {
          this.silenceTimer = setTimeout(() => {
            this.flushSegment();
            this.isSpeaking = false;
            this.silenceTimer = null;
          }, this.silenceThresholdMs);
        }
      } else {
        // 未说话时维护 250ms 前置环形缓冲
        this.preRollBuffer.push(copy);
        const maxPreRollFrames = Math.ceil((this.sampleRate * (this.preRollMs / 1000)) / copy.length);
        while (this.preRollBuffer.length > maxPreRollFrames) {
          this.preRollBuffer.shift();
        }
      }
    }
  }

  private flushSegment(): void {
    if (this.speechChunks.length === 0) return;

    let totalLength = 0;
    for (const chunk of this.speechChunks) {
      totalLength += chunk.length;
    }

    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.speechChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.speechChunks = [];

    // 音频长度过滤（大于 0.3s 才发出转写）
    if (totalLength < this.sampleRate * 0.3) {
      return;
    }

    const wavBytes = this.encodeWAV(merged, this.sampleRate);
    this.options.onSpeechSegment?.(wavBytes);
  }

  private calculateRMS(data: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const val = data[i] ?? 0;
      sum += val * val;
    }
    return Math.sqrt(sum / data.length);
  }

  /** 将 32-bit Float PCM 编码为 16-bit Mono WAV 格式二进制字节 */
  private encodeWAV(samples: Float32Array, sampleRate: number): Uint8Array {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    // RIFF chunk descriptor
    this.writeString(view, 0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    this.writeString(view, 8, "WAVE");

    // fmt sub-chunk
    this.writeString(view, 12, "fmt ");
    view.setUint32(16, 16, true); // 16 for PCM
    view.setUint16(20, 1, true); // PCM format
    view.setUint16(22, 1, true); // 1 channel (mono)
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate (sampleRate * 1 * 2)
    view.setUint16(32, 2, true); // block align (1 * 2)
    view.setUint16(34, 16, true); // 16 bits per sample

    // data sub-chunk
    this.writeString(view, 36, "data");
    view.setUint32(40, samples.length * 2, true);

    // 写入 16-bit PCM 采样
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return new Uint8Array(buffer);
  }

  private writeString(view: DataView, offset: number, string: string): void {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }
}
