import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { cookieOptions, SESSION_COOKIE, sessionHash } from "@/lib/auth";
import { db } from "@/lib/db";
import { sessions } from "@/lib/db/schema";
import { apiError, checkOrigin, json } from "@/lib/http";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const jar = await cookies();
    const token = jar.get(SESSION_COOKIE)?.value;
    if (token) await db().delete(sessions).where(eq(sessions.id, sessionHash(token)));
    jar.set(SESSION_COOKIE, "", { ...cookieOptions(), maxAge: 0 });
    return json({ ok: true });
  } catch (error) { return apiError(error); }
}
