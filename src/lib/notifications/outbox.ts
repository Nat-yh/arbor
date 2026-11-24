import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Transaction } from "../db";
import { notificationLog } from "../db/schema";
import { messageConfigured } from "../feishu/messages";
import type { AppState } from "../state";
import { defectNotice } from "./defect";
import type { Notice } from "./plan";
import { collectHandoffs } from "./handoff";
import { mentionNotices } from "./mention";

async function insertNotices(tx: Transaction, notices: Notice[], now: Date) {
  if (!notices.length) return;
  const mode: "live" | "dry_run" = messageConfigured() ? "live" : "dry_run";
  await tx.insert(notificationLog).values(notices.map((payload) => ({
    id: randomUUID(), type: payload.type, objectId: payload.objectId, recipient: payload.recipient,
    window: payload.window, mode, payload, createdAt: now, updatedAt: now,
  }))).onConflictDoNothing();
}

export function persistHandoffs(tx: Transaction, before: AppState, after: AppState, event: Parameters<typeof collectHandoffs>[2], now: Date) {
  return insertNotices(tx, collectHandoffs(before, after, event, now), now);
}

export function persistDefectNotice(tx: Transaction, before: AppState, after: AppState, itemId: string, defectId: string, now: Date) {
  if (before.items.find(({ id }) => id === itemId)?.defects.some(({ id }) => id === defectId)) return;
  const notice = defectNotice(after, itemId, defectId, now);
  if (notice) return insertNotices(tx, [notice], now);
}

export async function persistMentions(tx: Transaction, before: AppState, after: AppState, itemId: string, updateId: string, now: Date) {
  const item = after.items.find(({ id }) => id === itemId);
  if (!item) return;
  const notices = mentionNotices(before.items.find(({ id }) => id === itemId), item, updateId, now);
  if (!notices.length) return;
  const mode = messageConfigured() ? "live" : "dry_run";
  for (const payload of notices) {
    await tx.insert(notificationLog).values({
      id: randomUUID(), type: payload.type, objectId: payload.objectId, recipient: payload.recipient,
      window: payload.window, mode, payload, createdAt: now, updatedAt: now,
    }).onConflictDoUpdate({
      target: [notificationLog.type, notificationLog.objectId, notificationLog.recipient, notificationLog.window, notificationLog.mode],
      set: { status: "pending", payload, error: null, batch: null, updatedAt: now },
      setWhere: and(eq(notificationLog.status, "cancelled"), isNull(notificationLog.sentAt)),
    });
  }
}
