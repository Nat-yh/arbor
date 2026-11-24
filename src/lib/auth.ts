import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { db, type Transaction } from "./db";
import { accounts, sessions } from "./db/schema";
import { publicAccount } from "./db/state";
import { CommandError } from "./commands";

export const SESSION_COOKIE = "arbor_session";
export const SESSION_AGE = 30 * 24 * 60 * 60;
export const cookieOptions = () => ({ httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/" });
export const sessionHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a); const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export async function sessionAccount(token?: string, tx?: Transaction) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const database = tx ?? db();
  const [row] = await database.select({ account: accounts }).from(sessions).innerJoin(accounts, eq(sessions.accountId, accounts.id)).where(and(eq(sessions.id, sessionHash(token)), gt(sessions.expiresAt, new Date()), eq(accounts.active, true))).limit(1);
  return row ? publicAccount(row.account) : null;
}

export async function createSession(tx: Transaction, accountId: string, oldToken?: string) {
  const token = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_AGE * 1000);
  await tx.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  if (oldToken) await tx.delete(sessions).where(eq(sessions.id, sessionHash(oldToken)));
  await tx.insert(sessions).values({ id: sessionHash(token), accountId, expiresAt: expires });
  return { token, expires };
}
export async function requireAccount(token?: string, tx?: Transaction) {
  const acc = await sessionAccount(token, tx);
  if (!acc) throw new CommandError("请先登录，或账号已停用", 401);
  return acc;
}
