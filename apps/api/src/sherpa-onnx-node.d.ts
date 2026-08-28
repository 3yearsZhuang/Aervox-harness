/**
 * Aervox｜思隅 @aervox/api — sherpa-onnx-node 环境类型声明
 *
 * sherpa-onnx-node 为 CJS + 原生 addon 且未随包提供 .d.ts（version 1.13.x），
 * 这里仅声明 SenseVoice 离线识别用到的最小 API 子集。
 */

declare module "sherpa-onnx-node" {
  export interface OfflineSenseVoiceModelConfig {
    model?: string;
    language?: string;
    /** 0 或 1：是否启用逆文本归一化（数字/标点还原） */
    useInverseTextNormalization?: number;
  }

  export interface OfflineModelConfig {
    /** 必须为 camelCase `senseVoice`（sherpa-onnx-node 1.13 实测约定） */
    senseVoice?: OfflineSenseVoiceModelConfig;
    tokens?: string;
    numThreads?: number;
    debug?: number;
    provider?: string;
  }

  export interface OfflineRecognizerConfig {
    featConfig?: { sampleRate?: number; featureDim?: number };
    modelConfig?: OfflineModelConfig;
  }

  export interface OfflineRecognizerResult {
    text?: string;
    tokens?: string[];
  }

  export interface OfflineStream {
    acceptWaveform(obj: { samples: Float32Array; sampleRate: number }): void;
  }

  export class OfflineRecognizer {
    constructor(config: OfflineRecognizerConfig);
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decode(stream: OfflineStream): void;
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
    getResult(stream: OfflineStream): OfflineRecognizerResult;
  }

  /**
   * sherpa-onnx-node 为 CJS 包（module.exports 对象字面量），
   * Node 的 cjs-module-lexer 无法静态识别其命名导出，
   * 运行时必须用默认导入互操作拿整个模块对象。
   */
  const mod: {
    OfflineRecognizer: typeof OfflineRecognizer;
    version: string;
  };
  export default mod;
}