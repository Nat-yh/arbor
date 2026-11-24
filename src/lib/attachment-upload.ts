import { MAX_ATTACHMENT_SIZE, attachmentError, attachmentMime, validAttachmentContent } from "./attachments";
import { CommandError } from "./commands";

/** 流式检查大小，沿用附件上传的文件名、MIME 和内容校验。 */
export async function readAttachment(request: Request) {
  const length = request.headers.get("content-length");
  if (length && Number(length) > MAX_ATTACHMENT_SIZE) throw new CommandError("单文件不能超过 10MB", 413);
  if (!request.body) throw new CommandError("请选择文件", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_ATTACHMENT_SIZE) { await reader.cancel(); throw new CommandError("单文件不能超过 10MB", 413); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let name: string;
  try { name = decodeURIComponent(request.headers.get("x-file-name") ?? ""); } catch { throw new CommandError("文件名编码无效", 400); }
  const mime = attachmentMime(name, request.headers.get("content-type") ?? "");
  const invalid = attachmentError({ name, mime, size });
  if (invalid) throw new CommandError(invalid, 400);
  const content = Buffer.concat(chunks);
  if (!validAttachmentContent(mime, content)) throw new CommandError("文件内容与类型不符", 415);
  return { name, mime, size, content };
}
