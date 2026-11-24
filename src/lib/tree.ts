// 树结构计算：进度汇总、状态汇总、继承、风险判断
import { ACCEPTANCE_CHECK_ID, BLOCKING_DEFECT_CHECK_ID, NO_OPEN_BLOCKING_DEFECTS, daysBetween, hasAcceptanceCriteria, isAssignee, isPublishing, requiresProduction, today, usesAcceptanceCriteria, workingDays, type CheckItem, type Iteration, type Status, type WorkItem } from "./model";

export type Items = WorkItem[];

export function childrenOf(items: Items, id: string | null): WorkItem[] {
  const children = items.filter((i) => i.parentId === id);
  const order = id ? byId(items, id)?.childOrder : undefined;
  if (!order?.length || children.length < 2) return children;
  const ranks = new Map(order.map((childId, index) => [childId, index]));
  return children.sort((a, b) => (ranks.get(a.id) ?? order.length) - (ranks.get(b.id) ?? order.length));
}
export const isLeaf = (items: Items, id: string) => !items.some((i) => i.parentId === id);
export const byId = (items: Items, id: string) => items.find((i) => i.id === id);

export function ancestors(items: Items, item: WorkItem): WorkItem[] {
  const out: WorkItem[] = [];
  let p = item.parentId ? byId(items, item.parentId) : undefined;
  while (p) {
    out.unshift(p);
    p = p.parentId ? byId(items, p.parentId) : undefined;
  }
  return out;
}

export function descendants(items: Items, id: string): WorkItem[] {
  const kids = childrenOf(items, id);
  return kids.flatMap((k) => [k, ...descendants(items, k.id)]);
}

export const leavesOf = (items: Items, id: string) => descendants(items, id).filter((d) => isLeaf(items, d.id));

export const projectOf = (items: Items, item: WorkItem) => (item.parentId ? ancestors(items, item)[0] : item);

/** 取消可来自自身或上级；归档保留历史统计，但停止后续业务和提醒。 */
export const isCancelled = (items: Items, item: WorkItem) => [item, ...ancestors(items, item)].some((x) => x.status === "cancelled");
export const isInactive = (items: Items, item: WorkItem) => isCancelled(items, item) || !!projectOf(items, item).archivedAt;
export const activeChildren = (items: Items, id: string) => childrenOf(items, id).filter((x) => !isCancelled(items, x));
export const needsSubmission = (items: Items, item: WorkItem) => item.kind !== "project" && !isInactive(items, item) && isLeaf(items, item.id) && item.progress === 100 && item.status !== "done" && item.status !== "review" && !isPublishing(item.status);

/** AI 应用标记：自身或任一上级标记即为 AI 应用 */
export const aiOf = (items: Items, item: WorkItem) => [...ancestors(items, item), item].some((x) => x.ai);

export function verifiersOf(items: Items, item: WorkItem): string[] {
  if (item.verifiers.length) return item.verifiers;
  const a = ancestors(items, item).reverse().find((x) => x.verifiers.length);
  return a?.verifiers ?? [];
}

export function estimateOf(items: Items, item: WorkItem): number {
  if (isCancelled(items, item)) return 0;
  const kids = activeChildren(items, item.id);
  if (!kids.length) return childrenOf(items, item.id).length ? 0 : workingDays(item.start, item.due);
  return kids.reduce((a, k) => a + estimateOf(items, k), 0);
}

/** 项目从子项汇总进度；其他叶子工作项使用自身进度。 */
export function progressOf(items: Items, item: WorkItem): number {
  if (isCancelled(items, item)) return 0;
  const kids = activeChildren(items, item.id);
  if (!kids.length) return item.kind === "project" || childrenOf(items, item.id).length ? 0 : item.status === "done" ? 100 : item.progress;
  return weightedProgress(items, kids);
}

function weightedProgress(items: Items, scope: WorkItem[]): number {
  if (!scope.length) return 0;
  const weights = scope.map((item) => estimateOf(items, item));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total) {
    return Math.round(scope.reduce((sum, item, index) => sum + progressOf(items, item) * weights[index], 0) / total);
  }
  // 只排在周末时仍显示进度；没有有效叶子的分支不计入。
  const scheduled = scope.filter((item) => isLeaf(items, item.id) || leavesOf(items, item.id).some((leaf) => !isCancelled(items, leaf)));
  return scheduled.length ? Math.round(scheduled.reduce((sum, item) => sum + progressOf(items, item), 0) / scheduled.length) : 0;
}

export const blockingDefects = (items: Items, item: WorkItem) =>
  [item, ...descendants(items, item.id)].filter((x) => !isCancelled(items, x))
    .flatMap((x) => x.defects.filter((d) => d.status === "open" && (d.severity === "P0" || d.severity === "P1")));

/**
 * 能由系统自动判断的检查项，不需要人工勾选：
 * - 无未关闭的 P0/P1 缺陷：看下层缺陷记录
 * - 评测通过率 / 成本：看 AI 评测结果
 * 返回 undefined 表示需要人工确认。
 */
export function autoCheck(items: Items, item: WorkItem, check: CheckItem): boolean | undefined {
  if (check.source === "自定义") return undefined;
  if (check.id === ACCEPTANCE_CHECK_ID && usesAcceptanceCriteria(item)) return hasAcceptanceCriteria(item);
  const { label } = check;
  if (check.id === BLOCKING_DEFECT_CHECK_ID || label.includes("P0 / P1")) return blockingDefects(items, item).length === 0;
  // 下层已有通过的验收 / 评审 / 测试记录时自动确认；没有记录则留给人工确认
  const evidence = (types: string[]) => [item, ...descendants(items, item.id)].filter((x) => !isCancelled(items, x)).some((x) => x.checks.some((c) => c.result === "通过" && types.includes(c.type) && (check.id !== "code-review" || !isAssignee(x, c.by))));
  if (label.includes("业务验收通过") && evidence(["业务验收", "验收", ...(requiresProduction(item) ? ["测试验收"] : [])])) return true;
  if (label.includes("代码评审通过") && evidence(["代码评审"])) return true;
  if (label.includes("测试通过") && evidence(["自动化测试", "UAT"])) return true;
  const e = item.eval;
  if (e && label.includes("通过率")) return (e.prompts.at(-1)?.passRate ?? 0) >= e.threshold;
  if (e && label.includes("成本")) return e.costPerK <= e.costBudget;
  if (e && label.includes("Bad Case")) return !e.badCases.some((b) => b.status === "待处理");
  return undefined;
}

export const isCheckDone = (items: Items, item: WorkItem, c: CheckItem) => autoCheck(items, item, c) ?? c.done;

export function visibleChecks(items: Items, item: WorkItem): CheckItem[] {
  const checks = item.checklist.filter((check) =>
    check.required !== false && check.id !== ACCEPTANCE_CHECK_ID && check.id !== BLOCKING_DEFECT_CHECK_ID);
  const savedBlocker = item.checklist.find((check) => check.id === BLOCKING_DEFECT_CHECK_ID);
  const checkDefects = savedBlocker ? savedBlocker.required !== false : usesAcceptanceCriteria(item);
  if (checkDefects && blockingDefects(items, item).length > 0) {
    checks.push(savedBlocker ?? { id: BLOCKING_DEFECT_CHECK_ID, label: NO_OPEN_BLOCKING_DEFECTS, source: "通用", done: false });
  }
  return checks;
}

export const openChecks = (items: Items, item: WorkItem) => visibleChecks(items, item)
  .filter((check) => check.id === BLOCKING_DEFECT_CHECK_ID || !isCheckDone(items, item, check));

/** 保存通过测试验收时的交付范围。拆分、移动或重新打开下级后要重新验收。 */
export function releaseScope(items: Items, item: WorkItem): string {
  return JSON.stringify(descendants(items, item.id).filter((child) => !isCancelled(items, child))
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((child) => [child.id, child.parentId, child.doneAt, child.rework, child.log.findLast((entry) => entry.action === "reopen")?.at]));
}

/**
 * 状态：叶子取自身；有子项时自动汇总。
 * 子项全部完成后，上级自动进入「待验收」，完成检查项全部确认后才算「已完成」。
 */
export function statusOf(items: Items, item: WorkItem): Status {
  if (isCancelled(items, item)) return "cancelled";
  const kids = activeChildren(items, item.id);
  if (!kids.length) {
    if (childrenOf(items, item.id).length) return "todo";
    if (requiresProduction(item) && item.releaseCycle && (isPublishing(item.status) || item.status === "done") && item.releaseCycle.scope !== "[]") return "review";
    return item.status;
  }
  const ss = kids.map((k) => statusOf(items, k));
  if (ss.every((s) => s === "done")) {
    if (requiresProduction(item)) {
      const sameScope = item.releaseCycle?.scope === releaseScope(items, item);
      if (sameScope && (isPublishing(item.status) || item.status === "done")) return item.status;
      if (sameScope && item.checks.findLast((check) => check.type === "测试验收" || check.type === "线上验收")?.result === "不通过") return "doing";
      return "review";
    }
    const needsApproval = usesAcceptanceCriteria(item) && item.status !== "done";
    return needsApproval || openChecks(items, item).length ? "review" : "done";
  }
  if (ss.every((s) => s === "todo")) return "todo";
  return "doing";
}

export function projectWorkCounts(items: Items, projectId: string) {
  let doing = 0;
  let todo = 0;
  for (const item of descendants(items, projectId)) {
    const status = statusOf(items, item);
    if (status === "doing") doing++;
    if (status === "todo") todo++;
  }
  return { doing, todo };
}

export const hasBlocked = (items: Items, item: WorkItem) => descendants(items, item.id).some((d) => !isInactive(items, d) && d.status === "blocked");

/** 上级进入待验收的时间 = 最后一个子项完成的时间 */
export function reviewSinceOf(items: Items, item: WorkItem, asOf = today()): string | undefined {
  if (isLeaf(items, item.id) || (requiresProduction(item) && isPublishing(item.status) && isPublishing(statusOf(items, item)))) return item.reviewSince;
  const ds = activeChildren(items, item.id).map((k) => k.doneAt ?? reviewSinceOf(items, k, asOf) ?? asOf);
  return ds.sort().at(-1);
}

export type DueState = "done" | "overdue" | "soon" | "ok";

export function dueStateOf(items: Items, item: WorkItem, soonDays = 2, asOf = today()): DueState {
  if (isInactive(items, item) || statusOf(items, item) === "done") return "done";
  const d = daysBetween(asOf, item.due);
  if (d < 0) return "overdue";
  if (d <= soonDays) return "soon";
  return "ok";
}

/** 计划进度：按时间线性推算今天应该完成多少 */
export function plannedProgress(item: WorkItem, asOf = today()) {
  const total = Math.max(1, daysBetween(item.start, item.due));
  const elapsed = daysBetween(item.start, asOf);
  return Math.max(0, Math.min(100, Math.round((elapsed / total) * 100)));
}

/** 最后一次进展更新（含子项） */
export function lastUpdateOf(items: Items, item: WorkItem): string | undefined {
  const all = [item, ...descendants(items, item.id)].flatMap((x) => x.updates.map((u) => u.date));
  return all.sort().at(-1);
}

export const depthOf = (items: Items, item: WorkItem) => ancestors(items, item).length;

export function levelLabel(items: Items, item: Pick<WorkItem, "kind" | "parentId">): "项目" | "需求" | "任务" | "子任务" {
  if (item.kind !== "task") return item.kind === "project" ? "项目" : "需求";
  const parent = item.parentId ? byId(items, item.parentId) : undefined;
  return parent?.kind === "task" ? "子任务" : "任务";
}

/** 同项目内未进入验收的末级任务可转移；目标状态随子项重新汇总。 */
export function canReparentTask(items: Items, item: WorkItem, target: WorkItem): boolean {
  return item.kind === "task" && isLeaf(items, item.id) &&
    !["review", "done"].includes(item.status) && !isInactive(items, item) &&
    item.id !== target.id && item.parentId !== target.id &&
    target.kind !== "project" && levelLabel(items, target) !== "子任务" &&
    !isInactive(items, target) &&
    projectOf(items, item).id === projectOf(items, target).id;
}

// ───────── 迭代 ─────────

/** 明确「待规划」：不沿用上级的迭代（嵌套项从上级的迭代里单独拿出来时用） */
export const BACKLOG = "backlog";

/** 工作项实际所属迭代：自身设置优先，否则沿用最近的上级（不含项目）；BACKLOG 表示待规划 */
export function iterationIdOf(items: Items, item: WorkItem): string | undefined {
  for (const x of [item, ...ancestors(items, item).reverse()]) {
    if (x.kind === "project") return undefined;
    if (x.iteration) return x.iteration === BACKLOG ? undefined : x.iteration;
  }
  return undefined;
}

export function iterationOf(items: Items, item: WorkItem): Iteration | undefined {
  const id = iterationIdOf(items, item);
  return id ? projectOf(items, item).iterations?.find((i) => i.id === id) : undefined;
}

/** 上级的实际迭代（上级是项目时为空）：本项不单独设置时就沿用它 */
export const parentIterationOf = (items: Items, item: WorkItem) => {
  const parent = item.parentId ? byId(items, item.parentId) : undefined;
  return parent && parent.kind !== "project" ? iterationIdOf(items, parent) : undefined;
};

/** 当前迭代：时间窗口覆盖今天的；其次是已到期还没结束的（提醒去结束）；再次是最近要开始的 */
export function currentIteration(project: WorkItem, asOf = today()): Iteration | undefined {
  const open = (project.iterations ?? []).filter((i) => !i.closedAt).sort((a, b) => a.start.localeCompare(b.start));
  return open.find((i) => i.start <= asOf && asOf <= i.end) ?? open.find((i) => i.end < asOf) ?? open.find((i) => i.start > asOf);
}

export type IterationPhase = "closed" | "active" | "overdue" | "planned";
export function iterationPhase(it: Iteration, asOf = today()): IterationPhase {
  if (it.closedAt) return "closed";
  if (asOf < it.start) return "planned";
  return asOf > it.end ? "overdue" : "active";
}

/**
 * 迭代的范围：实际所属该迭代、且上级不属于同一迭代的工作项（每棵子树只算顶层一项）。
 * iterationId 为 null 时表示「待规划」：不属于任何迭代、且上级属于某个迭代（或上级就是项目）的项。
 */
export function iterationScope(items: Items, project: WorkItem, iterationId: string | null): WorkItem[] {
  const all = descendants(items, project.id).filter((x) => !isCancelled(items, x));
  return all.filter((x) => {
    const own = iterationIdOf(items, x) ?? null;
    if (own !== iterationId) return false;
    const parent = x.parentId ? byId(items, x.parentId) : undefined;
    return !parent || parent.kind === "project" || (iterationIdOf(items, parent) ?? null) !== iterationId;
  });
}

/** 某项在指定迭代里的那部分工作：有效子项中实际属于该迭代的叶子 */
function leavesIn(items: Items, item: WorkItem, iterationId: string | undefined): WorkItem[] {
  const kids = activeChildren(items, item.id);
  if (!kids.length) return iterationIdOf(items, item) === iterationId ? [item] : [];
  return kids.flatMap((k) => leavesIn(items, k, iterationId));
}

/**
 * 是否算「在这个迭代里完成」：只看属于本迭代的那部分。
 * 整项都在本迭代时按它自己的状态（需求还要过检查项）；拆了一部分到别的迭代时，本迭代的叶子都完成即可。
 */
export function doneInIteration(items: Items, item: WorkItem, iterationId: string | undefined): boolean {
  const mine = leavesIn(items, item, iterationId);
  const whole = mine.length === leavesOf(items, item.id).filter((l) => !isCancelled(items, l)).length || isLeaf(items, item.id);
  return whole ? statusOf(items, item) === "done" : mine.every((l) => statusOf(items, l) === "done");
}

/** 迭代统计：完成数、按工作量加权的进度（只算本迭代的部分）、逾期和阻塞数 */
export function iterationStats(items: Items, scope: WorkItem[], iterationId: string | undefined, asOf = today()) {
  const leaves = scope.flatMap((x) => leavesIn(items, x, iterationId));
  const progress = weightedProgress(items, leaves.filter((item) => !isCancelled(items, item) && isLeaf(items, item.id)));
  const done = scope.filter((x) => doneInIteration(items, x, iterationId)).length;
  const overdue = scope.filter((x) => !doneInIteration(items, x, iterationId) && dueStateOf(items, x, 2, asOf) === "overdue").length;
  const blocked = scope.filter((x) => leavesIn(items, x, iterationId).some((l) => statusOf(items, l) === "blocked")).length;
  return { total: scope.length, done, progress, overdue, blocked };
}
