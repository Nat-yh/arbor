"use client";

import { CalendarClock, CalendarDays, Check, ChevronRight, CircleAlert, ClipboardCheck, Clock3, FolderOpen, ListTodo, ListTree, Newspaper, Pencil, Play, RefreshCw, ShieldAlert, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { StartActionButton, UpdateActionButton } from "@/components/ActionFeedback";
import StateBoundary from "@/components/StateBoundary";
import { usePeek } from "@/components/Peek";
import { AssigneeAvatars, DueCell, StatusCell } from "@/components/pickers";
import { useToast } from "@/components/Toast";
import { QuickProgress } from "@/components/ProgressEditor";
import ReviewSubmission from "@/components/ReviewSubmission";
import WorkItemForm from "@/components/WorkItemForm";
import { WorkAttentionDialog, WorkAttentionRow } from "@/components/WorkAttention";
import { WeeklyReportDialog, WeeklyReportNotice } from "@/components/WeeklyReport";
import { Badge, DueText, ItemTypeBadge, PageHeader, ProjectWorkCounts, StatusIcon, btn, btn2, cx, iconBtn, sm } from "@/components/ui";
import { canEditPlan, canManage, canVerifyDelivery } from "@/lib/access";
import { assigneeIds, isAssignee, isPublishing, person, requiresProduction, today, type WorkItem } from "@/lib/model";
import { describeQueueReason, myQueue, type QueueEntry } from "@/lib/queue";
import { useStore } from "@/lib/store";
import { ancestors, isInactive, isLeaf, statusOf } from "@/lib/tree";

const TONE = {
  red: "bg-danger-soft text-danger",
  amber: "bg-warn-soft text-warn",
  dark: "bg-accent-soft text-accent-fg",
  muted: "bg-sunken text-fg-3",
};

const listViewport = "max-h-[clamp(14rem,52dvh,27rem)] overflow-auto";

type GroupAppearance = {
  title: string;
  icon: LucideIcon;
  tone?: "urgent" | "action";
  reminder?: boolean;
};

const GROUPS = {
  review: { title: "等我验收或发布", icon: ClipboardCheck, tone: "action" },
  urgent: { title: "需要马上处理", icon: CircleAlert, tone: "urgent" },
  risk: { title: "我负责的项目风险", icon: ShieldAlert },
  startLate: { title: "超过开工日未开始", icon: CalendarClock, tone: "urgent", reminder: true },
  stale: { title: "待更新进展", icon: RefreshCw, tone: "action", reminder: true },
  split: { title: "待拆解", icon: ListTree, reminder: true },
  dueSoon: { title: "快到期", icon: CalendarDays },
  active: { title: "进行中 / 未开始", icon: ListTodo },
  waiting: { title: "等待验收或发布", icon: Clock3 },
} as const satisfies Record<string, GroupAppearance>;

const groupHeader = "flex h-8 items-center gap-2 px-3 text-xs font-medium";
const groupIcon = "size-3.5 shrink-0";

function attentionFor({ r, reasons }: QueueEntry) {
  if (r.rank === 0) return;
  return reasons.find((reason) => reason.attention === "split_needed") ?? reasons.find((reason) => reason.attention);
}

function queueGroup(entry: QueueEntry): keyof typeof GROUPS {
  const { r } = entry;
  const attention = attentionFor(entry)?.attention;
  if (attention === "start_late") return "startLate";
  if (attention === "stale") return "stale";
  if (attention === "split_needed") return "split";
  if (r.rank === 0) return "review";
  if (r.rank === 1 && !r.management) return "urgent";
  if (r.management) return "risk";
  if (r.rank === 2) return "dueSoon";
  if (r.rank === 5) return "waiting";
  return "active";
}

export default function Dashboard() {
  return <StateBoundary><DashboardContent /></StateBoundary>;
}

function DashboardContent() {
  const store = useStore();
  const { items, me, setStatus, projects, acc } = store;
  const toast = useToast();
  const peek = usePeek();
  const [showWeekly, setShowWeekly] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = editingId ? items.find((item) => item.id === editingId) : undefined;
  const [updating, setUpdating] = useState<WorkItem | null>(null);
  const [attentionAction, setAttentionAction] = useState<{ item: WorkItem; action: "block" | "defer" | "direct" } | null>(null);
  const showWeeklyEntry = store.can("projects") && !store.practice;
  const todo = myQueue(store, me, today(), store.alerts);
  const urgent = todo.filter((e) => e.r.rank <= 2).length;
  const groups = Object.entries<GroupAppearance>(GROUPS)
    .map(([id, appearance]) => ({ id, ...appearance, entries: todo.filter((entry) => queueGroup(entry) === id) }))
    .filter(({ entries }) => entries.length);
  const myProjects = projects.filter((p) => !p.archivedAt && p.status !== "cancelled");
  const date = new Date(`${today()}T00:00:00Z`);
  const dateLabel = `${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日 周${"日一二三四五六"[date.getUTCDay()]}`;

  const rows = (entries: QueueEntry[]) => (
    <ul className={cx(listViewport, "divide-y divide-line")}>
      {entries.map((entry) => {
        const { x, r, reasons } = entry;
        const attention = attentionFor(entry);
        if (attention) return <WorkAttentionRow key={x.id} item={x} reason={attention}
          risk={r !== attention && r.rank === 1 && !r.attention ? r.text : undefined}
          onUpdate={() => setUpdating(x)} onAction={(action) => setAttentionAction({ item: x, action })} />;
        const status = statusOf(items, x);
        const details = [...new Set([r.detail, status === "blocked" ? x.blockedReason : undefined, ...reasons.filter((reason) => reason !== r).map(describeQueueReason)].filter(Boolean))].join("；");
        const review = status === "review" && r.rank === 0 && (isLeaf(items, x.id) || requiresProduction(x)) && canVerifyDelivery(items, x, acc);
        const path = ancestors(items, x).map((a) => a.title).join(" / ");
        return (
          <li key={x.id} onClick={() => peek.open(x.id, review)} className="dashboard-queue-row cursor-pointer px-3 py-2 transition-colors hover:bg-hover">
            <div className="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-2">
              <div className="flex h-5 items-center"><StatusCell item={x} label={false} /></div>
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <ItemTypeBadge items={items} item={x} />
                <Link data-guide-item={x.id} href={`/item/${x.id}${review ? `?review=${encodeURIComponent(x.id)}` : ""}`}
                  onClick={(e) => { e.stopPropagation(); peek.onLinkClick(x.id, review)(e); }}
                  title={x.title} className="min-w-0 max-w-full truncate font-medium hover:underline">{x.title}</Link>
                {r.tone !== "muted" && <Badge className={cx("shrink-0", TONE[r.tone])}>{r.text}</Badge>}
              </div>
              <div className="flex h-5 items-center justify-end gap-2.5"><DueCell item={x} /><AssigneeAvatars ids={assigneeIds(x)} /></div>
            </div>
            <div className="dashboard-queue-meta ml-6 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <div className="min-w-0 flex-1">
                {(details || path) && <p className="truncate text-xs text-fg-3" title={[details, path].filter(Boolean).join(" · ")}>
                  {details}{details && path && " · "}{path && <span className="text-fg-4">{path}</span>}
                </p>}
                {review && isLeaf(items, x.id) && <ReviewSubmission item={x} inline />}
              </div>
              <div className="dashboard-queue-actions ml-auto flex shrink-0 items-center justify-end gap-1.5">
                {status === "todo" && x.kind !== "project" && isLeaf(items, x.id) && (isAssignee(x, me) || canManage(items, x, acc)) && (
                  <StartActionButton onStart={async (feedback) => { if ((await setStatus(x.id, "doing", undefined, feedback)).ok) toast("已开始", x.title); }} className={cx(btn, sm)}><Play />开始</StartActionButton>
                )}
                {!isInactive(items, x) && (x.kind === "project" || (isLeaf(items, x.id) && !isPublishing(status) && !["done", "review"].includes(status))) && (isAssignee(x, me) || canManage(items, x, acc)) && (
                  <UpdateActionButton className={cx(btn2, sm)} onActivate={() => setUpdating(x)}>{x.kind === "project" ? "写记录" : "更新"}</UpdateActionButton>
                )}
                {!isInactive(items, x) && canEditPlan(items, x, acc) && (
                  <button type="button" aria-label={`编辑 ${x.title}`} title="编辑" className={iconBtn} onClick={(event) => { event.stopPropagation(); setEditingId(x.id); }}><Pencil /></button>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );

  const renderGroup = ({ id, title, entries, icon: Icon, tone }: typeof groups[number]) => {
    const urgent = tone === "urgent";
    const heading = cx(groupHeader, urgent ? "bg-amber-50 text-amber-900" : "bg-canvas text-fg-2");
    const label = <>
      <Icon aria-hidden="true" className={cx(groupIcon, urgent ? "text-amber-700" : tone === "action" ? "text-accent-fg" : "text-fg-3")} />
      <span>{title}</span>
      <Badge className={urgent ? "bg-amber-100 text-amber-900" : undefined}>{entries.length}</Badge>
    </>;
    return id === "waiting" ? (
      <details key={id} className="group/wait overflow-hidden rounded-lg border border-line bg-surface">
        <summary className={cx(heading, "cursor-pointer list-none hover:bg-hover")}>
          {label}
          <ChevronRight aria-hidden="true" className="ml-auto size-3.5 text-fg-3 transition-transform group-open/wait:rotate-90" />
        </summary>
        <div className="border-t border-line">{rows(entries)}</div>
      </details>
    ) : (
      <section key={id} className="overflow-hidden rounded-lg border border-line bg-surface">
        <h2 className={cx(heading, "border-b border-line")}>{label}</h2>
        {rows(entries)}
      </section>
    );
  };
  const tasks = groups.filter(({ reminder }) => !reminder);
  const reminders = groups.filter(({ reminder }) => reminder);

  return (
    <div className="dashboard-workspace @container mx-auto max-w-[72rem] text-[13px]">
      <PageHeader title={`你好，${person(me).name}`} desc={dateLabel} action={showWeeklyEntry && (
        <button type="button" className={btn2} onClick={() => setShowWeekly(true)}><Newspaper />我的周报</button>
      )} />
      {todo.length > 0 && (
        <div className="-mt-3 mb-5 flex flex-wrap items-center gap-2">
          {urgent > 0 && <Badge className="bg-accent-soft text-accent-fg">优先 {urgent} 件</Badge>}
          <Badge>共 {todo.length} 件</Badge>
        </div>
      )}
      {showWeeklyEntry && <WeeklyReportNotice key={me} accountId={me} />}
      {showWeeklyEntry && showWeekly && <WeeklyReportDialog key={me} onClose={() => setShowWeekly(false)} />}
      {editing && <WorkItemForm key={editing.id} item={editing} onDone={() => setEditingId(null)} />}
      {updating && <QuickProgress key={updating.id} item={updating} onClose={() => setUpdating(null)} />}
      {attentionAction && <WorkAttentionDialog key={`${attentionAction.item.id}-${attentionAction.action}`} {...attentionAction}
        onClose={() => setAttentionAction(null)} />}

      <div className={cx("dashboard-layout grid items-start gap-4", !!tasks.length && "dashboard-layout-split")}>
        {(!todo.length || !!tasks.length) && <section aria-label="待我处理" className="min-w-0 space-y-4">
          {tasks.map(renderGroup)}
          {!todo.length && (
            <div className="flex flex-col items-center gap-2 rounded-lg border border-line bg-surface px-4 py-12 text-center">
              <Check className="mb-1 h-6 w-6 text-ok" />
              <p className="font-medium">当前没有待处理事项</p>
            </div>
          )}
        </section>}

        <aside aria-label="提醒与项目" className="min-w-0 space-y-3">
          {reminders.map(renderGroup)}
          <section aria-labelledby="dashboard-projects-title" className="min-w-0 overflow-hidden rounded-lg border border-line bg-surface">
            <h2 id="dashboard-projects-title" className={cx(groupHeader, "border-b border-line bg-canvas text-fg-2")}>
              <FolderOpen aria-hidden="true" className={cx(groupIcon, "text-fg-3")} />
              我参与的项目 {myProjects.length > 0 && <Badge>{myProjects.length}</Badge>}
            </h2>
            <div className={cx(listViewport, "divide-y divide-line")}>
              {myProjects.length ? myProjects.map((p) => (
                <Link key={p.id} href={`/item/${p.id}`}
                  className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 px-3 py-2 transition-colors hover:bg-hover">
                  <StatusIcon s={statusOf(items, p)} />
                  <span className="min-w-0 truncate font-medium" title={p.title}>{p.title}</span>
                  <DueText items={items} item={p} className="justify-self-end" />
                  <div className="col-span-2 col-start-2"><ProjectWorkCounts items={items} projectId={p.id} /></div>
                </Link>
              )) : <p className="px-3 py-5 text-xs text-fg-4">还没有参与的项目</p>}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}
