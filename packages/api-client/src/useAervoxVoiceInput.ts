/**
 * Aervox｜思隅 @aervox/api-client — 语音输入 (ASR) 组合式 API（CR-016）
 *
 * 提供：配置读写、录音启动/停止、句子级断句实时转写回调。
 */
import { getCurrentScope, onScopeDispose, ref } from 'vue';
import { getClientTransport } from './client-context.js';
import { VoiceInputRecorder } from './voice-input-recorder';

export type { VoiceInputEngine as VoiceInputEngineType, VoiceInputConfigInput as VoiceInputConfigDto, VoiceTranscribeOutput as VoiceTranscribeResultDto, VoiceInputModelStatus as VoiceInputModelStatusDto, VoiceInputModelDownloadOutput as VoiceInputModelDownloadResultDto } from '@aervox/contracts';
import type { VoiceInputConfigInput as VoiceInputConfigDto, VoiceTranscribeOutput as VoiceTranscribeResultDto, VoiceInputModelStatus as VoiceInputModelStatusDto, VoiceInputModelDownloadOutput as VoiceInputModelDownloadResultDto } from '@aervox/contracts';
import { voiceApi, voiceInputConfigResponseSchema, voiceTranscribeResponseSchema } from '@aervox/contracts';
import { requestEndpoint } from './endpoint.js';

function asBase64(bytes: Uint8Array): string {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i] ?? 0);
  }
  return btoa(binary);
}

export function useAervoxVoiceInput() {
  const transport = getClientTransport();
  const isListening = ref(false);
  const isTranscribing = ref(false);
  let recorder: VoiceInputRecorder | null = null;
  let generation = 0;
  let disposed = false;
  let transcriptionController = new AbortController();

  /** 读取本地实例的语音输入配置 */
  const getInputConfig = async (signal?: AbortSignal): Promise<VoiceInputConfigDto> =>
    transport.request('GET', voiceApi.input.path, undefined, { signal }).then(value => voiceInputConfigResponseSchema.parse(value));

  /** 保存本地实例的语音输入配置 */
  const saveInputConfig = async (
    body: VoiceInputConfigDto,
  ): Promise<VoiceInputConfigDto> =>
    requestEndpoint(transport, voiceApi.saveInput, body);

  /** 单次音频片段转写 */
  const transcribeAudio = async (
    audioBytes: Uint8Array,
    mimeType = 'audio/wav',
    signal?: AbortSignal,
  ): Promise<VoiceTranscribeResultDto> => {
    return transport.request('POST', voiceApi.transcribe.path, {
      audioBase64: asBase64(audioBytes),
      mimeType,
    }, { signal }).then(value => voiceTranscribeResponseSchema.parse(value));
  };

  /** 启动连续录音与句子级断句转写 */
  const startListening = async (callbacks: {
    onText: (text: string) => void;
    onError?: (err: Error) => void;
    silenceThresholdMs?: number;
  }): Promise<void> => {
    if (disposed) throw new Error('voice_input_disposed');
    if (recorder) return;
    const epoch = ++generation;
    transcriptionController.abort();
    const controller = transcriptionController = new AbortController();
    let pending = 0;
    isTranscribing.value = false;
    const current = new VoiceInputRecorder({
      silenceThresholdMs: callbacks.silenceThresholdMs ?? 700,
      onSpeechSegment: async wavBytes => {
        if (controller.signal.aborted) return;
        pending += 1;
        isTranscribing.value = true;
        try {
          const result = await transcribeAudio(wavBytes, 'audio/wav', controller.signal);
          if (!controller.signal.aborted && result.text?.trim()) callbacks.onText(result.text.trim());
        } catch (error) {
          if (!controller.signal.aborted) callbacks.onError?.(error instanceof Error ? error : new Error(String(error)));
        } finally {
          pending -= 1;
          if (epoch === generation) isTranscribing.value = pending > 0;
        }
      },
      onError: error => {
        if (!controller.signal.aborted) callbacks.onError?.(error);
        if (recorder === current) stopListening();
      },
    });
    recorder = current;
    try {
      await current.start();
      if (recorder === current) isListening.value = current.active;
    } catch (error) {
      if (recorder === current) {
        recorder = null;
        isListening.value = false;
      }
      throw error;
    }
  };

  /** User stop keeps the final submitted transcription alive. */
  const stopListening = (): void => {
    const current = recorder;
    recorder = null;
    isListening.value = false;
    current?.stop();
  };

  if (getCurrentScope()) onScopeDispose(() => {
    disposed = true;
    ++generation;
    transcriptionController.abort();
    recorder?.stop(false);
    recorder = null;
    isListening.value = false;
    isTranscribing.value = false;
  });

  /** 读取离线语音输入模型状态 */
  const getModelStatus = async (): Promise<VoiceInputModelStatusDto> =>
    requestEndpoint(transport, voiceApi.modelStatus);

  /** 触发离线语音输入模型下载 */
  const downloadModel = async (options?: {
    targetDir?: string;
    mirrorUrl?: string;
  }): Promise<VoiceInputModelDownloadResultDto> =>
    requestEndpoint(transport, voiceApi.downloadModel, options ?? {});

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
