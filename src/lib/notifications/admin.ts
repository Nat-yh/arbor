import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { isAdmin, type Account } from "../access";
import { CommandError } from "../commands";
import { db } from "../db";
import { accounts, notificationLog, workItems } from "../db/schema";
import { publicAccount } from "../db/state";
import { messageCard, messageConfigured, messenger } from "../feishu/messages";
import type { Notice } from "./plan";
import { withNotificationLock } from "./runner";

export function requireNotificationAdmin(account: Account) {
  if (!isAdmin(account)) throw new CommandError("只有管理员能查看飞书接入或发送测试消息", 403);
}
export async function notificationStatus(account: Account) {
  requireNotificationAdmin(account);
  const [people, projects, logs] = await Promise.all([
    db().select({ id: accounts.id, name: accounts.name, active: accounts.active, bound: accounts.feishuOpenId }).from(accounts),
    db().select().from(workItems).where(eq(workItems.kind, "project")),
    db().select().from(notificationLog).orderBy(desc(notificationLog.createdAt), desc(notificationLog.id)).limit(50),
  ]);
  return {
    configured: messageConfigured(), dryRun: !messageConfigured(), schedulerEnabled: process.env.RUN_SCHEDULER === "true",
    timezone: process.env.APP_TIMEZONE ?? "Asia/Shanghai", baseUrlConfigured: !!process.env.APP_BASE_URL,
    projects: projects.map((p) => ({ id: p.id, title: p.data.title, group: p.data.feishuGroup, chatId: p.data.feishuChatId })),
    people: people.map((p) => ({ ...p, bound: !!p.bound })),
    // 不向客户端暴露凭证、完整卡片快照和 open_id。
    logs: logs.map((r) => ({ id: r.id, type: r.type, title: r.payload.report.title, objectId: r.objectId, recipient: r.recipient, status: r.status, mode: r.mode, error: r.error, attempts: r.attempts, createdAt: r.createdAt.toISOString(), sentAt: r.sentAt?.toISOString() ?? null })),
  };
}
export async function testNotification(account: Account) {
  requireNotificationAdmin(account);
  const outcome = await withNotificationLock(async () => {
    const [person] = await db().select().from(accounts).where(eq(accounts.id, account.id));
    if (!person?.active) throw new CommandError("账号已停用", 403);
    requireNotificationAdmin(publicAccount(person));
    const id = randomUUID();
    const notice: Notice = { type: "test", objectId: account.id, recipient: `account:${account.id}`, window: id, level: "info", report: { title: "Arbor 飞书接入测试", to: person.name, sections: [{ heading: "连接测试", lines: [{ text: "这是一条管理员主动发送的测试消息。" }] }] } };
    const mode = messageConfigured() ? "live" : "dry_run";
    await db().insert(notificationLog).values({ id, type: "test", objectId: account.id, recipient: notice.recipient, window: id, mode, payload: notice });
    try {
      const card = messageCard(notice.report);
      const sent = await messenger.send("open_id", person.feishuOpenId, card, id);
      await db().update(notificationLog).set({ status: sent.status, error: sent.error ?? null, attempts: 1, batch: { id, card }, sentAt: sent.status === "failed" ? null : new Date(), updatedAt: new Date(), messageId: sent.messageId ?? null }).where(eq(notificationLog.id, id));
      return sent;
    } catch (error) {
      const message = error instanceof Error ? error.message : "测试消息失败";
      await db().update(notificationLog).set({ status: "failed", error: message, attempts: 1, updatedAt: new Date() }).where(eq(notificationLog.id, id));
      return { status: "failed" as const, error: message };
    }
  });
  if (!outcome) throw new CommandError("调度器正在发送，请稍后再试", 409);
  return outcome;
}
export type NotificationStatus = Awaited<ReturnType<typeof notificationStatus>>;
