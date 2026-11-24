// 飞书推送与应用内预览使用同一份报告。
import { canSee, visibleProjects, type Account } from "./access";
import { computeAlerts, type Alert } from "./alerts";
import { assigneeNames, dateOffset, daysBetween, fmt, isAssignee, person, statusLabel, today, type WorkItem } from "./model";
import { descendants, isLeaf, plannedProgress, progressOf, projectOf, statusOf, isCancelled, projectWorkCounts, type Items } from "./tree";
import { myQueue } from "./queue";
import type { AppState } from "./state";

export interface ReportLine {
  text: string;
  itemId?: string;
  updateId?: string;
  tone?: "red" | "amber";
  status?: string;
  context?: string;
  detail?: string;
}

export interface ReportSection {
  heading: string;
  format?: "plain";
  variant?: "focus" | "handoff" | "progress";
  progress?: { actual: number; plan: number };
  lines: ReportLine[];
}

export interface Report {
  title: string;
  to: string;
  tone?: "neutral" | "blue" | "purple" | "orange" | "red";
  subtitle?: string;
  action?: { label: string; itemId?: string; updateId?: string; tab?: "quality" };
  sections: ReportSection[];
}

function displayDate(date: string) {
  const [, month, day] = date.split("-").map(Number);
  return `${month} 月 ${day} 日`;
}

function reportWeek(asOf: string) {
  const monday = dateOffset(asOf, -((new Date(`${asOf}T12:00:00Z`).getUTCDay() + 6) % 7));
  return {
    includes: (date?: string) => !!date && date >= monday && date <= asOf,
    subtitle: monday === asOf ? `截至 ${displayDate(asOf)}` : `${displayDate(monday)}至 ${displayDate(asOf)}`,
  };
}

function projectWeeklySections(items: Items, project: WorkItem, alerts: Alert[], asOf: string) {
  const all = descendants(items, project.id).filter((x) => !isCancelled(items, x));
  const ids = new Set([project.id, ...all.map((x) => x.id)]);
  const week = reportWeek(asOf);
  const doneThisWeek = all.filter((x) => week.includes(x.doneAt) && statusOf(items, x) === "done");
  const nextWeek = all.filter((x) => isLeaf(items, x.id) && statusOf(items, x) !== "done" && daysBetween(asOf, x.due) >= 0 && daysBetween(asOf, x.due) <= 7)
    .sort((a, b) => a.due.localeCompare(b.due));
  const risks = alerts.filter((a) => ids.has(a.itemId) && a.level !== "info");
  const byItem = new Map<string, Alert>();
  for (const risk of risks) if (!byItem.has(risk.itemId)) byItem.set(risk.itemId, risk);
  const itemTitle = (id: string) => items.find((x) => x.id === id)?.title ?? id;
  const concerns: ReportLine[] = [...byItem.values()].map((a) => ({
    text: itemTitle(a.itemId), status: a.ruleName, detail: a.text, itemId: a.itemId, tone: a.level === "urgent" ? "red" : "amber",
  }));
  concerns.push(...nextWeek.filter((x) => !byItem.has(x.id)).map((x) => ({
    text: x.title, itemId: x.id, status: `${fmt(x.due)} 到期`, context: assigneeNames(x),
  })));
  return {
    week, all,
    deliveries: { heading: `本周交付 · ${doneThisWeek.length} 项`, lines: doneThisWeek.map((x) => ({ text: x.title, context: assigneeNames(x), itemId: x.id })) },
    concerns: { heading: `下周关注 · ${concerns.length} 项`, lines: concerns },
  };
}

export function weeklyReport(items: Items, project: WorkItem, alerts: Alert[], asOf = today()): Report {
  const { week, deliveries, concerns } = projectWeeklySections(items, project, alerts, asOf);
  return {
    title: `${project.title} · 项目周报`, subtitle: week.subtitle, tone: "neutral",
    to: project.feishuGroup ?? "项目群", action: { label: "查看项目进展", itemId: project.id },
    sections: [
      { heading: "整体进度", variant: "progress", progress: { actual: progressOf(items, project), plan: plannedProgress(project, asOf) }, lines: [] },
      deliveries, concerns,
    ],
  };
}

const PROGRESS_EVENTS = /^(状态改为「(?:未开始|进行中|阻塞|已完成)」|提交验收，交付物：|测试验收(?:通过|打回)|线上验收(?:通过|打回)|已发布到生产：)/;

function weeklyProgressLine(items: Items, item: WorkItem, week: ReturnType<typeof reportWeek>, me?: string): ReportLine | undefined {
  const ownWork = !me || item.owner === me || isAssignee(item, me);
  const status = statusOf(items, item);
  const done = ownWork && status === "done" && week.includes(item.doneAt);
  const note = item.updates.toReversed()
    .filter((update) => !update.retractedAt && week.includes(update.date) && (!me ||
      (update.by === me && (ownWork || item.kind === "project" || update.progress !== undefined))))
    .sort((a, b) => b.date.localeCompare(a.date) || (b.at ?? "").localeCompare(a.at ?? ""))[0];
  const event = ownWork ? item.log.findLast((entry) =>
    (!me || entry.by === me) && week.includes(entry.date) && PROGRESS_EVENTS.test(entry.text)) : undefined;
  if (!done && !note && !event) return undefined;

  return {
    itemId: item.id,
    text: item.title,
    status: item.kind === "project" ? "项目进展" : status === "done" ? "已完成" : `${statusLabel(status, item)} · ${progressOf(items, item)}%`,
    detail: note?.text.trim() || (!done ? event?.text : undefined),
  };
}

export function personalWeeklyActivity(items: Items, account: Account, asOf = today()) {
  const week = reportWeek(asOf);
  return visibleProjects(items, account).flatMap((project) => {
    const lines = [project, ...descendants(items, project.id)].flatMap((item) => {
      const line = !isCancelled(items, item) && weeklyProgressLine(items, item, week, account.id);
      return line ? [line] : [];
    });
    return lines.length ? [{ id: project.id, title: project.title, lines }] : [];
  });
}

export function personalWeeklyReport(
  activity: ReturnType<typeof personalWeeklyActivity>, name: string, project?: Pick<WorkItem, "id" | "title">, asOf = today(),
): Report {
  const included = project ? activity.filter(({ id }) => id === project.id) : activity;
  return {
    title: project ? `${name} · 个人周报 · ${project.title}` : `${name} · 个人周报`,
    subtitle: reportWeek(asOf).subtitle,
    to: name,
    tone: "neutral",
    sections: included.map(({ title, lines }) => ({ heading: `${project ? "本周进展" : title} · ${lines.length} 项`, lines })),
  };
}

export function projectWeeklyPreview(items: Items, project: WorkItem, alerts: Alert[], asOf = today()): Report {
  const { week, all, deliveries, concerns } = projectWeeklySections(items, project, alerts, asOf);
  const deliveredIds = new Set(deliveries.lines.map(({ itemId }) => itemId));
  const progress = [project, ...all].flatMap((item) => {
    if (deliveredIds.has(item.id) || isCancelled(items, item)) return [];
    const line = weeklyProgressLine(items, item, week);
    return line ? [{ ...line, context: item.kind === "project" ? undefined : assigneeNames(item) }] : [];
  });
  const { doing, todo } = projectWorkCounts(items, project.id);
  return {
    title: `${project.title} · 项目周报`, subtitle: week.subtitle, tone: "neutral",
    to: project.feishuGroup ?? "项目群",
    sections: [
      { heading: "需求与任务", lines: [{ text: `进行中 ${doing} 项，未开始 ${todo} 项` }] },
      deliveries,
      { heading: `本周进展 · ${progress.length} 项`, lines: progress },
      concerns,
    ],
  };
}

export function reportPlainText(report: Report): string {
  const header = [report.title, report.subtitle].filter(Boolean).join("\n");
  const sections = report.sections.filter(({ lines }) => lines.length > 0).map(({ heading, lines }) => [
    heading,
    ...lines.map(({ text, status, context, detail }) => {
      const message = `- ${[text, status, context].filter(Boolean).join(" · ")}`;
      return detail ? `${message}\n  ${detail.replaceAll("\n", "\n  ")}` : message;
    }),
  ].join("\n"));
  return [header, ...sections].join("\n\n");
}

type DigestState = Pick<AppState, "items" | "accounts" | "rules" | "people">;

export function dailyDigest(
  state: DigestState, me: string, asOf = today(), excluded: ReadonlySet<string> = new Set(),
  alerts = computeAlerts(state.items, state.rules, asOf),
): Report {
  const queue = myQueue(state, me, asOf, alerts);
  const acc = state.accounts.find((a) => a.id === me);
  const enabled = new Set(state.rules.filter((r) => r.enabled).map((r) => r.id));
  const signals = new Map<string, Alert[]>();
  for (const alert of alerts) {
    if (alert.to.includes(me)) signals.set(alert.itemId, [...(signals.get(alert.itemId) ?? []), alert]);
  }
  const entries = queue.flatMap(({ x, reasons }) => {
    if (excluded.has(x.id)) return [];
    const actionable = reasons.find((r) => r.rank === 0 || ["100% 未提交", "被打回待修改", "无人负责"].includes(r.text) ||
      (r.text === "阻塞中" && enabled.has("blocked")));
    // 获派执行和需要验收等待办，与规则阈值计算出的风险只保留一个当前动作。
    const alerts = signals.get(x.id) ?? [];
    const urgent = alerts.find((a) => a.level !== "info" && a.ruleId !== "lag");
    const attention = reasons.find((reason) => reason.attention);
    const signal = urgent ?? alerts.find((alert) => alert.ruleId === attention?.attention) ?? alerts[0];
    if (!actionable && !signal) return [];
    const priority = actionable ? (actionable.tone === "red" || actionable.rank === 0 ? 0 : 1)
      : urgent ? 1 : signal?.ruleId === "due_soon" && x.due === asOf ? 1 : 2;
    const status = actionable?.text ?? (signal?.ruleId === "due_soon" ? signal.text : signal?.ruleName);
    const line: ReportLine = {
      text: x.title, itemId: x.id, status, context: projectOf(state.items, x).title,
      detail: [...new Set([actionable?.detail, signal && signal.text !== status ? signal.text : undefined,
        signal?.ruleId !== attention?.attention ? attention?.detail : undefined].filter(Boolean))].join(" · ") || undefined,
      tone: signal?.level === "urgent" ? "red" : priority <= 1 ? "amber" : undefined,
    };
    return [{ line, priority, due: x.due }];
  });
  // 项目负责人以外的需求负责人也能看到属于自己的风险或计划冲突。
  const represented = new Set(entries.map(({ line }) => line.itemId));
  if (acc?.active) {
    for (const [id, alerts] of signals) {
      if (represented.has(id) || excluded.has(id)) continue;
      const item = state.items.find((x) => x.id === id);
      if (!item || !canSee(state.items, item, acc)) continue;
      const alert = alerts[0];
      entries.push({ line: {
        text: item.title, itemId: id, context: projectOf(state.items, item).title, status: alert.ruleName, detail: alert.text,
        tone: alert.level === "urgent" ? "red" : undefined,
      }, priority: alert.level === "urgent" ? 1 : 2, due: item.due });
    }
  }
  entries.sort((a, b) => a.priority - b.priority || a.due.localeCompare(b.due));
  const first = entries[0]?.priority < 2 ? entries[0] : undefined;
  const rest = entries.slice(first ? 1 : 0);
  return {
    title: "今日待办", subtitle: displayDate(asOf), to: `${person(me).name}（私聊）`, tone: "neutral",
    action: { label: entries.length ? `查看 ${entries.length} 项待办` : "打开工作台" },
    sections: [
      ...(first ? [{ heading: "优先处理", variant: "focus" as const, lines: [first.line] }] : []),
      ...(rest.length ? [{ heading: `${first ? "还有 " : ""}${rest.length} 项待处理`, lines: rest.map(({ line }) => line) }] : []),
    ],
  };
}
