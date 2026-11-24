import { computeAlerts, scheduleTime, SCHEDULE_MIN, QUIET_START, type Alert, type ScheduleId } from "../alerts";
import { canSee, verifierAllowed } from "../access";
import { appTimezone, assigneeIds, dateOffset, requiresProduction, today } from "../model";
import { dailyDigest, weeklyReport, type Report, type ReportSection } from "../report";
import type { AppState } from "../state";
import { isInactive, isLeaf, projectOf, reviewSinceOf, statusOf } from "../tree";

import { reviewCycle, type Handoff } from "./handoff";

export interface Notice {
  type: "handoff" | "mention" | "defect" | "event" | "daily" | "weekly" | "test" | "deployment";
  objectId: string;
  recipient: string;
  window: string;
  level: Alert["level"];
  report: Report;
  itemId?: string;
  updateId?: string;
  handoff?: Handoff;
  expires?: string;
  actorId?: string;
}
export const noticeKey = (n: Pick<Notice, "type" | "objectId" | "recipient">) => JSON.stringify([n.type, n.objectId, n.recipient]);
export function localTime(now: Date, zone = appTimezone()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const part = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const date = today(now, zone);
  return { date, minute: part("hour") * 60 + part("minute"), weekday: new Date(`${date}T12:00:00Z`).getUTCDay() };
}
function minuteOf(time: string) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

export function maySend(level: Alert["level"], now: Date, zone = appTimezone()) {
  const { minute, weekday } = localTime(now, zone);
  return minute >= minuteOf(SCHEDULE_MIN) && minute < minuteOf(QUIET_START) && ((weekday !== 0 && weekday !== 6) || level === "urgent");
}
/** 启动/短暂故障可在当天允许发送的时间内补发；不补发历史日报和周报。 */
export function scheduleDue(type: ScheduleId, now: Date, zone = appTimezone(), configuredTime?: string) {
  const { minute, weekday } = localTime(now, zone);
  if (minute < minuteOf(scheduleTime(type, configuredTime)) || minute >= minuteOf(QUIET_START)) return false;
  return type === "daily" ? weekday >= 1 && weekday <= 5 : weekday === 5;
}
export function planRiskNotices(state: AppState, now: Date, alerts = computeAlerts(state.items, state.rules, localTime(now).date)): Notice[] {
  const { date, weekday } = localTime(now);
  const out: Notice[] = [];
  const items = new Map(state.items.map((item) => [item.id, item]));
  const accounts = new Map(state.accounts.map((a) => [a.id, a]));
  for (const alert of alerts) {
    const item = items.get(alert.itemId)!;
    const rule = state.rules.find((r) => r.id === alert.ruleId && r.enabled);
    if (!rule || rule.delivery === "digest" || ["due_soon", "stale", "conflict"].includes(rule.id)) continue;
    const project = projectOf(state.items, item);
    const status = statusOf(state.items, item);
    const parent = item.parentId ? items.get(item.parentId) : undefined;
    const add = (id: string, recipient: string, window: string, title: string, level = alert.level) => {
      const action = rule.id === "review" ? (status === "release" ? "查看待发布需求" : status === "production-review" ? "去线上验收" : "去验收") : id === "overdue_escalated" ? "查看逾期事项" : "查看工作项";
      const detail = recipient.startsWith("chat:") && id === "overdue_escalated"
        ? `${alert.text}。请项目负责人确认交付日期或安排协助。` : alert.text;
      out.push({
        type: "event", objectId: `${id}:${item.id}`, recipient, window, level, itemId: item.id,
        report: { title, to: recipient, tone: level === "urgent" ? "red" : "orange",
          action: { label: action, itemId: item.id },
          sections: [{ heading: title, variant: "handoff", lines: [{
            text: item.title, detail, context: project.title, itemId: item.id,
          }] }],
        },
      });
    };
    const allowed = (id: string) => {
      const account = accounts.get(id);
      return !!account && canSee(state.items, item, account);
    };
    if (rule.id === "overdue") {
      const initial = new Set(status === "review" ? [item.owner] : [...assigneeIds(item), item.owner]);
      if (rule.channels.includes("飞书私聊")) {
        for (const id of initial) {
          if (!allowed(id)) continue;
          add("overdue", `account:${id}`, item.due, status === "review" ? "交付超期，正在验收" : "工作项已逾期");
        }
        if (alert.level === "urgent" && parent?.owner && !initial.has(parent.owner) && allowed(parent.owner)) {
          add("overdue_escalated", `account:${parent.owner}`, item.due, "逾期升级");
        }
      }
      if (alert.level === "urgent" && rule.channels.includes("飞书项目群") && project.feishuChatId) {
        add("overdue_escalated", `chat:${project.feishuChatId}`, item.due, "逾期升级");
      }
      continue;
    }
    if (!rule.channels.includes("飞书私聊")) continue;
    for (const id of new Set(alert.to)) {
      if (!allowed(id)) continue;
      if (rule.id === "review") {
        const since = reviewSinceOf(state.items, item, date);
        const cycle = isLeaf(state.items, item.id) || requiresProduction(item) ? reviewCycle(item, since) : since ?? item.id;
        if (status === "release" || verifierAllowed(item, id)) {
          add(rule.id, `account:${id}`, cycle, status === "release" ? "等待发布超时" : status === "production-review" ? "线上验收超时" : "验收超时");
        }
      } else if (rule.id === "blocked") {
        const last = item.log.findLast((entry) => entry.action === "blocked");
        add(rule.id, `account:${id}`, last?.at ?? item.blockedSince ?? date, "阻塞需要协调");
      } else if (rule.id === "lag") {
        add(rule.id, `account:${id}`, dateOffset(date, -((weekday + 6) % 7)), "进度落后");
      }
    }
  }
  return out;
}

type Coverage = Map<string, Set<string>>;
export function addCoverage(coverage: Coverage, notice: Notice) {
  if (notice.type !== "event" && notice.type !== "handoff") return;
  if (!notice.itemId) return;
  const ids = coverage.get(notice.recipient) ?? new Set<string>();
  ids.add(notice.itemId);
  coverage.set(notice.recipient, ids);
}

export function planNotifications(state: AppState, now: Date, options?: { actionable: Notice[]; covered: Coverage }): Notice[] {
  const date = localTime(now).date;
  const alerts = computeAlerts(state.items, state.rules, date);
  const actionable = options?.actionable ?? planRiskNotices(state, now, alerts);
  const covered = options?.covered ?? new Map();
  for (const notice of actionable) if (maySend(notice.level, now)) addCoverage(covered, notice);
  const on = (id: string) => state.rules.find((r) => r.id === id && r.enabled);
  const out = [...actionable];
  const daily = on("daily");
  const weekly = on("weekly");
  const zone = appTimezone();
  if (daily?.channels.includes("飞书私聊") && scheduleDue("daily", now, zone, daily.scheduleTime)) {
    for (const account of state.accounts.filter((a) => a.active)) {
      const recipient = `account:${account.id}`;
      const report = dailyDigest(state, account.id, date, covered.get(recipient), alerts);
      if (report.sections.some((section) => section.lines.length)) {
        out.push({ type: "daily", objectId: account.id, recipient, window: date, level: "info", report });
      }
    }
  }
  if (weekly?.channels.includes("飞书项目群") && scheduleDue("weekly", now, zone, weekly.scheduleTime)) {
    for (const project of state.items.filter((x) => x.kind === "project" && x.feishuChatId && !isInactive(state.items, x))) {
      out.push({ type: "weekly", objectId: project.id, recipient: `chat:${project.feishuChatId}`, window: date, level: "info",
        report: weeklyReport(state.items, project, alerts, date), itemId: project.id });
    }
  }
  return out;
}

function priority(notice: Notice) {
  if (notice.handoff?.kind === "review_rejected") return 0;
  if (["review_requested", "release_requested", "production_review_requested"].some((kind) => kind === notice.handoff?.kind)) return 1;
  if (notice.handoff?.kind === "assign") return 2;
  if (notice.type === "event") return notice.level === "urgent" ? 3 : 4;
  return 5;
}

export function mergeNotices(notices: Notice[]): Report {
  if (notices.length === 1) return notices[0].report;
  const ordered = [...notices].sort((a, b) => priority(a) - priority(b));
  const sections: ReportSection[] = [];
  const covered = new Set<string>();
  for (const notice of ordered) {
    for (const section of notice.report.sections) {
      const lines = section.lines.filter((line) => {
        if (!line.itemId) return true;
        const key = notice.type === "mention" ? notice.objectId : line.itemId;
        if (covered.has(key)) return false;
        covered.add(key);
        return true;
      });
      if (!lines.length && !section.progress) continue;
      const heading = notice.type === "weekly" ? `${notice.report.title} · ${section.heading}` : section.heading;
      const existing = !section.progress && sections.find((s) => s.heading === heading && s.variant === section.variant);
      if (existing) existing.lines.push(...lines);
      else sections.push({ ...section, heading, lines });
    }
  }
  const lead = ordered[0];
  if (sections.length === 1 && sections[0].lines.length === 1) return { ...lead.report, sections };
  const red = ordered.some((notice) => notice.report.tone === "red");
  return {
    title: "Arbor 工作提醒", to: lead.recipient, tone: red ? "red" : "neutral",
    action: { label: lead.recipient.startsWith("chat:") ? "打开 Arbor" : "打开工作台" }, sections,
  };
}
