import { NextResponse, type NextRequest } from "next/server";
import { sessionAccount, SESSION_COOKIE } from "./lib/auth";
import { canUseTeam } from "./lib/access";
import { db } from "./lib/db";
import { workItems } from "./lib/db/schema";
import { and, eq, sql } from "drizzle-orm";

const publicPath = (p: string) => p === "/login" || p.startsWith("/api/auth/") || /^\/api\/webhooks\/(gitea|github|gitlab|gitee)$/.test(p) || p === "/api/health";
const routeMenu = (p: string) => p.startsWith("/settings") ? "settings" : p.startsWith("/performance") ? "performance" : p.startsWith("/quality") ? "quality" : p.startsWith("/alerts") ? "alerts" : /^\/(projects|item|new)(\/|$)/.test(p) ? "projects" : undefined;

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (publicPath(path) || (!path.startsWith("/api/") && /\.(?:svg|png|jpg|jpeg|webp|avif|gif|ico|woff2?|ttf|css|js|map)$/.test(path))) return NextResponse.next();
  const noStore = { "Cache-Control": "private, no-store" };
  try {
    const acc = await sessionAccount(request.cookies.get(SESSION_COOKIE)?.value);
    if (!acc) return path.startsWith("/api/")
      ? NextResponse.json({ ok: false, reason: "请先登录" }, { status: 401, headers: noStore })
      : NextResponse.redirect(new URL("/login", request.url));
    const menu = routeMenu(path);
    if (/^\/team(\/|$)/.test(path)) {
      const allowed = canUseTeam([], acc) || (!acc.menus.includes("team:off") && acc.menus.includes("projects") && (await db().select({ id: workItems.id }).from(workItems).where(and(eq(workItems.kind, "project"), sql`${workItems.data}->>'owner' = ${acc.id}`)).limit(1)).length > 0);
      if (!allowed) return new NextResponse("没有此页面的访问权限", { status: 403, headers: noStore });
    }
    if (menu && !acc.menus.includes(menu)) return new NextResponse("没有此页面的访问权限", { status: 403, headers: { ...noStore, "Content-Type": "text/plain; charset=utf-8" } });
    return NextResponse.next();
  } catch {
    return NextResponse.json({ ok: false, reason: "数据库暂不可用" }, { status: 503, headers: noStore });
  }
}
export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.svg|apple-icon.png|brand/|robots.txt|sitemap.xml).*)"] };
