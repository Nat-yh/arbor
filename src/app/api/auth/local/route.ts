import { cookies } from "next/headers";
import { z } from "zod";
import { cookieOptions, SESSION_AGE, SESSION_COOKIE } from "@/lib/auth";
import { apiError, json, readJson } from "@/lib/http";
import { localLoginInput, localRegistrationInput, loginLocal, registerLocal, requireLocalAuth } from "@/lib/local-auth";

const input = z.discriminatedUnion("action", [
  localLoginInput.extend({ action: z.literal("login") }),
  localRegistrationInput.extend({ action: z.literal("register") }),
]);

export async function POST(request: Request) {
  try {
    requireLocalAuth();
    const parsed = input.safeParse(await readJson(request));
    if (!parsed.success) return json({ reason: "请检查填写内容的格式" }, 400);
    const jar = await cookies();
    const oldToken = jar.get(SESSION_COOKIE)?.value;
    const session = parsed.data.action === "login"
      ? await loginLocal(parsed.data, oldToken)
      : await registerLocal(parsed.data, oldToken);
    jar.set(SESSION_COOKIE, session.token, { ...cookieOptions(), maxAge: SESSION_AGE, expires: session.expires });
    return json({ ok: true });
  } catch (error) { return apiError(error); }
}
