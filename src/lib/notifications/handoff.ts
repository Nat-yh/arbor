import { canSee, verifierAllowed } from "../access";
import { assigneeIds, dateOffset, daysBetween, fmt, isAssignee, requiresProduction, today, type WorkItem } from "../model";
import type { Report } from "../report";
import type { AppState } from "../state";
import { isInactive, isLeaf, projectOf, reviewSinceOf, statusOf, verifiersOf } from "../tree";
import type { Notice } from "./plan";

type Role = "负责人" | "执行人";
export type Handoff =
  | { kind: "assign"; roles: Role[] }
  | { kind: "review_requested"; cycle: string; transfer?: boolean }
  | { kind: "review_rejected"; cycle: string }
  | { kind: "release_requested"; cycle: string }
  | { kind: "production_review_requested"; cycle: string };

export function reviewCycle(item: WorkItem, since?: string) {
  if (item.status === "production-review" && item.publication) return item.publication.id;
  if (item.status === "release" && item.releaseCycle) return item.releaseCycle.id;
  return item.reviewToken ?? since ?? item.id;
}

const verifying = (state: AppState, item: WorkItem) =>
  !isInactive(state.items, item) && (isLeaf(state.items, item.id) || requiresProduction(item)) && statusOf(state.items, item) === "review";

const rolesOf = (item: WorkItem | undefined, id: string): Role[] => {
  if (!item) return [];
  const roles: Role[] = [];
  if (item.owner === id) roles.push("负责人");
  if (assigneeIds(item).includes(id)) roles.push("执行人");
  return roles;
};

export function handoffReport(
  change: Handoff, item: Pick<WorkItem, "id" | "kind" | "title" | "due" | "checks" | "publication" | "publisher" | "productionRequired">, projectName: string, actorName: string | undefined, date: string, to: string,
): Report {
  const actor = actorName ? `${actorName}已` : "已";
  const days = daysBetween(date, item.due);
  const deadline = days === 0 ? "今天截止" : days === 1 ? "明天截止" : days < 0 ? `已逾期 ${-days} 天` : `截止 ${fmt(item.due)}`;
  const definitions = {
    assign: { title: item.kind === "task" ? "你接手了一项任务" : "你接手了一项工作", tone: "blue" as const, action: "查看工作项", detail: change.kind === "assign" ? `${actor}将你设为${change.roles.join("、")}。${deadline}。` : "" },
    review_requested: {
      title: requiresProduction(item) ? "有需求等你测试验收" : "有交付物等你验收",
      tone: "purple" as const, action: "去验收",
      detail: change.kind === "review_requested" && change.transfer ? "这项工作已交接给你，请核对交付结果。" : actorName ? `${actorName}已提交，请核对交付结果。` : "交付物已提交，请核对结果。",
    },
    review_rejected: { title: item.checks.at(-1)?.type === "线上验收" ? "线上验收打回，待修改" : "验收打回，待修改", tone: "orange" as const, action: "查看修改意见", detail: item.checks.at(-1)?.note || "请查看任务中的验收记录。" },
    release_requested: { title: "有需求等你发布到生产", tone: "blue" as const, action: "查看待发布需求", detail: "请完成生产部署，并在 Arbor 记录发布版本或链接。" },
    production_review_requested: { title: "有需求等你线上验收", tone: "purple" as const, action: "去线上验收", detail: `生产发布已登记：${item.publication?.version ?? ""}。` },
  };
  const definition = definitions[change.kind];
  return {
    title: definition.title, to, tone: definition.tone,
    action: { label: definition.action, itemId: item.id },
    sections: [{ heading: definition.title, variant: "handoff", lines: [{
      text: item.title, itemId: item.id, context: projectName, detail: definition.detail,
      ...(change.kind === "review_rejected" ? { status: "打回原因" } : {}),
    }] }],
  };
}

export function validHandoff(state: AppState, notice: Notice, date: string): Notice | undefined {
  const change = notice.handoff;
  if (!change) return;
  const rule = change.kind === "release_requested" || change.kind === "production_review_requested" ? "review_requested" : change.kind;
  if (!state.rules.some((r) => r.id === rule && r.enabled && r.channels.includes("飞书私聊"))) return;
  const item = state.items.find((x) => x.id === notice.itemId);
  const account = state.accounts.find((a) => a.id === notice.recipient.slice(8));
  if (!item || !account || !canSee(state.items, item, account) || isInactive(state.items, item)) return;
  const status = statusOf(state.items, item);
  let current = change;
  if (change.kind === "assign") {
    if (status === "done") return;
    const roles = change.roles.filter((role) => rolesOf(item, account.id).includes(role));
    if (!roles.length) return;
    current = { ...change, roles };
  } else if (change.kind === "review_requested") {
    if (!verifying(state, item) || !verifierAllowed(item, account.id) || !verifiersOf(state.items, item).includes(account.id) ||
        change.cycle !== reviewCycle(item, reviewSinceOf(state.items, item, date))) return;
  } else if (change.kind === "release_requested") {
    if (status !== "release" || !isAssignee(item, account.id) || item.releaseCycle?.id !== change.cycle) return;
  } else if (change.kind === "production_review_requested") {
    if (status !== "production-review" || item.publication?.id !== change.cycle || !verifiersOf(state.items, item).includes(account.id)) return;
  } else {
    const rejectedProduction = item.checks.at(-1)?.type === "线上验收";
    if (!assigneeIds(item).includes(account.id) || (!["doing", "blocked"].includes(status) && !(rejectedProduction && status === "review")) ||
        item.checks.at(-1)?.id !== change.cycle) return;
  }
  const actorName = state.people.find((p) => p.id === notice.actorId)?.name;
  return { ...notice, handoff: current, report: handoffReport(current, item, projectOf(state.items, item).title, actorName, date, notice.recipient) };
}

export function collectHandoffs(before: AppState, after: AppState, event: { id: string; actorId?: string; rejected?: boolean }, now: Date): Notice[] {
  const date = today(now);
  const previous = new Map(before.items.map((item) => [item.id, item]));
  const out: Notice[] = [];
  for (const item of after.items) {
    if (isInactive(after.items, item)) continue;
    const old = previous.get(item.id);
    const oldStatus = old ? statusOf(before.items, old) : undefined;
    const status = statusOf(after.items, item);
    const beforeVerifying = old && verifying(before, old);
    const afterVerifying = verifying(after, item);
    const beforeVerifiers = old && (beforeVerifying || oldStatus === "production-review") ? verifiersOf(before.items, old).filter((id) => verifierAllowed(old, id)) : [];
    const afterVerifiers = afterVerifying || status === "production-review" ? verifiersOf(after.items, item).filter((id) => verifierAllowed(item, id)) : [];
    const cycle = reviewCycle(item, reviewSinceOf(after.items, item, date));
    const sameCycle = !!old && beforeVerifying && cycle === reviewCycle(old, reviewSinceOf(before.items, old, date));
    const lastCheck = item.checks.at(-1);
    const rejected = event.rejected && (oldStatus === "review" || oldStatus === "production-review") &&
      item.status === "doing" && lastCheck?.result === "不通过";
    const people = new Set([item.owner, ...assigneeIds(item), ...afterVerifiers]);
    for (const id of people) {
      if (!id || id === event.actorId) continue;
      const roles = rolesOf(item, id).filter((role) => !rolesOf(old, id).includes(role));
      let change: Handoff | undefined;
      if (rejected && assigneeIds(item).includes(id)) change = { kind: "review_rejected", cycle: lastCheck.id };
      else if (status === "release" && isAssignee(item, id) && item.releaseCycle &&
          (oldStatus !== "release" || !old || !isAssignee(old, id) || old.releaseCycle?.id !== item.releaseCycle.id)) {
        change = { kind: "release_requested", cycle: item.releaseCycle.id };
      } else if (status === "production-review" && item.publication && afterVerifiers.includes(id) &&
          (oldStatus !== "production-review" || !beforeVerifiers.includes(id) || old?.publication?.id !== item.publication.id)) {
        change = { kind: "production_review_requested", cycle: item.publication.id };
      } else if (afterVerifying && afterVerifiers.includes(id) && (!beforeVerifiers.includes(id) || !sameCycle) && !rejected) {
        change = { kind: "review_requested", cycle, transfer: !!sameCycle };
      } else if (roles.length) change = { kind: "assign", roles };
      if (!change) continue;
      const recipient = `account:${id}`;
      const notice: Notice = {
        type: "handoff", objectId: `${change.kind}:${item.id}`, window: event.id, recipient, itemId: item.id, actorId: event.actorId,
        level: change.kind === "review_rejected" ? "warn" : "info",
        handoff: change, expires: dateOffset(date, 7), report: { title: "", to: recipient, sections: [] },
      };
      const valid = validHandoff(after, notice, date);
      if (valid) out.push(valid);
    }
  }
  return out;
}
