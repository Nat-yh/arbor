import { randomUUID } from "node:crypto";
import { canAddItemScreenshots } from "@/lib/access";
import { requireAccount } from "@/lib/auth";
import { applyCommand, CommandError } from "@/lib/commands";
import { canAccessAttachment } from "@/lib/attachments";
import { readAttachment } from "@/lib/attachment-upload";
import { loadState, persistState, withWriteLock } from "@/lib/db/state";
import { db } from "@/lib/db";
import { attachments } from "@/lib/db/schema";
import { apiError, checkOrigin, json, sessionToken } from "@/lib/http";
import { today } from "@/lib/model";
import { clientState } from "@/lib/server-state";

/** 使用原始文件请求体，避免 multipart 额外开销与 Proxy 10MB 缓冲截断。 */
export async function POST(request: Request) {
  try {
    checkOrigin(request);
    const token = await sessionToken();
    const acc = await requireAccount(token);
    const params = new URL(request.url).searchParams;
    const itemId = params.get("itemId") ?? "";
    const purpose = params.get("purpose");
    if (purpose !== null && purpose !== "item-screenshot") throw new CommandError("无效的附件用途", 400);
    const beforeRead = await db().transaction(loadState);
    if (purpose === "item-screenshot") {
      const item = beforeRead.items.find((entry) => entry.id === itemId);
      if (!item || !canAddItemScreenshots(beforeRead.items, item, acc)) throw new CommandError("你没有权限为这个需求或任务上传截图");
    } else if (!canAccessAttachment(beforeRead.items, { itemId }, acc, true)) {
      throw new CommandError("工作项不存在、无访问权限或已只读");
    }
    const { name, mime, size, content } = await readAttachment(request);
    return await withWriteLock(async (tx) => {
      const current = await requireAccount(token, tx);
      const before = await loadState(tx);
      const { state, result } = applyCommand(before, { accountId: current.id, today: today(), newId: `A${randomUUID().replaceAll("-", "")}` }, { type: "uploadAttachment", id: itemId, name, mime, size, ...(purpose ? { purpose } : {}) });
      const file = state.attachments!.find((a) => a.id === result.id)!;
      await tx.insert(attachments).values({ ...file, createdAt: new Date(file.createdAt), content });
      await persistState(tx, before, state);
      return json({ result, attachment: file, state: clientState(state, current.id) });
    });
  } catch (error) { return apiError(error); }
}
