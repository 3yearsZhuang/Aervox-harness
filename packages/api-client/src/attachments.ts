import { getTransport, type AttachmentUploadInput, type UploadedAttachment } from './transport';

/** Upload through the configured platform transport. */
export async function uploadAervoxAttachment(input: AttachmentUploadInput): Promise<UploadedAttachment> {
  const transport = getTransport();
  if (!transport.uploadAttachment) throw new Error('当前传输层不支持附件上传');
  return transport.uploadAttachment(input);
}
