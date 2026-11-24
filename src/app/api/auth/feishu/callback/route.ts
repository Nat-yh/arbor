import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieOptions, createSession, safeEqual, SESSION_AGE, SESSION_COOKIE } from "@/lib/auth";
import { CommandError } from "@/lib/commands";
import { withWriteLock } from "@/lib/db/state";
import { loginFeishu } from "@/lib/feishu/account";
import { exchangeCode } from "@/lib/feishu/oauth";

export async function GET(request: Request) {
  const jar = await cookies();
  const state = jar.get("arbor_oauth_state")?.value;
  jar.set("arbor_oauth_state", "", { ...cookieOptions(), maxAge: 0 });
  const url = new URL(request.url);
  try {
    const supplied = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    if (!state || !supplied || !safeEqual(state, supplied) || !code) throw new CommandError("登录请求已过期或校验失败，请重新登录", 400);
    const identity = await exchangeCode(code);
    const session = await withWriteLock(async (tx) => {
      const id = await loginFeishu(tx, identity);
      return createSession(tx, id, jar.get(SESSION_COOKIE)?.value);
    });
    jar.set(SESSION_COOKIE, session.token, { ...cookieOptions(), expires: session.expires, maxAge: SESSION_AGE });
    return NextResponse.redirect(new URL("/", process.env.APP_BASE_URL!), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const target = new URL("/login", process.env.APP_BASE_URL ?? request.url);
    target.searchParams.set("error", error instanceof CommandError ? error.message : "飞书登录失败，请稍后重试");
    return NextResponse.redirect(target, { headers: { "Cache-Control": "no-store" } });
  }
}
