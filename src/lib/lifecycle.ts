import type { WorkItem } from "./model";
import type { AppState } from "./state";
import { ancestors, descendants, isInactive, isLeaf, projectOf } from "./tree";

/** 删除的就是项目本身时，项目已不存在、无可泄漏内容，删除人仍能看到自己的记录。 */
export const ownRootDeletion = (a: { itemId: string; projectId: string; by: string }, me: string) => a.by === me && a.itemId === a.projectId;

export function canRestore(items: WorkItem[], item: WorkItem): boolean {
  return item.status === "cancelled" && !projectOf(items, item).archivedAt && !ancestors(items, item).some((p) => p.status === "cancelled");
}

/** 新记录按批次恢复；旧记录只匹配明确记录的随上级取消动态，不扩大到独立取消。 */
export function restoreTargets(items: WorkItem[], item: WorkItem): WorkItem[] {
  const origin = item.cancellation;
  const log = item.log.at(-1);
  return [item, ...descendants(items, item.id).filter((x) => {
    if (x.status !== "cancelled") return false;
    if (origin) return x.cancellation?.batch === origin.batch && x.cancellation.rootId === origin.rootId;
    const last = x.log.at(-1);
    return !x.cancellation && last?.text === `取消（随上级「${item.title}」）：${item.cancelReason}` && last.date === log?.date && last.at === log?.at && last.by === log?.by;
  })];
}

export function restoredStatus(item: WorkItem): Exclude<WorkItem["status"], "cancelled"> {
  // P0 取消未保存原状态，按仍保留的结构化状态事实恢复，缺少事实时回到未开始。
  return item.cancellation?.status ?? (item.doneAt ? "done" : item.reviewSince ? "review" : item.blockedSince ? "blocked" : item.progress > 0 ? "doing" : "todo");
}

/** 项目仅在创建当天、尚未开展工作时允许撤销误建。 */
function isNewProject(item: WorkItem, asOf: string): boolean {
  return item.status === "todo" && item.progress === 0
    && item.log.length === 1 && item.log[0].date === asOf && /^创建(项目|需求|任务)$/.test(item.log[0].text)
    && !item.updates.length && !item.checks.length && !item.defects.length && !item.checklist.some((c) => c.done || c.doneBy || c.doneAt)
    && !item.deliverable && !item.pr && !item.doneAt && !item.reviewSince && !item.blockedSince && !item.blockedReason && !item.rework
    && !item.repos?.length && !item.eval?.prompts.length && !item.eval?.badCases.length && !item.milestones?.some((m) => m.done);
}

/** 删除条件前后端共用，权限由调用方检查。 */
export function deleteBlockReason(state: Pick<AppState, "items" | "attachments" | "repoEvents">, item: WorkItem, asOf: string): string | undefined {
  if (isInactive(state.items, item)) return "工作项已取消或项目已归档，不能删除";
  const hasChildren = !isLeaf(state.items, item.id);
  const hasFiles = state.attachments?.some((a) => a.itemId === item.id);
  const hasRepoEvents = state.repoEvents.some((e) => e.itemId === item.id || e.projectId === item.id);
  if (item.kind === "project") {
    if (hasChildren || hasFiles || hasRepoEvents || !isNewProject(item, asOf)) return "仅当天误建";
    return;
  }
  if (hasChildren) return "有下级工作项";
  if (hasFiles) return "有关联附件";
  if (hasRepoEvents || item.pr) return "有关联仓库记录";
}
