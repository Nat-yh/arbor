import { cookies } from "next/headers";
import { createSession, cookieOptions, requireAccount, SESSION_AGE, SESSION_COOKIE } from "@/lib/auth";
import { CommandError } from "@/lib/commands";
import { seedDemo } from "@/lib/db/seed";
import { withWriteLock } from "@/lib/db/state";
import { apiError, checkOrigin, json, sessionToken } from "@/lib/http";
import { clientState, demoMode } from "@/lib/server-state";

export async function POST(request: Request) {
  try {
    if (!demoMode()) throw new CommandError("演示重置未启用", 404);
    checkOrigin(request);
    const token = await sessionToken();
    await requireAccount(token);
    const { session, state } = await withWriteLock(async (tx) => {
      await requireAccount(token, tx);
      const state = await seedDemo(tx, true);
      const session = await createSession(tx, "linyue");
      return { session, state: clientState(state, "linyue") };
    });
    (await cookies()).set(SESSION_COOKIE, session.token, { ...cookieOptions(), maxAge: SESSION_AGE, expires: session.expires });
    return json({ state, result: { ok: true } });
  } catch (error) { return apiError(error); }
}
