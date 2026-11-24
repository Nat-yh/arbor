import { sql } from "drizzle-orm";
import { demoEnabled, isDemoIdentity } from "../auth-config";
import { demoState } from "../demo";
import { CommandError } from "../commands";
import { db, type Transaction } from "./index";
import { permissionFields, persistState } from "./state";
import * as tables from "./schema";

export async function demoAccounts(tx?: Transaction) {
  if (!demoEnabled()) throw new CommandError("演示模式未启用", 404);
  const rows = await (tx ?? db()).select({
    id: tables.accounts.id,
    name: tables.accounts.name,
    active: tables.accounts.active,
    feishuOpenId: tables.accounts.feishuOpenId,
    feishuUnionId: tables.accounts.feishuUnionId,
  }).from(tables.accounts);
  if (rows.some((row) => row.feishuOpenId || row.feishuUnionId)) {
    throw new CommandError("数据库含飞书账号，禁止使用演示模式");
  }
  if (rows.some((row) => !isDemoIdentity(row.id))) {
    throw new CommandError("数据库含正式账号，禁止使用演示模式");
  }
  return rows;
}

export async function seedDemo(tx: Transaction, reset = false, date?: string) {
  const existing = await demoAccounts(tx);
  if (!reset && existing.length) throw new CommandError("数据库非空，种子命令不会覆盖已有数据");
  if (reset) {
    await tx.delete(tables.attachments);
    await tx.delete(tables.activityLog);
    await tx.delete(tables.sessions);
    await tx.delete(tables.repoEvents);
    await tx.execute(sql`delete from work_items`);
    await tx.delete(tables.rules);
    await tx.delete(tables.accounts);
    await tx.delete(tables.roleTemplates);
  }
  const state = demoState(date);
  for (const p of state.people) {
    const a = state.accounts.find((a) => a.id === p.id)!;
    await tx.insert(tables.accounts).values({ id: p.id, name: p.name, title: p.title, kind: p.kind, ...permissionFields(a) });
  }
  await persistState(tx, { items: [], accounts: state.accounts, rules: [], repoEvents: [], people: [] }, state);
  return state;
}
