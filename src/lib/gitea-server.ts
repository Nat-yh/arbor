// 仅服务端使用：校验原始请求体的 Gitea WebHook 签名。
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyGiteaSignature(rawBody: string, headers: Headers, secret: string): { ok: boolean; reason?: string } {
  if (!secret) return { ok: false, reason: "未配置 GITEA_WEBHOOK_SECRET" };
  const signature = headers.get("x-gitea-signature");
  const hubSignature = headers.get("x-hub-signature-256");
  if (!signature && !hubSignature) return { ok: false, reason: "缺少 Gitea 签名" };
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const same = (value: string) => /^[a-fA-F0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value, "hex"), expected);
  const ok = !!((signature && same(signature)) || (hubSignature?.startsWith("sha256=") && same(hubSignature.slice(7))));
  return ok ? { ok: true } : { ok: false, reason: "签名不匹配" };
}
