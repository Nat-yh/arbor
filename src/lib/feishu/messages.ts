import type { Report, ReportLine } from "../report";
import { progressDifference } from "./card-format";

// 自建应用 tenant_access_token：
// https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal
// 发送消息（receive_id_type=open_id/chat_id，content 为卡片 JSON 字符串）：
// https://open.feishu.cn/document/server-docs/im-v1/message/create
// 卡片 1.0 按钮：https://open.feishu.cn/document/common-capabilities/message-card/add-card-interaction/interactive-components/button
export const MESSAGE_ENDPOINTS = {
  token: "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
  messages: "https://open.feishu.cn/open-apis/im/v1/messages",
} as const;
export const messageConfigured = () => !!(process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET);
export const BOT_RECIPIENT_UNAVAILABLE = 230013;
export type SendResult = { status: "sent" | "failed" | "dry_run"; error?: string; messageId?: string; code?: number };
export type Card = ReturnType<typeof messageCard>;
const escape = (s: string) => s.replace(/[\\*\[\]<>_`]/g, "\\$&");
export function itemUrl(id?: string, updateId?: string, tab?: "quality") {
  const base = process.env.APP_BASE_URL;
  if (!base) throw new Error("未配置 APP_BASE_URL");
  const url = new URL(id ? `/item/${encodeURIComponent(id)}` : "/", base);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("APP_BASE_URL 必须使用 HTTP(S)");
  if (id && updateId) url.searchParams.set("update", updateId);
  if (id && tab) url.searchParams.set("tab", tab);
  return url.href;
}
const plain = (content: string) => ({ tag: "plain_text" as const, content });
const markdown = (content: string) => ({ tag: "div", text: { tag: "lark_md", content } });

function typedLine(line: ReportLine, showBullet: boolean) {
  const text = escape(line.text.slice(0, 200));
  const title = line.itemId ? `[${text}](${itemUrl(line.itemId, line.updateId)})` : text;
  const status = line.status && `<font color='${line.tone === "red" ? "red" : line.tone === "amber" ? "orange" : "grey"}'>${escape(line.status)}</font>`;
  const meta = [line.context, line.detail].filter(Boolean).map((value) => escape(value!.slice(0, 180))).join(" · ");
  return [
    [showBullet ? "•" : "", status, showBullet ? title : `**${title}**`].filter(Boolean).join(" "),
    meta,
  ].filter(Boolean).join("\n");
}

const columns = (content: string[], shaded = false) => ({
  tag: "column_set", flex_mode: "bisect", ...(shaded ? { background_style: "grey" } : {}),
  columns: content.map((text) => ({ tag: "column", width: "weighted", weight: 1, elements: [markdown(text)] })),
});

function progressElements(actual: number, plan: number, heading: string) {
  return [
    markdown(`**${escape(heading)}**`),
    columns([`实际进度\n**${actual}%**`, `计划进度\n**${plan}%**`], true),
    markdown(progressDifference(actual, plan)),
  ];
}

export function messageCard(report: Report, focusId?: string): {
  config: { wide_screen_mode: boolean };
  header: { title: ReturnType<typeof plain>; subtitle?: ReturnType<typeof plain>; template: string };
  elements: unknown[];
} {
  const visible = report.sections.filter((s) => s.lines.length || s.progress);
  const elements: unknown[] = [];
  let truncated = visible.length > 8;
  for (const [index, section] of visible.slice(0, 8).entries()) {
    if (index && report.tone === "neutral") elements.push({ tag: "hr" });
    if (section.progress) {
      elements.push(...progressElements(section.progress.actual, section.progress.plan, section.heading));
      continue;
    }
    const lines = section.lines.slice(0, 20);
    if (lines.length < section.lines.length) truncated = true;
    if (section.format === "plain") {
      elements.push({ tag: "div", text: plain([section.heading, ...lines.map((line) => line.text)].join("\n")) });
      continue;
    }
    const body = lines.map((line) => typedLine(line, !section.variant)).join("\n");
    const showHeading = section.heading !== report.title && !(section.variant === "focus" && lines[0]?.status);
    const text = [showHeading ? `**${escape(section.heading)}**` : "", body].filter(Boolean).join("\n");
    elements.push(section.variant === "focus" ? columns([text], true) : markdown(text));
  }
  while (Buffer.byteLength(JSON.stringify(elements)) > 20000 && elements.length) {
    elements.pop();
    truncated = true;
  }
  if (truncated) {
    const total = report.sections.reduce((n, section) => n + section.lines.length, 0);
    elements.push({ tag: "div", text: plain(`共 ${total} 条事项。打开 Arbor 查看完整内容。`) });
  }
  const action = report.action;
  elements.push({ tag: "action", actions: [{ tag: "button", text: plain(action?.label ?? "打开 Arbor"), type: "primary", url: itemUrl(action ? action.itemId : focusId, action?.updateId, action?.tab) }] });
  return {
    config: { wide_screen_mode: true },
    header: { title: plain(report.title.slice(0, 200)), ...(report.subtitle ? { subtitle: plain(report.subtitle) } : {}),
      template: report.tone === "neutral" ? "wathet" : report.tone ?? "blue" },
    elements,
  };
}
export class FeishuMessenger {
  private cached?: { token: string; refreshAt: number; key: string };
  private inflight?: Promise<string>;
  constructor(private network: typeof fetch = fetch, private clock: () => number = Date.now) {}
  async tenantToken(): Promise<string> {
    const appId = process.env.FEISHU_APP_ID; const secret = process.env.FEISHU_APP_SECRET;
    if (!appId || !secret) throw new Error("未配置飞书应用凭证");
    const key = `${appId}:${secret}`;
    if (this.cached?.key === key && this.cached.refreshAt > this.clock()) return this.cached.token;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const started = this.clock();
      const res = await this.network(MESSAGE_ENDPOINTS.token, { method: "POST", headers: { "Content-Type": "application/json; charset=utf-8" }, cache: "no-store", signal: AbortSignal.timeout(10000), body: JSON.stringify({ app_id: appId, app_secret: secret }) });
      const data = await res.json();
      if (!res.ok || data.code !== 0 || typeof data.tenant_access_token !== "string" || !Number.isFinite(data.expire) || data.expire <= 0) throw new Error(`飞书 token 获取失败（HTTP ${res.status}，code ${String(data.code)}）`);
      this.cached = { key, token: data.tenant_access_token, refreshAt: started + Math.max(0, data.expire - Math.min(120, data.expire / 2)) * 1000 };
      return this.cached.token;
    })();
    try { return await this.inflight; } finally { this.inflight = undefined; }
  }
  async send(type: "open_id" | "chat_id", recipient: string | null, card: Card, uuid: string, forceDryRun = false): Promise<SendResult> {
    if (forceDryRun || !messageConfigured()) return { status: "dry_run" };
    try {
      if (!recipient) throw new Error("账号尚未绑定 feishu_open_id，请先飞书登录");
      const token = await this.tenantToken();
      const res = await this.network(`${MESSAGE_ENDPOINTS.messages}?receive_id_type=${type}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" }, cache: "no-store", signal: AbortSignal.timeout(10000), // uuid 用于飞书侧重试去重；实际有效时长需在当前应用/API 版本核对，不能替代本地幂等记录。
      body: JSON.stringify({ receive_id: recipient, msg_type: "interactive", content: JSON.stringify(card), uuid }) });
      const data = await res.json();
      if (!res.ok || data.code !== 0 || typeof data.data?.message_id !== "string") {
        // 不记录响应正文，避免 token、用户数据或应用密钥进入日志。
        const code = typeof data.code === "number" ? data.code : undefined;
        const error = `飞书消息发送失败（HTTP ${res.status}，code ${code ?? "unknown"}）`;
        if (code !== BOT_RECIPIENT_UNAVAILABLE) {
          this.cached = undefined;
          console.error("Arbor 飞书推送失败", error);
        }
        return { status: "failed", error, code };
      }
      return { status: "sent", messageId: data.data.message_id };
    } catch (error) {
      const message = error instanceof Error ? error.message : "飞书网络请求失败";
      console.error("Arbor 飞书推送失败", message);
      return { status: "failed", error: message.slice(0, 1000) };
    }
  }
}
export const messenger = new FeishuMessenger();
