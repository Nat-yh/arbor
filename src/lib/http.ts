import { cookies } from "next/headers";
import { CommandError, EditConflict } from "./commands";
import { SESSION_COOKIE } from "./auth";

export const sessionToken = async () => (await cookies()).get(SESSION_COOKIE)?.value;
export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });

/** 同源浏览器写入；无 Origin 的 CLI 请求仍可携带显式会话调用。 */
export function checkOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const expected = new URL(process.env.APP_BASE_URL ?? request.url).origin;
  if ((origin && origin !== expected) || request.headers.get("sec-fetch-site") === "cross-site") throw new CommandError("拒绝跨站写入");
}
export async function readJson(request: Request): Promise<unknown> {
  checkOrigin(request);
  if (!request.headers.get("content-type")?.includes("application/json")) throw new CommandError("请使用 application/json", 415);
  const body = await request.text();
  if (Buffer.byteLength(body) > 256 * 1024) throw new CommandError("请求体过大", 413);
  try { return JSON.parse(body); } catch { throw new CommandError("请求体不是有效 JSON", 400); }
}
export function apiError(error: unknown) {
  if (error instanceof EditConflict) return json({ ok: false, reason: error.message, conflicts: error.conflicts }, error.status);
  if (error instanceof CommandError) return json({ ok: false, reason: error.message }, error.status);
  console.error("Arbor API 失败", error instanceof Error ? error.name : "UnknownError");
  return json({ ok: false, reason: "服务暂时不可用，请检查数据库连接或稍后重试" }, 503);
}
