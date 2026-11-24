import { eq, sql } from "drizzle-orm";
import { isAdmin, type Account } from "../access";
import { currentRules, DEFAULT_RULES } from "../alerts";
import { isPublishing, setPeople, type Person } from "../model";
import type { AppState } from "../state";
import { db, type Transaction } from "./index";
import * as tables from "./schema";

export const permissionFields = (a: Account) => ({ active: a.active, menus: a.menus, scope: a.scope, projects: a.projects, perf: a.perf, canCreate: a.canCreate, gitee: a.gitee ?? null, repoLogins: a.repoLogins ?? {} });
export function publicAccount(row: typeof tables.accounts.$inferSelect): Account {
  const { id, gitee, roleTemplateId, ...rest } = row;
  return { id, ...permissionFields({ ...rest, id, gitee: gitee ?? undefined }), gitee: gitee ?? undefined, roleTemplateId: roleTemplateId ?? undefined };
}
export function publicPerson(row: typeof tables.accounts.$inferSelect): Person {
  return { id: row.id, name: row.name, title: row.title, kind: row.kind, active: row.active, avatarUrl: row.avatarUrl?.startsWith("https://") ? row.avatarUrl : undefined, role: isAdmin(publicAccount(row)) ? "admin" : "member" };
}

export async function loadState(tx: Transaction): Promise<AppState> {
  const [a, w, r, e, activities, files, templates] = await Promise.all([tx.select().from(tables.accounts), tx.select().from(tables.workItems), tx.select().from(tables.rules), tx.select().from(tables.repoEvents).orderBy(sql`${tables.repoEvents.receivedAt} desc`, tables.repoEvents.id), tx.select().from(tables.activityLog), tx.select({ id: tables.attachments.id, itemId: tables.attachments.itemId, uploadedBy: tables.attachments.uploadedBy, name: tables.attachments.name, mime: tables.attachments.mime, size: tables.attachments.size, createdAt: tables.attachments.createdAt }).from(tables.attachments), tx.select().from(tables.roleTemplates).orderBy(tables.roleTemplates.name, tables.roleTemplates.id)]);
  const people = a.map(publicPerson);
  setPeople(people);
  return {
    attachments: files.map((f) => ({ ...f, createdAt: f.createdAt.toISOString() })),
    accounts: a.map(publicAccount), roleTemplates: templates, people, activities: activities.map((x) => x.data),
    items: w.map(({ data, id, parentId, kind }) => {
      const { productionStage, ...item } = data;
      const status = item.status === "review" && productionStage ? productionStage : item.status;
      return { ...item, status, id, parentId, kind };
    }),
    rules: currentRules(r.map((x) => x.data)), repoEvents: e.map((x) => x.data),
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export async function persistState(tx: Transaction, before: AppState, after: AppState) {
  for (const x of after.items) {
    const prev = before.items.find((p) => p.id === x.id);
    if (same(prev, x)) continue;
    const { id, parentId, kind, ...item } = x;
    // 旧应用回滚时仍能读取待发布、待线上验收的记录。
    const data = isPublishing(item.status)
      ? { ...item, productionStage: item.status, status: "review" as const }
      : item;
    if (!prev) await tx.insert(tables.workItems).values({ id, parentId, kind, data });
    else await tx.update(tables.workItems).set({ parentId, kind, data, version: sql`${tables.workItems.version} + 1`, updatedAt: new Date() }).where(eq(tables.workItems.id, id));
  }
  for (const x of before.items) if (!after.items.some((i) => i.id === x.id)) await tx.delete(tables.workItems).where(eq(tables.workItems.id, x.id));
  for (const a of after.activities ?? []) if (!(before.activities ?? []).some((p) => p.id === a.id)) await tx.insert(tables.activityLog).values({ id: a.id, data: a });
  for (const template of after.roleTemplates ?? []) {
    const previous = before.roleTemplates?.find((role) => role.id === template.id);
    if (same(previous, template)) continue;
    if (!previous) await tx.insert(tables.roleTemplates).values(template);
    else await tx.update(tables.roleTemplates).set(template).where(eq(tables.roleTemplates.id, template.id));
  }
  for (const a of after.accounts) if (!same(before.accounts.find((p) => p.id === a.id), a)) {
    // 通用命令永远不能写飞书标识、姓名和其他身份字段。
    await tx.update(tables.accounts).set({ ...permissionFields(a), roleTemplateId: a.roleTemplateId ?? null }).where(eq(tables.accounts.id, a.id));
  }
  for (const template of before.roleTemplates ?? []) {
    if (!after.roleTemplates?.some((role) => role.id === template.id)) {
      await tx.delete(tables.roleTemplates).where(eq(tables.roleTemplates.id, template.id));
    }
  }
  for (const r of after.rules) if (!same(before.rules.find((p) => p.id === r.id), r)) {
    await tx.insert(tables.rules).values({ id: r.id, data: r }).onConflictDoUpdate({ target: tables.rules.id, set: { data: r } });
  }
  for (const e of after.repoEvents) if (!same(before.repoEvents.find((p) => p.id === e.id), e)) {
    await tx.insert(tables.repoEvents).values({ id: e.id, data: e, receivedAt: new Date(e.receivedAt) }).onConflictDoUpdate({ target: tables.repoEvents.id, set: { data: e } });
  }
}

/** 所有业务写入（命令、Webhook、首次登录、重置）共享同一把事务行锁。 */
export function withWriteLock<T>(fn: (tx: Transaction) => Promise<T>) {
  return db().transaction(async (tx) => {
    await tx.insert(tables.appMeta).values({ id: 1 }).onConflictDoNothing();
    await tx.execute(sql`select id from app_meta where id = 1 for update`);
    return fn(tx);
  });
}

export async function initializeRules(tx: Transaction) {
  for (const rule of DEFAULT_RULES) {
    await tx.insert(tables.rules).values({ id: rule.id, data: rule }).onConflictDoNothing();
  }
}
