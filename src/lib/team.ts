import { assigneeIds, isAssignee, type Update } from "./model";
import { canSee, canUseTeam, type Account } from "./access";
import { isInactive, isLeaf, projectOf, statusOf, dueStateOf } from "./tree";
import type { AppState } from "./state";
import { readableLog } from "./changes";
import { ownRootDeletion } from "./lifecycle";

/** 始终自行按账号投影，调用方即使传入完整状态也不会扩大统计范围。只计叶子工作。 */
export function memberLoads(state: AppState, acc: Account, asOf: string) {
  if (!canUseTeam(state.items, acc)) return [];
  const items = state.items.filter((x) => canSee(state.items, x, acc));
  const tasks = items.filter((x) => x.kind !== "project" && isLeaf(items, x.id) && !isInactive(items, x) && statusOf(items, x) !== "done");
  return state.people.map((person) => {
    const assigned = tasks.filter((x) => isAssignee(x, person.id));
    const counts = { todo: 0, doing: 0, review: 0, blocked: 0 };
    let overdue = 0;
    for (const task of assigned) {
      const status = statusOf(items, task);
      if (status !== "done" && status !== "cancelled") counts[status === "release" || status === "production-review" ? "review" : status]++;
      if (dueStateOf(items, task, 2, asOf) === "overdue") overdue++;
    }
    return { person, tasks: assigned, overdue, ...counts };
  }).filter((row) => row.tasks.length || (row.person.active !== false && items.some((x) => [x.owner, ...assigneeIds(x), ...x.verifiers, ...(x.members ?? [])].includes(row.person.id))));
}

export interface FeedEntry { id: string; itemId: string; projectId: string; title: string; by: string; date: string; at?: string; text: string; mentions?: Update["mentions"]; deleted?: boolean }
export function recentActivity(state: AppState, acc: Account, filter: { project?: string; person?: string; offset?: number; limit?: number } = {}) {
  if (!canUseTeam(state.items, acc)) return { entries: [] as FeedEntry[], total: 0 };
  const visible = state.items.filter((x) => canSee(state.items, x, acc));
  const ids = new Set(visible.map((x) => x.id));
  const name = (id: string) => state.people.find((p) => p.id === id)?.name ?? id;
  const entries: FeedEntry[] = visible.flatMap((x) => {
    const projectId = projectOf(visible, x).id;
    return [
      ...x.updates.flatMap((u, i) => u.retractedAt ? [] : [{ ...u, id: `${x.id}:update:${i}`, itemId: x.id, projectId, title: x.title, text: `${u.progress !== undefined ? `进度 ${u.progress}% · ` : ""}${u.text}` }]),
      ...x.log.map((l, i) => ({ ...l, id: `${x.id}:log:${i}`, itemId: x.id, projectId, title: x.title, text: readableLog(l.text, name) })),
    ];
  });
  for (const a of state.activities ?? []) {
    // 已删除根项目只向原服务端投影允许的全范围管理员显示。其他人仅看仍可见项目。
    if (!ids.has(a.projectId) && !ownRootDeletion(a, acc.id) && !(acc.scope === "all" && acc.menus.includes("settings") && acc.menus.includes("projects"))) continue;
    // 删除子项已在父项留同文动态，合并重复事件。
    const duplicate = entries.findIndex((e) => e.text === a.text && e.date === a.date && e.by === a.by);
    if (duplicate >= 0) entries.splice(duplicate, 1);
    entries.push({ ...a, deleted: true });
  }
  const matching = entries.filter((e) => (!filter.project || e.projectId === filter.project) && (!filter.person || e.by === filter.person))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.at ?? "").localeCompare(a.at ?? "") || b.id.localeCompare(a.id, undefined, { numeric: true }));
  const offset = Math.max(0, filter.offset ?? 0);
  return { entries: matching.slice(offset, offset + Math.max(1, filter.limit ?? 30)), total: matching.length };
}
