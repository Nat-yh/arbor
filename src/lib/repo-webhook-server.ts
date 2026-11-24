import { createHash, createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { safeEqual } from "./auth";
import { repoEvents } from "./db/schema";
import { loadState, persistState, withWriteLock } from "./db/state";
import { parseGiteaPayload } from "./gitea";
import { verifyGiteaSignature } from "./gitea-server";
import { apiError, json } from "./http";
import { today } from "./model";
import { persistHandoffs } from "./notifications/outbox";
import { type RepoProvider } from "./repo-providers";
import { applyRepoEvent, repoActor } from "./repo-sync";
import { parseRepoWebhook } from "./repo-webhook-events";

const limits = { size: 1024 * 1024, gitlabClockSkewMs: 5 * 60 * 1000 };
const platforms = {
  github: { event: "x-github-event", delivery: "x-github-delivery", secret: "GITHUB_WEBHOOK_SECRET" },
  gitlab: { event: "x-gitlab-event", delivery: "webhook-id", secret: "GITLAB_WEBHOOK_SECRET" },
  gitee: { event: "x-gitee-event", delivery: "x-gitee-delivery", secret: "GITEE_WEBHOOK_SECRET" },
  gitea: { event: "x-gitea-event", delivery: "x-gitea-delivery", secret: "GITEA_WEBHOOK_SECRET" },
} as const;

function validGitLabSignature(raw: string, headers: Headers, secret: string) {
  if (!secret.startsWith("whsec_")) return safeEqual(headers.get("x-gitlab-token") ?? "", secret);
  const token = secret.slice(6);
  if (!/^[\w+/]{43}=$/.test(token)) return false;
  const id = headers.get("webhook-id");
  const timestamp = headers.get("webhook-timestamp") ?? "";
  if (!id || !/^\d{10}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > limits.gitlabClockSkewMs) return false;
  const digest = createHmac("sha256", Buffer.from(token, "base64")).update(`${id}.${timestamp}.${raw}`).digest("base64");
  return headers.get("webhook-signature")?.split(/\s+/).some((signature) => safeEqual(signature, `v1,${digest}`)) ?? false;
}

function verify(provider: RepoProvider, body: Record<string, unknown>, raw: string, headers: Headers) {
  const key = platforms[provider].secret;
  const secret = process.env[key] ?? "";
  if (!secret) return { ok: false, reason: `未配置 ${key}` };
  if (provider === "gitea") return verifyGiteaSignature(raw, headers, secret);
  if (provider === "gitlab") return { ok: validGitLabSignature(raw, headers, secret), reason: "GitLab 签名或令牌不匹配" };
  if (provider === "gitee") {
    const password = headers.get("x-gitee-token") ?? (typeof body.password === "string" ? body.password : "");
    return { ok: safeEqual(password, secret), reason: "Gitee Webhook 密码不匹配" };
  }
  const digest = createHmac("sha256", secret).update(raw).digest("hex");
  return { ok: safeEqual(headers.get("x-hub-signature-256") ?? "", `sha256=${digest}`), reason: "GitHub 签名不匹配" };
}

export async function handleRepoWebhook(provider: RepoProvider, request: Request) {
  try {
    if (Number(request.headers.get("content-length")) > limits.size) return json({ ok: false, error: "请求体过大" }, 413);
    const rawText = await request.text();
    if (Buffer.byteLength(rawText) > limits.size) return json({ ok: false, error: "请求体过大" }, 413);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawText);
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    } catch { return json({ ok: false, error: "请求体不是 JSON 对象" }, 400); }
    const verified = verify(provider, body, rawText, request.headers);
    if (!verified.ok) return json({ ok: false, error: verified.reason }, 401);
    const config = platforms[provider];
    const eventHeader = request.headers.get(config.event);
    const now = new Date();
    const event = provider === "gitea"
      ? parseGiteaPayload(eventHeader, request.headers.get("x-gitea-event-type"), body, true, now.toISOString())
      : parseRepoWebhook(provider, eventHeader ?? "", body, now.toISOString());
    if (!event) return json({ ok: false, error: "Webhook 缺少有效的仓库路径" }, 400);
    const delivery = request.headers.get(config.delivery) ??
      (provider === "gitlab" ? request.headers.get("idempotency-key") ?? request.headers.get("x-gitlab-webhook-uuid") : null);
    const deliveryKey = delivery ?? `${eventHeader ?? ""}\n${rawText}`;
    event.id = createHash("sha256").update(provider === "gitea" ? deliveryKey : `${provider}\n${deliveryKey}`).digest("hex");
    return await withWriteLock(async (tx) => {
      const [seen] = await tx.select({ id: repoEvents.id }).from(repoEvents).where(eq(repoEvents.id, event.id));
      if (seen) return json({ ok: true, duplicate: true });
      const before = await loadState(tx);
      const applied = applyRepoEvent(before.items, before.accounts, event, today(now), before.people);
      const after = { ...before, items: applied.items, repoEvents: [applied.record, ...before.repoEvents] };
      await persistState(tx, before, after);
      const actorId = repoActor(before.accounts, provider, event.sender) ?? repoActor(before.accounts, provider, event.author);
      await persistHandoffs(tx, before, after, { id: event.id, actorId }, now);

      const raw = { ...body };
      for (const credential of ["secret", "sign", "password", "token"]) delete raw[credential];
      await tx.update(repoEvents).set({ raw }).where(eq(repoEvents.id, event.id));
      return json({ ok: true, kind: event.kind, ref: event.ref ?? null, verified: true });
    });
  } catch (error) { return apiError(error); }
}
