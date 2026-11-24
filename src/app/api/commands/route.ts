import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray } from "drizzle-orm";
import { canAddItemScreenshots, canSee } from "@/lib/access";
import { attachments, draftScreenshots } from "@/lib/db/schema";
import { requireAccount } from "@/lib/auth";
import { applyCommand, commandSchema, CommandError } from "@/lib/commands";
import { loadState, persistState, withWriteLock } from "@/lib/db/state";
import { apiError, json, readJson, sessionToken } from "@/lib/http";
import { persistDefectNotice, persistHandoffs, persistMentions } from "@/lib/notifications/outbox";
import { MAX_ITEM_SCREENSHOTS } from "@/lib/attachments";
import { today } from "@/lib/model";
import { clientState } from "@/lib/server-state";

export async function POST(request: Request) {
  try {
    const token = await sessionToken();
    await requireAccount(token);
    const cmd = await readJson(request);
    if (cmd && typeof cmd === "object" && "type" in cmd && cmd.type === "uploadAttachment") throw new CommandError("请通过附件上传接口提交文件", 400);
    return await withWriteLock(async (tx) => {
      // 锁内重新读取会话与权限：排队期间的停用或权限变更立即生效。
      const acc = await requireAccount(token, tx);
      const before = await loadState(tx);
      const now = new Date();
      const newId = `N${randomUUID().replaceAll("-", "").toUpperCase()}`;
      const { state, result } = applyCommand(before, { accountId: acc.id, today: today(now), newId, now: now.toISOString() }, cmd);
      const command = commandSchema.parse(cmd);
      const draftIds = command.type === "addItem" || command.type === "edit" ? command.screenshotDraftIds ?? [] : [];
      let files: (typeof attachments.$inferInsert)[] = [];
      if ((command.type === "addItem" || command.type === "edit") && draftIds.length) {
        const targetId = command.type === "edit" ? command.id : newId;
        const target = state.items.find((item) => item.id === targetId)!;
        if (target.kind === "project" || new Set(draftIds).size !== draftIds.length) throw new CommandError("截图参数无效", 400);
        if (command.type === "edit" && !canAddItemScreenshots(before.items, target, acc)) throw new CommandError("你没有权限为这个工作项添加截图");
        const drafts = await tx.select().from(draftScreenshots).where(and(
          inArray(draftScreenshots.id, draftIds), eq(draftScreenshots.uploadedBy, acc.id), gt(draftScreenshots.expiresAt, now),
        ));
        if (drafts.length !== draftIds.length) {
          // 已保存但响应丢失时，同一批截图可以重试，不重复创建或追加。
          const attached = (before.attachments ?? []).filter((file) => draftIds.includes(file.id) && file.uploadedBy === acc.id);
          const saved = before.items.find((item) => item.id === attached[0]?.itemId);
          const sameBatch = saved && attached.length === draftIds.length && attached.every((file) => file.itemId === saved.id) &&
            draftIds.every((id) => saved.screenshotIds?.includes(id)) && canSee(before.items, saved, acc);
          if (sameBatch && command.type === "addItem" && saved.kind === target.kind && saved.parentId === target.parentId) {
            return json({ result: { ok: true, id: saved.id }, state: clientState(before, acc.id) });
          }
          if (!(sameBatch && command.type === "edit" && saved.id === target.id)) {
            return json({ ok: false, retryScreenshots: true, reason: "截图暂存已失效，请重新提交" }, 409);
          }
        } else {
          const screenshotIds = [...(target.screenshotIds ?? []), ...draftIds];
          if (screenshotIds.length > MAX_ITEM_SCREENSHOTS) throw new CommandError(`每个工作项最多上传 ${MAX_ITEM_SCREENSHOTS} 张截图`, 400);
          files = drafts.map(({ id, uploadedBy, name, mime, size, content }) => ({
            id, itemId: targetId, uploadedBy, name, mime, size, content, createdAt: now,
          }));
          target.screenshotIds = screenshotIds;
          state.attachments = [...(state.attachments ?? []), ...drafts.map(({ id, uploadedBy, name, mime, size }) => ({
            id, itemId: targetId, uploadedBy, name, mime, size, createdAt: now.toISOString(),
          }))];
          if (command.type === "edit") {
            target.log = [...target.log, { date: today(now), at: now.toISOString(), by: acc.id, text: `上传了 ${draftIds.length} 张截图` }];
          }
        }
      }
      await persistState(tx, before, state);
      if (files.length) {
        await tx.insert(attachments).values(files);
        await tx.delete(draftScreenshots).where(inArray(draftScreenshots.id, draftIds));
      }
      if (command.type === "addDefect" && result.id) {
        await persistDefectNotice(tx, before, state, command.id, result.id, now);
      }
      if ((command.type === "postUpdate" || command.type === "editUpdate") && result.id) {
        await persistMentions(tx, before, state, command.id, result.id, now);
      }
      if (["addItem", "edit", "submit", "verify", "publish", "verifyProduction", "recordReleaseIssue", "setStatus", "moveItem", "linkRepoEvent", "bindRepo"].includes(command.type)) {
        await persistHandoffs(tx, before, state, { id: newId, actorId: acc.id, rejected: (command.type === "verify" || command.type === "verifyProduction") && !command.pass }, now);
      }
      // 允许管理员撤销自己的菜单权限或停用自己；下一次请求会拒绝该会话。
      if (!state.accounts.find((a) => a.id === acc.id)?.active) return json({ result, loggedOut: true });
      return json({ result, state: clientState(state, acc.id) });
    });
  } catch (error) { return apiError(error); }
}
