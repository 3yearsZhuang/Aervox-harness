import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isAttachmentUploadRequest, uploadAttachment } from '../src/main/attachment-upload';

describe('desktop attachment-upload (ARC-13 附件上传 Bearer 认证加固)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('校验合法与非法附件上传请求', () => {
    const valid = {
      fileName: 'test.png',
      mediaType: 'image/png',
      purpose: 'user_attachment',
      dataBase64: Buffer.from('fake-image-bytes').toString('base64'),
      idempotencyKey: 'idemp-123',
    };
    expect(isAttachmentUploadRequest(valid)).toBe(true);

    expect(isAttachmentUploadRequest(null)).toBe(false);
    expect(isAttachmentUploadRequest({})).toBe(false);
    expect(isAttachmentUploadRequest({ ...valid, fileName: '' })).toBe(false);
    expect(isAttachmentUploadRequest({ ...valid, mediaType: 'invalid-mime' })).toBe(false);
    expect(isAttachmentUploadRequest({ ...valid, purpose: '' })).toBe(false);
    expect(isAttachmentUploadRequest({ ...valid, dataBase64: '' })).toBe(false);
  });

  it('超限与空字节附件在上传前即刻被拦截', async () => {
    const emptyPayload = {
      fileName: 'empty.txt',
      mediaType: 'text/plain',
      purpose: 'note',
      dataBase64: '',
    };
    await expect(uploadAttachment(null, emptyPayload)).rejects.toThrow('invalid upload request');

    const oversizedBuffer = Buffer.alloc(10 * 1024 * 1024 + 1, 'a');
    const oversizedPayload = {
      fileName: 'big.bin',
      mediaType: 'application/octet-stream',
      purpose: 'dataset',
      dataBase64: oversizedBuffer.toString('base64'),
    };
    await expect(uploadAttachment(null, oversizedPayload)).rejects.toThrow('附件大小超出限制');
  });

  it('存在 AERVOX_AUTH_TOKEN 时在附件请求头中注入 Bearer Token 并在 query 中携带幂等键', async () => {
    process.env.AERVOX_AUTH_TOKEN = 'secret-desktop-token-123';
    process.env.AERVOX_API_URL = 'http://127.0.0.1:4000';

    const sampleContent = Buffer.from('hello world');
    const payload = {
      fileName: 'greeting.txt',
      mediaType: 'text/plain',
      purpose: 'chat_upload',
      dataBase64: sampleContent.toString('base64'),
      idempotencyKey: 'idem-456',
    };

    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(JSON.stringify({ id: 'att_001', size: sampleContent.byteLength }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const result = await uploadAttachment(null, payload);

    expect(capturedUrl).toContain('http://127.0.0.1:4000/v1/attachments/binary?');
    const url = new URL(capturedUrl);
    expect(url.searchParams.get('fileName')).toBe('greeting.txt');
    expect(url.searchParams.get('mediaType')).toBe('text/plain');
    expect(url.searchParams.get('purpose')).toBe('chat_upload');
    expect(url.searchParams.get('idempotencyKey')).toBe('idem-456');

    expect(capturedInit?.method).toBe('POST');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('text/plain');
    expect(headers.Authorization).toBe('Bearer secret-desktop-token-123');
    expect(capturedInit?.body).toEqual(sampleContent);
    expect(result).toEqual({ id: 'att_001', size: sampleContent.byteLength });
  });

  it('无 AERVOX_AUTH_TOKEN 时不注入 Authorization 请求头', async () => {
    delete process.env.AERVOX_AUTH_TOKEN;
    process.env.AERVOX_API_URL = 'http://127.0.0.1:3000';

    const payload = {
      fileName: 'photo.jpg',
      mediaType: 'image/jpeg',
      purpose: 'avatar',
      dataBase64: Buffer.from('image-data').toString('base64'),
    };

    let capturedHeaders: Record<string, string> | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return new Response(JSON.stringify({ id: 'att_002' }), { status: 200 });
    });

    await uploadAttachment(null, payload);
    expect(capturedHeaders?.Authorization).toBeUndefined();
    expect(capturedHeaders?.['Content-Type']).toBe('image/jpeg');
  });

  it('远端 API 返回非 2xx 时抛出可读错误', async () => {
    const payload = {
      fileName: 'fail.txt',
      mediaType: 'text/plain',
      purpose: 'test',
      dataBase64: Buffer.from('data').toString('base64'),
    };

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 }),
    );

    await expect(uploadAttachment(null, payload)).rejects.toThrow('附件上传失败（HTTP 500）');
  });
});
