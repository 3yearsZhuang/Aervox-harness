/**
 * Aervox｜思隅 @aervox/api-client — 语音客户端能力单元测试（CR-011）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useAervoxVoice,
  canPickDirectory,
  basenameOf,
  configureAervoxClient,
  type AervoxTransport,
  type LocalVoiceConfigDto,
  type VoiceModelDto,
  type VoiceSynthesisResultDto,
} from '../src/index.js';

describe('useAervoxVoice / 语音组合式 API', () => {
  let mockTransport: AervoxTransport;
  let requestMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    requestMock = vi.fn();
    mockTransport = {
      request: requestMock,
      streamTurn: vi.fn(),
    };
    configureAervoxClient({ transport: mockTransport });
    delete (globalThis as unknown as { window?: { fairyDesktop?: unknown } }).window;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('basenameOf 路径提取工具', () => {
    it('正确解析 POSIX 路径的末尾目录名', () => {
      expect(basenameOf('/opt/models/gpt-sovits/v1')).toBe('v1');
      expect(basenameOf('/opt/models/spk_hatsune/')).toBe('spk_hatsune');
    });

    it('正确解析 Windows 路径的末尾目录名', () => {
      expect(basenameOf('C:\\models\\gpt-sovits\\v2')).toBe('v2');
      expect(basenameOf('D:\\voice\\speakers\\mizuki\\\\')).toBe('mizuki');
    });

    it('无路径前缀时直接返回原名称', () => {
      expect(basenameOf('default-speaker')).toBe('default-speaker');
    });
  });

  describe('canPickDirectory / 桌面桥检测', () => {
    it('在非 Electron 环境（无 window 或无 fairyDesktop）下返回 false', () => {
      expect(canPickDirectory()).toBe(false);
    });

    it('在注入了 pickDirectory 的 Electron 环境下返回 true', () => {
      (globalThis as unknown as { window: { fairyDesktop: { pickDirectory: () => Promise<string | null> } } }).window = {
        fairyDesktop: {
          pickDirectory: vi.fn().mockResolvedValue('/opt/model'),
        },
      };
      expect(canPickDirectory()).toBe(true);
    });
  });

  describe('useAervoxVoice API 操作', () => {
    it('getConfig 正确发起 GET /v1/voice/config 请求', async () => {
      const mockConfig: LocalVoiceConfigDto = {
        enabled: true,
        providerId: 'gpt-sovits-local',
        modelId: 'm1',
        modelPath: '/path/to/model',
        speakerId: 'spk1',
      };
      requestMock.mockResolvedValueOnce(mockConfig);

      const api = useAervoxVoice();
      const res = await api.getConfig();

      expect(requestMock).toHaveBeenCalledWith('GET', '/v1/voice/config');
      expect(res).toEqual(mockConfig);
    });

    it('saveConfig 正确发起 PUT /v1/voice/config 请求', async () => {
      const payload: LocalVoiceConfigDto = {
        enabled: true,
        providerId: 'gpt-sovits-local',
        modelId: 'm2',
        modelPath: '/path/to/m2',
        speakerId: 'spk2',
        settings: {},
      };
      requestMock.mockResolvedValueOnce(payload);

      const api = useAervoxVoice();
      const res = await api.saveConfig(payload);

      expect(requestMock).toHaveBeenCalledWith('PUT', '/v1/voice/config', payload);
      expect(res).toEqual(payload);
    });

    it('loadLocalVoices 过滤出 source=local 且 available=true 的本地模型', async () => {
      const models: VoiceModelDto[] = [
        {
          providerId: 'gpt-sovits-local',
          modelId: 'local-1',
          displayName: 'Local 1',
          speakerIds: ['s1', 's2'],
          available: true,
          source: 'local',
        },
        {
          providerId: 'gpt-sovits-local',
          modelId: 'local-broken',
          displayName: 'Broken',
          speakerIds: [],
          available: false,
          source: 'local',
        },
        {
          providerId: 'gpt-sovits-remote',
          modelId: 'remote-1',
          displayName: 'Remote 1',
          speakerIds: [],
          available: true,
          source: 'remote',
        },
      ];
      requestMock.mockResolvedValueOnce({ models });

      const api = useAervoxVoice();
      const res = await api.loadLocalVoices();

      expect(requestMock).toHaveBeenCalledWith('GET', '/v1/voice/models');
      expect(res).toHaveLength(1);
      expect(res[0].modelId).toBe('local-1');
    });

    it('synthesize 发送合成请求并包含必要字段', async () => {
      const mockResult: VoiceSynthesisResultDto = {
        providerId: 'gpt-sovits-local',
        modelId: 'm1',
        contentType: 'audio/wav',
        audioBase64: 'UklGRg==',
      };
      requestMock.mockResolvedValueOnce(mockResult);

      const api = useAervoxVoice();
      const res = await api.synthesize({
        providerId: 'gpt-sovits-local',
        modelId: 'm1',
        speakerId: 'spk1',
        text: '测试文本',
      });

      expect(requestMock).toHaveBeenCalledWith('POST', '/v1/voice/synthesize', {
        providerId: 'gpt-sovits-local',
        modelId: 'm1',
        speakerId: 'spk1',
        text: '测试文本',
      });
      expect(res).toEqual(mockResult);
    });

    it('pickDirectory 在桌面桥可用时调用桥方法并返回路径', async () => {
      const pickMock = vi.fn().mockResolvedValue('/selected/folder');
      (globalThis as unknown as { window: { fairyDesktop: { pickDirectory: typeof pickMock } } }).window = {
        fairyDesktop: {
          pickDirectory: pickMock,
        },
      };

      const api = useAervoxVoice();
      const res = await api.pickDirectory();

      expect(pickMock).toHaveBeenCalled();
      expect(res).toBe('/selected/folder');
    });

    it('pickDirectory 在无桌面桥时安全返回 null', async () => {
      const api = useAervoxVoice();
      const res = await api.pickDirectory();

      expect(res).toBeNull();
    });
  });
});
