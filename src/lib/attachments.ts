import type { Account } from "./access";
import { canSee } from "./access";
import type { Attachment, WorkItem } from "./model";
import { isInactive } from "./tree";

export const MAX_ITEM_SCREENSHOTS = 10;
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
export const ATTACHMENT_TYPES: Record<string, string[]> = {
  "image/png": ["png"], "image/jpeg": ["jpg", "jpeg"], "image/gif": ["gif"], "image/webp": ["webp"],
  "application/pdf": ["pdf"], "text/plain": ["txt", "log", "md"], "text/csv": ["csv"],
  "application/zip": ["zip"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ["docx"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ["xlsx"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ["pptx"],
};
export const attachmentMime = (name: string, supplied = "") => {
  const ext = name.split(".").at(-1)?.toLowerCase();
  // 浏览器可能未提供文本/Office 的 MIME，按明确扩展名补齐；有 MIME 时必须匹配。
  const mime = supplied.split(";")[0].trim().toLowerCase();
  const aliases: Record<string, string> = { "text/markdown": "text/plain", "application/x-zip-compressed": "application/zip", "image/jpg": "image/jpeg", "application/vnd.ms-excel": "text/csv" };
  return mime && mime !== "application/octet-stream" ? aliases[mime] ?? mime : Object.entries(ATTACHMENT_TYPES).find(([, exts]) => exts.includes(ext ?? ""))?.[0] ?? "";
};
export function attachmentError(file: Pick<Attachment, "name" | "mime" | "size">): string | undefined {
  if (!file.name.trim() || file.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(file.name)) return "文件名无效";
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > MAX_ATTACHMENT_SIZE) return "单文件必须大于 0 且不超过 10MB";
  const ext = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  if (!ATTACHMENT_TYPES[file.mime]?.includes(ext)) return "不支持此文件类型，请选择图片、PDF、文本、Office 文档或 ZIP";
}
export function validAttachmentContent(mime: string, bytes: Uint8Array): boolean {
  const hex = (n: number) => Array.from(bytes.slice(0, n), (b) => b.toString(16).padStart(2, "0")).join("");
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  if (mime === "image/png") return hex(8) === "89504e470d0a1a0a";
  if (mime === "image/jpeg") return hex(3) === "ffd8ff";
  if (mime === "image/gif") return ["GIF87a", "GIF89a"].includes(ascii(0, 6));
  if (mime === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (mime === "application/pdf") return ascii(0, 5) === "%PDF-";
  if (mime.startsWith("text/")) { try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return !bytes.includes(0); } catch { return false; } }
  if (!ATTACHMENT_TYPES[mime]) return false;
  return ["504b0304", "504b0506", "504b0708"].includes(hex(4));
}
export function canAccessAttachment(items: WorkItem[], file: Pick<Attachment, "itemId">, acc: Account, write = false) {
  const item = items.find((x) => x.id === file.itemId);
  return !!item && canSee(items, item, acc) && (!write || !isInactive(items, item));
}
export function attachmentHeaders(file: Pick<Attachment, "name" | "mime" | "size">) {
  const fallback = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const encoded = encodeURIComponent(file.name).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return {
    "Content-Type": file.mime,
    "Content-Length": String(file.size),
    "Content-Disposition": `${file.mime.startsWith("image/") ? "inline" : "attachment"}; filename="${fallback}"; filename*=UTF-8''${encoded}`,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "default-src 'none'; sandbox",
  };
}
