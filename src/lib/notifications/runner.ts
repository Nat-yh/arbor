import { randomUUID } from "node:crypto";
import { and, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { accounts, notificationLog } from "../db/schema";
import { loadState } from "../db/state";
import { messageCard, messageConfigured, messenger } from "../feishu/messages";
import { addCoverage, localTime, maySend, mergeNotices, noticeKey, planNotifications, planRiskNotices, type Notice } from "./plan";

import { validDefectNotice } from "./defect";
import { validHandoff } from "./handoff";
import { validMention } from "./mention";
import { dateOffset, daysBetween } from "../model";

export const NOTIFY_LOCK = 73026112;
export type RunSummary = { locked: boolean; queued: number; sent: number; failed: number; dry_run: number; cancelled: number };
/** session advisory lock 必须绑定同一条保留连接，释放前不归还连接池。 */
export async function withNotificationLock<T>(work: () => Promise<T>): Promise<T | null> {
  const connection = await db().$client.reserve();
  let locked = false;
  try {
    const [row] = await connection`select pg_try_advisory_lock(${NOTIFY_LOCK}) as locked`;
    locked = row.locked;
    return locked ? await work() : null;
  } finally {
    try { if (locked) await connection`select pg_advisory_unlock(${NOTIFY_LOCK})`; }
    finally { connection.release(); }
  }
}
const directNotice = (type: Notice["type"]) => type === "mention" || type === "defect";

export async function runNotifications(options: { now?: Date; dryRun?: boolean; directOnly?: boolean } = {}): Promise<RunSummary> {
  const now = options.now ?? new Date();
  const mode = options.dryRun || !messageConfigured() ? "dry_run" : "live";
  const summary: RunSummary = { locked: false, queued: 0, sent: 0, failed: 0, dry_run: 0, cancelled: 0 };
  const result = await withNotificationLock(async () => {
    summary.locked = true;
    const date = localTime(now).date;
    const directOnly = options.directOnly === true;
    const typeFilter = directOnly
      ? inArray(notificationLog.type, ["mention", "defect"])
      : inArray(notificationLog.type, ["handoff", "mention", "defect", "event", "daily", "weekly"]);
    // 即时私聊走短周期，发送失败由常规调度重试。
    const statusFilter = directOnly ? eq(notificationLog.status, "pending") : inArray(notificationLog.status, ["pending", "failed"]);
    const pendingFilter = and(eq(notificationLog.mode, mode), typeFilter, statusFilter);
    const snapshot = await db().transaction(async (tx) => {
      const pending = await tx.select().from(notificationLog).where(pendingFilter).orderBy(notificationLog.createdAt, notificationLog.id);
      if (directOnly && !pending.length) return null;
      const state = await loadState(tx);
      const deliveredToday = directOnly ? [] : await tx.select().from(notificationLog).where(and(
        eq(notificationLog.mode, mode), inArray(notificationLog.status, ["sent", "dry_run"]),
        gt(notificationLog.sentAt, new Date(now.getTime() - 86400000)),
      ));
      return { state, pending, deliveredToday };
    }, { isolationLevel: "repeatable read", accessMode: "read only" });
    if (!snapshot) return summary;
    const { state, pending, deliveredToday } = snapshot;
    const planned = directOnly ? [] : await planScheduledNotices(state, pending, deliveredToday, mode, now, date);
    const current = new Map(planned.map((n) => [windowKey(n), n]));
    for (const row of pending) {
      if (!directNotice(row.type) || (row.payload.expires && date > row.payload.expires)) continue;
      const notice = row.type === "defect" ? validDefectNotice(state, row.payload) : validMention(state, row.payload);
      if (notice) current.set(windowKey(notice), notice);
    }
    const queued = new Set(pending.map(windowKey));
    const recent = new Set(deliveredToday.map(windowKey));
    for (const notice of planned) {
      if (notice.type === "handoff" || queued.has(windowKey(notice)) || recent.has(windowKey(notice))) continue;
      const rows = await db().insert(notificationLog).values({ id: randomUUID(), ...identity(notice), mode, payload: notice, createdAt: now, updatedAt: now }).onConflictDoUpdate({
        target: [notificationLog.type, notificationLog.objectId, notificationLog.recipient, notificationLog.window, notificationLog.mode],
        set: { status: "pending", payload: notice, error: null, updatedAt: now },
        setWhere: and(eq(notificationLog.status, "cancelled"), isNull(notificationLog.sentAt)),
      }).returning();
      pending.push(...rows);
      summary.queued += rows.length;
    }
    const ready: typeof pending = [];
    for (const row of pending) {
      const notice = current.get(windowKey(row));
      if (!notice) {
        await db().update(notificationLog).set({ status: "cancelled", error: "规则关闭、接收范围改变、事项已解决或发送时段已结束", updatedAt: now }).where(eq(notificationLog.id, row.id));
        summary.cancelled++;
      } else if (directNotice(notice.type) || maySend(notice.level, now)) ready.push({ ...row, payload: notice });
    }
    const batches = Map.groupBy(ready, (row) =>
      row.type === "defect" ? row.id : `${row.type === "mention" ? "mention" : "scheduled"}:${row.recipient}`);
    for (const rows of batches.values()) {
      const recipient = rows[0].recipient;
      // 失败批次沿用原卡片/uuid；本轮新增先等待，避免同一接收人在同一轮多张卡片。
      const oldBatch = rows.find((r) => r.batch)?.batch;
      const batchRows = oldBatch ? rows.filter((r) => r.batch?.id === oldBatch.id) : rows;
      // 长轮次可能跨越20:00，真正发送前再次检查当前时间；测试/演练可显式固定时间。
      const sendingTime = options.now ?? new Date();
      if (!batchRows.every((r) => directNotice(r.type) || maySend(r.payload.level, sendingTime))) continue;
      try {
        const card = messageCard(mergeNotices(batchRows.map((r) => r.payload)), batchRows[0].payload.itemId);
        // 周末等级筛选、规则关闭或事项更新可能改变批次内容，不能重发旧卡片里已失效的事项。
        const reusable = oldBatch && JSON.stringify(oldBatch.card) === JSON.stringify(card);
        const batch = reusable ? oldBatch : { id: directNotice(batchRows[0].type) && oldBatch ? oldBatch.id : randomUUID(), card };
        const ids = batchRows.map((r) => r.id);
        await db().transaction(async (tx) => {
          for (const row of batchRows) await tx.update(notificationLog).set({ batch, payload: row.payload, attempts: sql`${notificationLog.attempts} + 1`, updatedAt: now }).where(eq(notificationLog.id, row.id));
        });
        const target = recipient.startsWith("chat:") ? recipient.slice(5) : (await db().select().from(accounts).where(eq(accounts.id, recipient.slice(8))))[0]?.feishuOpenId ?? null;
        const outcome = await messenger.send(recipient.startsWith("chat:") ? "chat_id" : "open_id", target, batch.card, batch.id, mode === "dry_run");
        await db().update(notificationLog).set({ status: outcome.status, error: outcome.error ?? null, messageId: outcome.messageId ?? null, sentAt: outcome.status === "failed" ? null : now, updatedAt: now }).where(inArray(notificationLog.id, ids));
        summary[outcome.status] += ids.length;
      } catch (error) {
        // 单个接收人失败不影响其他接收人；数据库整体断开由调度器捕获并下轮重试。
        const message = error instanceof Error ? error.message : "发送异常";
        console.error("Arbor 通知批次失败", message);
        await db().update(notificationLog).set({ status: "failed", error: message.slice(0, 1000), updatedAt: now }).where(inArray(notificationLog.id, batchRows.map((r) => r.id)));
        summary.failed += batchRows.length;
      }
    }
    return summary;
  });
  return result ?? summary;
}
async function planScheduledNotices(
  state: Awaited<ReturnType<typeof loadState>>,
  pending: (typeof notificationLog.$inferSelect)[],
  deliveredToday: (typeof notificationLog.$inferSelect)[],
  mode: "live" | "dry_run",
  now: Date,
  date: string,
) {
  const risks = planRiskNotices(state, now);
  const windows = [...new Set(risks.map((n) => n.window))];
  const deliveredRiskKeys = new Set(windows.length ? (await db().select().from(notificationLog).where(and(
    eq(notificationLog.mode, mode), eq(notificationLog.type, "event"),
    inArray(notificationLog.status, ["sent", "dry_run"]), inArray(notificationLog.window, windows),
  ))).map((row) => windowKey(row)) : []);
  // 旧版本用五分钟时间桶。已发过且仍属于同一风险的记录继续参与去重。
  const legacy = await legacyDeliveries(risks, mode, state.rules.find((rule) => rule.id === "overdue")?.n ?? 2);
  const handoffs = new Map<string, Notice>();
  for (const row of pending) {
    if (row.type !== "handoff" || (row.payload.expires && date > row.payload.expires)) continue;
    const notice = validHandoff(state, row.payload, date);
    if (notice) {
      const key = noticeKey(notice);
      const previous = handoffs.get(key);
      if (previous?.handoff?.kind === "assign" && notice.handoff?.kind === "assign") {
        const roles = [...new Set([...previous.handoff.roles, ...notice.handoff.roles])];
        notice.handoff.roles = roles;
        handoffs.set(key, validHandoff(state, notice, date)!);
      } else handoffs.set(key, notice);
    }
  }
  const actionable = [...handoffs.values(), ...risks.filter((n) => !deliveredRiskKeys.has(windowKey(n)) && !legacy.has(windowKey(n)))];
  const covered = new Map<string, Set<string>>();
  for (const row of deliveredToday) if (row.sentAt && localTime(row.sentAt).date === date) addCoverage(covered, row.payload);
  return planNotifications(state, now, { actionable, covered });
}

function identity(n: Notice) { return { type: n.type, objectId: n.objectId, recipient: n.recipient, window: n.window }; }

function windowKey(notice: Pick<Notice, "type" | "objectId" | "recipient" | "window">) {
  return JSON.stringify([noticeKey(notice), notice.window]);
}

async function legacyDeliveries(notices: Notice[], mode: "live" | "dry_run", escalationDays: number) {
  const since = (notice: Notice) => {
    if (!/^\d{4}-\d{2}-\d{2}/.test(notice.window)) return undefined;
    const date = notice.window.slice(0, 10);
    if (notice.objectId.startsWith("overdue_escalated:")) return dateOffset(date, Math.max(1, Math.ceil(escalationDays)));
    if (notice.objectId.startsWith("overdue:")) return dateOffset(date, 1);
    return date;
  };
  const candidates = notices.flatMap((notice) => {
    const start = since(notice);
    if (!start) return [];
    return [{ notice, start, legacyId: notice.objectId.replace(/^overdue_escalated:/, "overdue:") }];
  });
  if (!candidates.length) return new Set<string>();
  const oldest = candidates.map(({ start }) => start).sort()[0];
  const ids = [...new Set(candidates.map(({ legacyId }) => legacyId))];
  const delivered = await db().select({ objectId: notificationLog.objectId, recipient: notificationLog.recipient, sentAt: notificationLog.sentAt })
    .from(notificationLog).where(and(
      eq(notificationLog.mode, mode), eq(notificationLog.type, "event"),
      inArray(notificationLog.status, ["sent", "dry_run"]), inArray(notificationLog.objectId, ids),
      gte(notificationLog.sentAt, new Date(`${dateOffset(oldest, -1)}T00:00:00Z`)),
      sql`${notificationLog.window} ~ '^[0-9]+$'`,
    ));
  const byRecipient = new Map<string, Date>();
  for (const row of delivered) {
    if (!row.sentAt) continue;
    const key = JSON.stringify([row.objectId, row.recipient]);
    const latest = byRecipient.get(key);
    if (!latest || row.sentAt > latest) byRecipient.set(key, row.sentAt);
  }
  const result = new Set<string>();
  for (const { notice, start, legacyId } of candidates) {
    const sentAt = byRecipient.get(JSON.stringify([legacyId, notice.recipient]));
    if (!sentAt) continue;
    if (notice.window.includes("T") && sentAt < new Date(notice.window)) continue;
    if (daysBetween(start, localTime(sentAt).date) >= 0) result.add(windowKey(notice));
  }
  return result;
}
