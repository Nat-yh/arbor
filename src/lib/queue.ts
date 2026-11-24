import { canSee, verifierAllowed } from "./access";
import { computeAlerts, isAttentionId, type Alert, type AttentionId } from "./alerts";
import { assigneeIds, isAssignee, isPublishing, requiresProduction, daysBetween, today, type WorkItem } from "./model";
import type { AppState } from "./state";
import { byId, isInactive, isLeaf, needsSubmission, projectOf, reviewSinceOf, statusOf, verifiersOf } from "./tree";

export interface QueueReason { text: string; rank: number; tone: "red" | "amber" | "dark" | "muted"; management?: boolean; detail?: string; attention?: AttentionId }
export const describeQueueReason = (r: QueueReason) => r.detail ? `${r.text}：${r.detail}` : r.text;
export interface QueueEntry { x: WorkItem; r: QueueReason; reasons: QueueReason[] }
type QueueState = Pick<AppState, "items" | "accounts" | "rules" | "people">;

/** 所有个人入口共用；同一工作项命中多个条件时仍只计一件。提醒规则关闭不等于风险已处理。 */
export function myQueue(state: QueueState, me: string, asOf = today(), alerts?: Alert[]): QueueEntry[] {
  const { items } = state;
  const acc = state.accounts.find((a) => a.id === me);
  if (!acc?.active) return [];
  const out: QueueEntry[] = [];
  const attention = new Map<string, QueueReason[]>();
  for (const { ruleId, to, itemId, ruleName, text } of alerts ?? computeAlerts(items, state.rules, asOf)) {
    if (!isAttentionId(ruleId) || !to.includes(me)) continue;
    const rank = ruleId === "start_late" ? 1 : 2;
    const reasons = attention.get(itemId) ?? [];
    reasons.push({ text: ruleId === "stale" ? "待更新进展" : ruleName, rank, tone: "amber", detail: text, attention: ruleId });
    attention.set(itemId, reasons);
  }
  for (const x of items) {
    if (!canSee(items, x, acc) || isInactive(items, x)) continue;
    const st = statusOf(items, x);
    if (st === "done") continue;
    const reasons: QueueReason[] = [...(attention.get(x.id) ?? [])];
    const add = (text: string, rank: number, tone: QueueReason["tone"], management = false, detail?: string) => reasons.push({ text, rank, tone, management, ...(detail ? { detail } : {}) });
    if ((st === "review" || st === "production-review") && verifierAllowed(x, me) && verifiersOf(items, x).includes(me)) {
      add(st === "production-review" ? "等你线上验收" : requiresProduction(x) ? "等你测试验收" : "等你验收", 0, "dark");
    }
    if (st === "release" && isAssignee(x, me)) add("等你发布到生产", 0, "dark");
    const days = daysBetween(asOf, x.due);
    if (isAssignee(x, me) && isLeaf(items, x.id)) {
      if (needsSubmission(items, x)) add("100% 未提交", 1, "amber");
      if (st === "doing" && x.checks.at(-1)?.result === "不通过") add("被打回待修改", 1, "red");
      if (st === "blocked") add("阻塞中", 1, "red");
      if (st !== "review" && !isPublishing(st) && days < 0) add(`逾期 ${-days} 天`, 1, "red");
      if (st !== "review" && !isPublishing(st) && days >= 0 && days <= 2) add(days === 0 ? "今天到期" : `${days} 天后到期`, 2, "amber");
      if (!reasons.length) add(st === "release" ? "待发布" : st === "production-review" ? "待线上验收" : st === "review" ? "等别人验收" : st === "todo" ? "未开始" : "进行中", st === "review" ? 5 : st === "todo" ? 4 : 3, "muted");
    }
    if (projectOf(items, x).owner === me) {
      if (st === "blocked") add("项目阻塞", 1, "red", true, x.blockedReason);
      if (days < 0) add("项目逾期", 1, "red", true, `逾期 ${-days} 天`);
      const parent = x.parentId ? byId(items, x.parentId) : undefined;
      if (parent && x.due > parent.due) add("计划冲突", 1, "amber", true, "截止晚于上级");
      const since = reviewSinceOf(items, x, asOf);
      if (st === "review" && since && daysBetween(since, asOf) >= (state.rules.find((r) => r.id === "review")?.n ?? 1)) add("超时未验收", 1, "amber", true, `已等待 ${daysBetween(since, asOf)} 天`);
      const active = (id: string) => state.accounts.find((a) => a.id === id)?.active ?? state.people.some((p) => p.id === id && p.active !== false);
      if (!active(x.owner) || !assigneeIds(x).some(active)) add("无人负责", 1, "amber", true, "未分配或人员已停用");
    }
    if (reasons.length) { reasons.sort((a, b) => a.rank - b.rank); out.push({ x, r: reasons[0], reasons }); }
  }
  return out.sort((a, b) => a.r.rank - b.r.rank || a.x.due.localeCompare(b.x.due) || a.x.id.localeCompare(b.x.id));
}
