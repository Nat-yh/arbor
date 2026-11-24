import { z } from "zod";
import { cookies } from "next/headers";
import { createSession, cookieOptions, SESSION_AGE, SESSION_COOKIE } from "@/lib/auth";
import { CommandError } from "@/lib/commands";
import { demoAccounts } from "@/lib/db/seed";
import { withWriteLock } from "@/lib/db/state";
import { apiError, json, readJson } from "@/lib/http";
import { demoMode } from "@/lib/server-state";

export async function POST(request: Request) {
  try {
    if (!demoMode()) throw new CommandError("演示登录未启用", 404);
    const body = z.object({ id: z.string().min(1).max(150) }).strict().safeParse(await readJson(request));
    if (!body.success) throw new CommandError("请选择身份", 400);
    const jar = await cookies();
    const session = await withWriteLock(async (tx) => {
      const accounts = await demoAccounts(tx);
      const acc = accounts.find((a) => a.id === body.data.id && a.active);
      if (!acc) throw new CommandError("账号不存在或已停用");
      return createSession(tx, acc.id, jar.get(SESSION_COOKIE)?.value);
    });
    jar.set(SESSION_COOKIE, session.token, { ...cookieOptions(), maxAge: SESSION_AGE, expires: session.expires });
    return json({ ok: true });
  } catch (error) { return apiError(error); }
}
