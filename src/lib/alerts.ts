// 计算当前风险；实际发送由通知计划控制
import { verifierAllowed } from "./access";
import { assigneeIds, dateOffset, daysBetween, fmt, person, today, workingDays, type WorkItem } from "./model";
import {
  isInactive,
  byId,
  childrenOf,
  dueStateOf,
  isLeaf,
  needsSubmission,
  activeChildren,
  iterationOf,
  plannedProgress,
  progressOf,
  projectOf,
  reviewSinceOf,
  statusOf,
  verifiersOf,
  type Items,
} from "./tree";

export type Channel = "飞书私聊" | "飞书项目群";

export interface Rule {
  id: string;
  name: string;
  desc: string; // {n} 会替换为阈值
  n?: number;
  unit?: string;
  to: string;
  channels: Channel[];
  enabled: boolean;
  kind: "event" | "schedule" | "handoff";
  delivery?: "digest";
  scheduleTime?: string;
}

export const SCHEDULE_DEFAULTS = { daily: "09:30", weekly: "17:00" } as const;
export type ScheduleId = keyof typeof SCHEDULE_DEFAULTS;
export const SCHEDULE_MIN = "09:00";
export const SCHEDULE_MAX = "19:55";
export const QUIET_START = "20:00";

export function isScheduleId(id: string): id is ScheduleId {
  return id === "daily" || id === "weekly";
}

export function validScheduleTime(time: string) {
  return /^\d{2}:[0-5]\d$/.test(time) && time >= SCHEDULE_MIN && time <= SCHEDULE_MAX;
}

export function scheduleTime(id: ScheduleId, time?: string) {
  return time && validScheduleTime(time) ? time : SCHEDULE_DEFAULTS[id];
}

export function scheduleLabel(id: ScheduleId, time?: string) {
  return `${id === "daily" ? "工作日" : "每周五"} ${scheduleTime(id, time)}`;
}

export const DEFAULT_RULES: Rule[] = [
  { id: "due_soon", kind: "event", name: "到期提醒", desc: "截止前 {n} 天列入每日待办摘要", n: 2, unit: "天", to: "执行人", channels: [], delivery: "digest", enabled: true },
  { id: "overdue", kind: "event", name: "逾期提醒与升级", desc: "首次逾期提醒一次；逾期满 {n} 天升级给上级负责人和项目群", n: 2, unit: "天", to: "执行人、负责人 → 上级负责人", channels: ["飞书私聊", "飞书项目群"], enabled: true },
  { id: "blocked", kind: "event", name: "阻塞升级", desc: "阻塞超过 {n} 天未解除，通知负责人和上级负责人", n: 1, unit: "天", to: "负责人、上级负责人", channels: ["飞书私聊"], enabled: true },
  { id: "review", kind: "event", name: "交付催办", desc: "等待验收或发布满 {n} 天时，向当前处理人补催一次", n: 1, unit: "天", to: "验收人或执行人", channels: ["飞书私聊"], enabled: true },
  { id: "stale", kind: "event", name: "进展更新提醒", desc: "进行中的任务 {n} 天没有更新时列入每日待办摘要", n: 3, unit: "天", to: "执行人", channels: [], delivery: "digest", enabled: true },
  { id: "start_late", kind: "event", name: "超过开工日未开始", desc: "末级任务超过计划开工日 {n} 个工作日仍未开始时列入每日待办摘要", n: 1, unit: "工作日", to: "执行人", channels: [], delivery: "digest", enabled: true },
  { id: "split_needed", kind: "event", name: "待拆解", desc: "当前迭代内计划跨度至少 {n} 个工作日、仍未拆解的需求列入每日待办摘要", n: 3, unit: "工作日", to: "需求负责人", channels: [], delivery: "digest", enabled: true },
  { id: "lag", kind: "event", name: "进度落后预警", desc: "需求或项目落后计划 {n} 个百分点时，提醒负责人并纳入周报", n: 20, unit: "百分点", to: "负责人", channels: ["飞书私聊"], enabled: true },
  { id: "conflict", kind: "event", name: "计划冲突", desc: "子任务截止日期晚于上级时列入每日待办摘要", to: "上级负责人", channels: [], delivery: "digest", enabled: true },
  { id: "assign", kind: "handoff", name: "新指派或换人", desc: "创建或换人时，只通知新接手的人", to: "新增负责人、执行人", channels: ["飞书私聊"], enabled: true },
  { id: "review_requested", kind: "handoff", name: "验收与发布交接", desc: "提交验收、待发布和待线上验收时，通知当前处理人", to: "验收人和执行人", channels: ["飞书私聊"], enabled: true },
  { id: "review_rejected", kind: "handoff", name: "验收打回", desc: "把原因和任务链接发给当前执行人", to: "执行人", channels: ["飞书私聊"], enabled: true },
  { id: "daily", kind: "schedule", name: "每日待办摘要", desc: "推送个人今日到期、待验收、待发布、阻塞和需要更新进展的事项", to: "每位成员", channels: ["飞书私聊"], enabled: true },
  { id: "weekly", kind: "schedule", name: "项目周报", desc: "自动汇总本周完成、进度、风险和下周到期事项，发送到项目群", to: "项目群", channels: ["飞书项目群"], enabled: true },
];

/** 沿用已有开关、阈值和时间。发送渠道由当前规则定义。 */
export function currentRules(saved: Rule[]): Rule[] {
  const defaults = new Set(DEFAULT_RULES.map((r) => r.id));
  return [
    ...DEFAULT_RULES.map((rule) => {
      const previous = saved.find((r) => r.id === rule.id);
      return previous ? {
        ...rule, enabled: previous.enabled, n: previous.n ?? rule.n, scheduleTime: previous.scheduleTime,
        channels: rule.channels.filter((channel) => previous.channels?.includes(channel) ?? true),
      } : { ...rule };
    }),
    ...saved.filter((rule) => !defaults.has(rule.id)),
  ];
}

export const ruleText = (r: Rule) => r.desc.replace("{n}", String(r.n ?? ""));

export interface Alert {
  id: string;
  ruleId: string;
  ruleName: string;
  itemId: string;
  level: "urgent" | "warn" | "info";
  to: string[];
  group?: string; // 同步的飞书群
  text: string;
}

export type AttentionId = "stale" | "split_needed" | "start_late";

export function isAttentionId(id: string): id is AttentionId {
  return id === "stale" || id === "split_needed" || id === "start_late";
}

function progressSince(item: WorkItem, asOf: string) {
  const dates = item.updates.filter((update) =>
    update.progress !== undefined && !update.retractedAt && update.date <= asOf).map(({ date }) => date);
  const started = item.log.findLast(({ date, text }) => date <= asOf && text === "状态改为「进行中」")?.date;
  const updated = dates.sort().at(-1);
  return { current: [updated, started].filter((date): date is string => !!date).sort().at(-1) ?? item.start, updated, started };
}

export function pendingSplit(items: Items, item: WorkItem, asOf: string, minDays: number) {
  if (item.kind !== "feature" || isInactive(items, item) || activeChildren(items, item.id).length > 0) return;
  const status = statusOf(items, item);
  if (status !== "todo" && status !== "doing") return;
  const iteration = iterationOf(items, item);
  if (!iteration || iteration.closedAt || asOf < iteration.start || asOf > iteration.end || workingDays(item.start, item.due) < minDays) return;
  const decision = item.directDelivery;
  if (decision?.owner === item.owner && decision.iterationId === iteration.id && decision.start === item.start && decision.due === item.due) return;
  return iteration;
}

const uniq = (a: (string | undefined)[]) => [...new Set(a.filter(Boolean) as string[])];

export function computeAlerts(items: Items, rules: Rule[], asOf = today()): Alert[] {
  const on = (id: string) => rules.find((r) => r.id === id && r.enabled);
  const out: Alert[] = [];
  const push = (rule: Rule, item: WorkItem, a: Omit<Alert, "id" | "ruleId" | "ruleName" | "itemId">) =>
    out.push({ id: `${rule.id}-${item.id}`, ruleId: rule.id, ruleName: rule.name, itemId: item.id, ...a });

  for (const item of items) {
    const st = statusOf(items, item);
    if (isInactive(items, item) || st === "done") continue;
    const parent = item.parentId ? byId(items, item.parentId) : undefined;
    const project = projectOf(items, item);
    const group = project.feishuGroup || project.feishuChatId;
    const leaf = isLeaf(items, item.id);
    const left = daysBetween(asOf, item.due);

    const r1 = on("due_soon");
    if (r1 && leaf && st !== "review" && left >= 0 && left <= (r1.n ?? 2))
      push(r1, item, { level: "info", to: assigneeIds(item), text: left === 0 ? "今天到期" : `还有 ${left} 天到期（${fmt(item.due)}）` });

    const r2 = on("overdue");
    if (r2 && dueStateOf(items, item, 2, asOf) === "overdue") {
      const late = -left;
      const escalate = late >= (r2.n ?? 2);
      push(r2, item, {
        level: escalate ? "urgent" : "warn",
        to: uniq([...(st === "review" ? [] : assigneeIds(item)), item.owner, escalate ? parent?.owner : undefined]),
        group: escalate ? group : undefined,
        text: `已逾期 ${late} 天${st === "review" ? "（已提交，等待验收）" : ""}${escalate && parent ? `，已升级给上级负责人 ${person(parent.owner).name}` : ""}`,
      });
    }

    const r3 = on("blocked");
    if (r3 && item.status === "blocked" && item.blockedSince && daysBetween(item.blockedSince, asOf) >= (r3.n ?? 1))
      push(r3, item, {
        level: "urgent",
        to: uniq([item.owner, parent?.owner]),
        text: `已阻塞 ${daysBetween(item.blockedSince, asOf)} 天：${item.blockedReason ?? ""}`,
      });

    const r4 = on("review");
    const since = reviewSinceOf(items, item, asOf);
    if (r4 && (st === "review" || st === "release" || st === "production-review") && since && daysBetween(since, asOf) >= (r4.n ?? 1)) {
      const to = st === "release" ? assigneeIds(item) : verifiersOf(items, item).filter((id) => verifierAllowed(item, id));
      const action = st === "release" ? "发布" : st === "production-review" ? "线上验收" : "验收";
      push(r4, item, { level: "warn", to, text: `已等待${action} ${daysBetween(since, asOf)} 天` });
    }

    const stale = on("stale");
    if (stale && leaf && item.kind !== "project" && st === "doing" && !needsSubmission(items, item) && (!item.progressRemindAt || item.progressRemindAt <= asOf)) {
      const { current, updated, started } = progressSince(item, asOf);
      const idle = daysBetween(current, asOf);
      if (idle >= (stale.n ?? 3)) {
        const since = current === updated ? `上次更新 ${fmt(current)}` : current === started ? `最近开工 ${fmt(current)}` : "尚无进展记录";
        push(stale, item, { level: "info", to: assigneeIds(item), text: `${since}，已 ${idle} 天未更新` });
      }
    }

    const startLate = on("start_late");
    if (startLate && leaf && item.kind === "task" && st === "todo" && item.start < asOf) {
      const lateDays = workingDays(dateOffset(item.start, 1), asOf);
      if (lateDays >= Math.max(1, startLate.n ?? 1)) push(startLate, item, {
        level: "info", to: assigneeIds(item), text: `计划 ${fmt(item.start)} 开工，已晚 ${lateDays} 个工作日`,
      });
    }

    const split = on("split_needed");
    const iteration = split && pendingSplit(items, item, asOf, split.n ?? 3);
    if (split && iteration) push(split, item, {
      level: "info", to: [item.owner], text: `${iteration.name} · 计划 ${workingDays(item.start, item.due)} 个工作日，尚无有效子任务`,
    });

    const r6 = on("lag");
    if (r6 && !leaf) {
      const plan = plannedProgress(item, asOf);
      const real = progressOf(items, item);
      if (plan - real >= (r6.n ?? 20))
        push(r6, item, { level: "warn", to: [item.owner], text: `实际进度 ${real}%，按计划应达 ${plan}%，落后 ${plan - real}%` });
    }

    const r7 = on("conflict");
    if (r7 && !leaf)
      for (const k of childrenOf(items, item.id))
        if (!isInactive(items, k) && k.due > item.due && statusOf(items, k) !== "done")
          push(r7, k, { level: "warn", to: [item.owner], text: `截止 ${fmt(k.due)} 晚于上级「${item.title}」的截止 ${fmt(item.due)}` });
  }
  const order = { urgent: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
}
