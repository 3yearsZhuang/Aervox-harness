/**
 * Aervox｜思隅 @aervox/api-client — 语音输入 (ASR) 组合式 API（CR-016）
 *
 * 提供：配置读写、录音启动/停止、句子级断句实时转写回调。
 */
import { ref } from 'vue';
import { getTransport } from './transport';
import { VoiceInputRecorder } from './voice-input-recorder';

export type VoiceInputEngineType = 'sensevoice-local' | 'whisper-compatible';

export interface VoiceInputConfigDto {
  enabled: boolean;
  engineType: VoiceInputEngineType;
  modelPath?: string;
  modelId: string;
  endpoint?: string;
  apiKey?: string;
  autoStopOnKeyboard: boolean;
  vadSilenceThresholdMs: number;
  settings?: Record<string, string | number | boolean>;
}

export interface VoiceTranscribeResultDto {
  text: string;
  durationMs?: number;
  isFinal: boolean;
}

export interface VoiceInputModelStatusDto {
  downloaded: boolean;
  downloading: boolean;
  progressPercent: number;
  downloadedBytes?: number;
  totalBytes?: number;
  verified: boolean;
  checksum?: string;
  modelPath?: string;
  message?: string;
}

export interface VoiceInputModelDownloadResultDto {
  accepted: boolean;
  message: string;
  status: VoiceInputModelStatusDto;
}

function asBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

export function useAervoxVoiceInput() {
  const transport = getTransport();
  const isListening = ref(false);
  const isTranscribing = ref(false);
  let recorder: VoiceInputRecorder | null = null;

  /** 读取当前租户的语音输入配置 */
  const getInputConfig = async (): Promise<VoiceInputConfigDto> =>
    transport.request<VoiceInputConfigDto>('GET', '/v1/voice/input/config');

  /** 保存当前租户的语音输入配置 */
  const saveInputConfig = async (
    body: VoiceInputConfigDto,
  ): Promise<VoiceInputConfigDto> =>
    transport.request<VoiceInputConfigDto>('PUT', '/v1/voice/input/config', body);

  /** 单次音频片段转写 */
  const transcribeAudio = async (
    audioBytes: Uint8Array,
    mimeType = 'audio/wav',
  ): Promise<VoiceTranscribeResultDto> => {
    return transport.request<VoiceTranscribeResultDto>('POST', '/v1/voice/transcribe', {
      audioBase64: asBase64(audioBytes),
      mimeType,
    });
  };

  /** 启动连续录音与句子级断句转写 */
  const startListening = async (callbacks: {
    onText: (text: string) => void;
    onError?: (err: Error) => void;
    silenceThresholdMs?: number;
  }): Promise<void> => {
    if (isListening.value) return;

    try {
      recorder = new VoiceInputRecorder({
        silenceThresholdMs: callbacks.silenceThresholdMs ?? 700,
        onSpeechSegment: async (wavBytes) => {
          try {
            isTranscribing.value = true;
            const res = await transcribeAudio(wavBytes);
            if (res.text && res.text.trim()) {
              callbacks.onText(res.text.trim());
            }
          } catch (e) {
            callbacks.onError?.(e instanceof Error ? e : new Error(String(e)));
          } finally {
            isTranscribing.value = false;
          }
        },
        onError: (err) => {
          callbacks.onError?.(err);
          stopListening();
        },
      });

      await recorder.start();
      isListening.value = true;
    } catch (e) {
      isListening.value = false;
      throw e;
    }
  };

  /** 停止录音 */
  const stopListening = (): void => {
    if (!isListening.value && !recorder) return;
    try {
      recorder?.stop();
    } finally {
      recorder = null;
      isListening.value = false;
    }
  };

  /** 读取离线语音输入模型状态 */
  const getModelStatus = async (): Promise<VoiceInputModelStatusDto> =>
    transport.request<VoiceInputModelStatusDto>('GET', '/v1/voice/input/model/status');

  /** 触发离线语音输入模型下载 */
  const downloadModel = async (options?: {
    targetDir?: string;
    mirrorUrl?: string;
  }): Promise<VoiceInputModelDownloadResultDto> =>
    transport.request<VoiceInputModelDownloadResultDto>(
      'POST',
      '/v1/voice/input/model/download',
      options ?? {},
    );

  return {
    isListening,
    isTranscribing,
    getInputConfig,
    saveInputConfig,
    getModelStatus,
    downloadModel,
    transcribeAudio,
    startListening,
    stopListening,
  };
}
