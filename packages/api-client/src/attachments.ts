import { getClientTransport } from './client-context.js';
import { type AttachmentUploadInput, type UploadedAttachment, type AervoxTransport } from './transport';

/** Upload through the configured platform transport. */
export async function uploadAervoxAttachment(input: AttachmentUploadInput, transport: AervoxTransport = getClientTransport()): Promise<UploadedAttachment> {
  if (!transport.uploadAttachment) throw new Error('当前传输层不支持附件上传');
  return transport.uploadAttachment(input);
}
