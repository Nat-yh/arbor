import { randomUUID } from "node:crypto";
import { lt } from "drizzle-orm";
import { readAttachment } from "@/lib/attachment-upload";
import { requireAccount } from "@/lib/auth";
import { CommandError } from "@/lib/commands";
import { draftScreenshots } from "@/lib/db/schema";
import { withWriteLock } from "@/lib/db/state";
import { apiError, checkOrigin, json, sessionToken } from "@/lib/http";

export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const token = await sessionToken();
    if (!(await requireAccount(token)).menus.includes("projects")) throw new CommandError("没有上传截图的权限");
    const file = await readAttachment(request);
    if (!file.mime.startsWith("image/")) throw new CommandError("请选择图片作为截图", 400);
    return await withWriteLock(async (tx) => {
      const account = await requireAccount(token, tx);
      if (!account.menus.includes("projects")) throw new CommandError("没有上传截图的权限");
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
      const id = `D${randomUUID().replaceAll("-", "").toUpperCase()}`;
      await tx.delete(draftScreenshots).where(lt(draftScreenshots.expiresAt, now));
      await tx.insert(draftScreenshots).values({ ...file, id, uploadedBy: account.id, expiresAt });
      return json({ result: { ok: true, id, expiresAt: expiresAt.toISOString() } });
    });
  } catch (error) { return apiError(error); }
}
