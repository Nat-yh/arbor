import { randomBytes, randomUUID, scrypt } from "node:crypto";
import { and, eq, gt, lte } from "drizzle-orm";
import { z } from "zod";
import { applyRole, isAdmin } from "./access";
import { createSession, requireAccount, safeEqual, sessionHash } from "./auth";
import { accountCodePattern, localAuthEnabled } from "./auth-config";
import { CommandError } from "./commands";
import { db, type Transaction } from "./db";
import { accounts, localCredentials, memberInvitations } from "./db/schema";
import { initializeRules, permissionFields, publicAccount, withWriteLock } from "./db/state";

const username = z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_.-]{2,63}$/);
export const localLoginInput = z.object({ username, password: z.string().min(1).max(128) }).strict();
export const localRegistrationInput = localLoginInput.extend({
  password: z.string().min(12).max(128),
  name: z.string().trim().min(1).max(80),
  code: z.string().trim().toLowerCase().regex(accountCodePattern),
});

const maxAttempts = 5;
const cooldownMs = 15 * 60 * 1000;
const invitationAgeMs = 48 * 60 * 60 * 1000;
const passwordError = () => new CommandError("用户名或密码错误，或暂时无法登录", 401);

export function requireLocalAuth() {
  if (!localAuthEnabled()) throw new CommandError("本地账号登录未启用", 404);
}

function derivePassword(password: string, salt: string) {
  return new Promise<string>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key.toString("hex"));
    });
  });
}

export async function issueMemberInvitation(sessionToken?: string) {
  return withWriteLock(async (tx) => {
    const account = await requireAccount(sessionToken, tx);
    if (!isAdmin(account)) throw new CommandError("只有管理员可以邀请成员", 403);
    const now = Date.now();
    const code = randomBytes(32).toString("hex");
    const expiresAt = new Date(now + invitationAgeMs);
    await tx.delete(memberInvitations).where(lte(memberInvitations.expiresAt, new Date(now)));
    await tx.insert(memberInvitations).values({ tokenHash: sessionHash(code), issuedBy: account.id, expiresAt });
    return { code, expiresAt: expiresAt.toISOString() };
  });
}

async function registrationRole(tx: Transaction, code: string) {
  const setupToken = process.env.LOCAL_AUTH_SETUP_TOKEN ?? "";
  if (accountCodePattern.test(setupToken) && safeEqual(setupToken, code)) {
    const [existing] = await tx.select({ id: accounts.id }).from(accounts).limit(1);
    if (existing) throw new CommandError("管理员初始化已关闭", 409);
    return "admin";
  }
  const [row] = await tx.select({ issuer: accounts }).from(memberInvitations)
    .innerJoin(accounts, eq(accounts.id, memberInvitations.issuedBy))
    .where(and(eq(memberInvitations.tokenHash, sessionHash(code)), gt(memberInvitations.expiresAt, new Date()), eq(accounts.active, true)));
  if (!row || !isAdmin(publicAccount(row.issuer))) throw new CommandError("邀请码无效、已使用或已过期", 400);
  return "member";
}

export async function registerLocal(input: z.infer<typeof localRegistrationInput>, oldToken?: string) {
  // 校验凭据后才执行耗时的密码派生，事务内再次校验以处理并发兑换和飞书首次登录。
  await db().transaction((tx) => registrationRole(tx, input.code));
  const salt = randomBytes(16).toString("hex");
  const passwordHash = `${salt}:${await derivePassword(input.password, salt)}`;
  return withWriteLock(async (tx) => {
    const role = await registrationRole(tx, input.code);
    const [existing] = await tx.select({ accountId: localCredentials.accountId }).from(localCredentials)
      .where(eq(localCredentials.username, input.username));
    if (existing) throw new CommandError("用户名已被使用", 409);
    const id = randomUUID();
    const permission = applyRole({ id, active: true, menus: [], scope: "joined", projects: [], perf: "self", canCreate: true }, role);
    await tx.insert(accounts).values({ id, name: input.name, ...permissionFields(permission) });
    await tx.insert(localCredentials).values({ accountId: id, username: input.username, passwordHash });
    if (role === "member") await tx.delete(memberInvitations).where(eq(memberInvitations.tokenHash, sessionHash(input.code)));
    await initializeRules(tx);
    return createSession(tx, id, oldToken);
  });
}

export async function loginLocal(input: z.infer<typeof localLoginInput>, oldToken?: string) {
  const credential = await db().transaction(async (tx) => {
    const [row] = await tx.select({ credential: localCredentials }).from(localCredentials)
      .innerJoin(accounts, eq(accounts.id, localCredentials.accountId))
      .where(and(eq(localCredentials.username, input.username), eq(accounts.active, true)))
      .for("update", { of: localCredentials });
    if (!row) return null;
    const now = Date.now();
    const current = row.credential;
    const inWindow = !!current.retryAfter && current.retryAfter.getTime() > now;
    if (inWindow && current.attempts >= maxAttempts) return null;
    await tx.update(localCredentials).set({
      attempts: inWindow ? current.attempts + 1 : 1,
      retryAfter: inWindow ? current.retryAfter : new Date(now + cooldownMs),
    }).where(eq(localCredentials.accountId, current.accountId));
    return current;
  });
  if (!credential) throw passwordError();
  const [salt, hash] = credential.passwordHash.split(":");
  if (!safeEqual(await derivePassword(input.password, salt), hash)) throw passwordError();
  return withWriteLock(async (tx) => {
    const [account] = await tx.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.id, credential.accountId), eq(accounts.active, true)));
    if (!account) throw passwordError();
    await tx.update(localCredentials).set({ attempts: 0, retryAfter: null })
      .where(eq(localCredentials.accountId, account.id));
    return createSession(tx, account.id, oldToken);
  });
}
