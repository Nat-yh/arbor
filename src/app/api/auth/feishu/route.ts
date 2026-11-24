import { randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { cookieOptions } from "@/lib/auth";
import { authorizationUrl } from "@/lib/feishu/oauth";
import { apiError } from "@/lib/http";

export async function GET() {
  try {
    const state = randomBytes(32).toString("hex");
    const target = authorizationUrl(state);
    (await cookies()).set("arbor_oauth_state", state, { ...cookieOptions(), maxAge: 600 });
    return NextResponse.redirect(target, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiError(error); }
}
