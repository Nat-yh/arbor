import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import { applyRole, isAdmin } from "../access";
import { CommandError } from "../commands";
import type { Transaction } from "../db";
import { accounts } from "../db/schema";
import { initializeRules, permissionFields, publicAccount } from "../db/state";
import type { FeishuIdentity } from "./oauth";

/** 调用方必须先拿全局写锁；避免首次并发登录产生多个引导管理员。 */
export async function loginFeishu(tx: Transaction, identity: FeishuIdentity) {
  const found = await tx.select().from(accounts).where(or(eq(accounts.feishuOpenId, identity.open_id), ...(identity.union_id ? [eq(accounts.feishuUnionId, identity.union_id)] : [])));
  if (found.length > 1) throw new CommandError("飞书身份对应多个账号，请联系管理员核对", 409);
  const row = found[0];
  if (row && !row.active) throw new CommandError("账号已停用，请联系管理员");
  if (row?.feishuUnionId && identity.union_id && row.feishuUnionId !== identity.union_id) throw new CommandError("飞书身份标识冲突，请联系管理员", 409);
  const profile = { name: identity.name, feishuOpenId: identity.open_id, feishuUnionId: identity.union_id ?? row?.feishuUnionId ?? null, avatarUrl: identity.avatar_url || row?.avatarUrl || null };
  if (row) {
    await tx.update(accounts).set(profile).where(eq(accounts.id, row.id));
    return row.id;
  }
  const all = await tx.select().from(accounts);
  const id = randomUUID();
  const firstAdmin = !all.some((a) => isAdmin(publicAccount(a)));
  const permissions = applyRole({ id, active: true, menus: [], scope: "joined", projects: [], perf: "self", canCreate: true }, firstAdmin ? "admin" : "member");
  await tx.insert(accounts).values({ id, ...profile, ...permissionFields(permissions) });
  // 正式库不写示例项目；提醒规则按缺失项补齐，不覆盖人工配置。
  await initializeRules(tx);
  return id;
}
