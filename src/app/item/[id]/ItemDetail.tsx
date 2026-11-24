"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { AttachmentComposer, AttachmentList } from "@/components/Attachments";
import { DefectDialog } from "@/components/DefectDialog";
import { ProgressEditor } from "@/components/ProgressEditor";
import { MentionInput, type Mentions } from "@/components/MentionInput";
import { MentionText } from "@/components/MentionText";
import { Archive, BellRing, Bug, CalendarRange, Check, ChevronRight, Clock, Eye, GitBranch, GitPullRequest, Hand, Link2, ListChecks, ListTree, MessageSquareText, MoreHorizontal, Newspaper, OctagonAlert, PartyPopper, Pencil, Play, Plus, RotateCcw, Send, Settings2, Sparkles, Trash2, Undo2, X, XCircle, type LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useToast } from "@/components/Toast";
import { LifecycleDialog, useLifecycle, type LifecycleAction } from "@/components/ItemLifecycle";
import { WeeklyReportDialog } from "@/components/WeeklyReport";
import WorkTree from "@/components/WorkTree";
import ReviewSubmission from "@/components/ReviewSubmission";
import { ProductionStep } from "@/components/ProductionStep";
import WorkItemForm from "@/components/WorkItemForm";
import { TabBar } from "@/components/TabBar";
import { ActionFeedback, LiquidButtonFace, StartActionButton, UpdateActionButton, useActionFeedback } from "@/components/ActionFeedback";
import { IterationCell, ProjectIterations, hasIterations } from "@/components/Iterations";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Modal, ModalFooter, Pop, PopContent, PopTrigger, Select, Tip } from "@/components/kit";
import { DateField, DueCell, PersonCell, PersonPicker, PersonSelect, StatusCell } from "@/components/pickers";
import { AiBadge, Avatar, AvatarStack, Badge, Card, Empty, ItemTypeBadge, LEVEL_CLS, NoAccess, People, Progress, ProjectWorkCounts, btn, btn2, btnGhost, cx, field, iconBtn, sm } from "@/components/ui";
import { canAddChild, canAddItemScreenshots, canEditPlan, canMaintainDefect, canManage, canSee, canVerify, canVerifyDelivery, membersOf, verifierAllowed } from "@/lib/access";
import { assigneeNames, isAssignee, isPublishing, daysBetween, fmt, hasAcceptanceCriteria, PEOPLE, person, today, requiresProduction, usesAcceptanceCriteria, type CheckItem, type Milestone, type Update, type WorkItem } from "@/lib/model";
import { editableUpdate, updateKey } from "@/lib/updates";
import { readableLog } from "@/lib/changes";
import { REPO_PROVIDERS, REPO_PROVIDER_LABELS, isRepoProvider, repoLabel, type RepoProvider } from "@/lib/repo-providers";
import { branchNameFor } from "@/lib/gitea";
import { useStore } from "@/lib/store";
import { isInactive, needsSubmission, openChecks, aiOf, ancestors, autoCheck, descendants, estimateOf, hasBlocked, isLeaf, levelLabel, plannedProgress, progressOf, statusOf, verifiersOf, visibleChecks, type Items } from "@/lib/tree";

type Tab = "子任务" | "迭代" | "检查项" | "动态" | "缺陷" | "AI 评测" | "设置";

const tabIcons: Record<Tab, LucideIcon> = {
  子任务: ListTree,
  迭代: CalendarRange,
  检查项: ListChecks,
  动态: MessageSquareText,
  缺陷: Bug,
  "AI 评测": Sparkles,
  设置: Settings2,
};

export default function ItemDetail() {
  const { id } = useParams<{ id: string }>();
  return <ItemView id={id} mode="page" />;
}

/** 工作项详情：整页和侧边抽屉共用 */
export function ItemView({ id, mode }: { id: string; mode: "page" | "peek" }) {
  const { items, get, alerts, acc, setStatus, practice, workspaceKey } = useStore();
  const searchParams = useSearchParams();
  const [completionOpen, setCompletionOpen] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const [submitPrompt, setSubmitPrompt] = useState(0);
  const item = get(id);
  const [tab, setTab] = useState<Tab | null>(null);
  const [activityOpen, setActivityOpen] = useState(false);
  const composeButton = useRef<HTMLButtonElement>(null);
  const composerId = useId();
  const [activityFocus, setActivityFocus] = useState(0);
  const openActivity = () => {
    setTab("动态");
    setActivityOpen(true);
    setActivityFocus((count) => count + 1);
  };
  const closeActivity = (restoreFocus = true) => {
    setActivityOpen(false);
    if (restoreFocus) requestAnimationFrame(() => composeButton.current?.focus({ preventScroll: true }));
  };
  const [showReport, setShowReport] = useState(false);
  const [editing, setEditing] = useState(false);
  const [life, setLife] = useState<LifecycleAction | null>(null);
  const [splitKey, setSplitKey] = useState(0);
  const peek = mode === "peek";

  if (!item) return <div className="p-10 text-[13px] text-fg-3">未找到 {id}。<Link href="/projects" className="text-accent hover:underline">返回项目</Link></div>;
  if (!canSee(items, item, acc)) return <NoAccess text="你不是这个项目的成员。需要查看请联系项目负责人或管理员把你加入项目。" />;

  const inactive = isInactive(items, item);
  const leaf = isLeaf(items, item.id);
  const st = statusOf(items, item);
  const ai = aiOf(items, item);
  const isProject = item.kind === "project";
  const scope = new Set([item.id, ...descendants(items, item.id).map((d) => d.id)]);
  const related = alerts.filter((a) => scope.has(a.itemId));
  const openCk = openChecks(items, item).length;
  const defectsOpen = [item, ...descendants(items, item.id)].reduce((n, x) => n + x.defects.filter((d) => d.status === "open").length, 0);
  const screenshotIds = item.screenshotIds ?? [];
  const tabs: Tab[] = [...(isProject || !leaf || levelLabel(items, item) !== "子任务" ? (["子任务"] as Tab[]) : []), ...(isProject ? (["迭代"] as Tab[]) : []), ...(isProject || visibleChecks(items, item).length ? (["检查项"] as Tab[]) : []), "动态", "缺陷", ...(item.eval ? (["AI 评测"] as Tab[]) : []), ...(isProject ? (["设置"] as Tab[]) : [])];
  const linkedUpdate = !searchParams.has("peek") ? searchParams.get("update") : null;
  const linkedDefects = !peek && searchParams.get("tab") === "quality";
  const initialTab = linkedDefects ? "缺陷" : linkedUpdate || (leaf && item.kind === "task") ? "动态" : "子任务";
  const current = tab && tabs.includes(tab) ? tab : initialTab;
  const vs = verifiersOf(items, item).filter((id) => verifierAllowed(item, id));
  const toTab = (t: string) => setTab((t === "完成检查项" ? "检查项" : t === "进展更新" ? "动态" : t) as Tab);
  const tabLabel = (t: Tab) => (t === "子任务" ? (isProject ? "需求与任务" : "子任务") : t);

  const actions = <ItemActions item={item} onEdit={() => setEditing(true)} onLife={setLife} onReport={isProject && !practice ? () => setShowReport(true) : undefined} compact={peek} />;

  const body = (
    <>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2.5">
          <div className="flex shrink-0 items-center gap-1.5">
            <ItemTypeBadge items={items} item={item} />
            {ai && <AiBadge />}
          </div>
          <div className="min-w-0 flex-1">
            <TitleEditor item={item} editable={!inactive && canEditPlan(items, item, acc)} size={peek ? "md" : "lg"} />
          </div>
          {item.pr && <a href={item.pr.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 text-xs text-fg-3 hover:text-fg"><GitPullRequest className="h-3 w-3" />PR #{item.pr.number}</a>}
        </div>
        {peek && <div className="shrink-0">{actions}</div>}
      </div>

      {item.desc && <p className="mt-2 max-w-3xl whitespace-pre-line text-[13px] leading-relaxed text-fg-2">{item.desc}</p>}

      {/* 属性行：全部可就地修改 */}
      <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-y border-line py-2.5">
        <Prop label="状态"><StatusCell item={item} />{!leaf && hasBlocked(items, item) && <Badge className="bg-danger-soft text-danger">含阻塞</Badge>}</Prop>
        {isProject ? (
          <Prop label="需求与任务"><ProjectWorkCounts items={items} projectId={item.id} /></Prop>
        ) : <WorkItemProgress items={items} item={item} leaf={leaf} done={st === "done"} />}
        <Prop label="截止"><DueCell item={item} /></Prop>
        {(!isProject || !leaf) && <Prop label="工作量"><span className="text-[13px] leading-5 tabular-nums text-fg-2" title="按周一至周五计算，含起止日">{estimateOf(items, item)} 人天</span></Prop>}
        {hasIterations(items, item) && <Prop label="迭代"><IterationCell item={item} /></Prop>}
        <Prop label="负责"><PersonCell item={item} field="owner" /></Prop>
        <Prop label="执行"><PersonCell item={item} field="assignee" /></Prop>
        {vs.length > 0 && <Prop label="验收"><span title={vs.map((v) => person(v).name).join("、")} className="inline-flex items-center gap-1.5"><AvatarStack ids={vs} />{vs.length === 1 && <span className="text-[13px] text-fg-2">{person(vs[0]).name}</span>}</span></Prop>}
        {(item.rework ?? 0) > 0 && <Prop label="打回"><span className="text-[13px] text-warn">{item.rework} 次</span></Prop>}
        {related.length > 0 && <AlertsChip related={related} />}
      </div>

      {(!!item.deliverable && item.deliverable !== item.pr?.url) || (item.acceptance?.length ?? 0) > 0 ? (
        <div className="mt-3 space-y-1.5 text-[13px] text-fg-2">
          {item.deliverable && item.deliverable !== item.pr?.url && (
            <p className="flex items-center gap-1.5"><Link2 className="h-3.5 w-3.5 shrink-0 text-fg-4" /><span className="text-fg-3">交付物</span>{/^https?:\/\//.test(item.deliverable) ? <a href={item.deliverable} target="_blank" rel="noreferrer" className="break-all text-accent-fg hover:underline">{item.deliverable}</a> : <span className="break-all">{item.deliverable}</span>}</p>
          )}
          {item.acceptance && item.acceptance.length > 0 && (
            <details className="group">
              <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-fg-3 transition-colors hover:text-fg">
                <ChevronRight className="h-3.5 w-3.5 transition group-open:rotate-90" />验收标准 {item.acceptance.length} 条
              </summary>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-9 text-fg-2">{item.acceptance.map((a) => <li key={a}>{a}</li>)}</ul>
            </details>
          )}
        </div>
      ) : null}

      {screenshotIds.length > 0 && (
        <section aria-label="截图" className="mt-2 max-w-3xl"><AttachmentList ids={screenshotIds} /></section>
      )}

      {inactive && <div className="mt-4 rounded-lg bg-sunken px-4 py-3 text-[13px] text-fg-2">{item.status === "cancelled" ? `已取消：${item.cancelReason ?? "上级已取消"}` : `项目已归档：${ancestors(items, item)[0]?.archiveReason ?? item.archiveReason ?? ""}`}。历史记录保留，后续操作和提醒已停止。</div>}

      {isProject && showReport && !practice && <WeeklyReportDialog key={`${acc.id}-${item.id}`} project={item} onClose={() => setShowReport(false)} />}

      <NextStep key={`${item.id}-${submitPrompt}`} startSubmit={submitPrompt > 0 || searchParams.get("submit") === "1"} focusReview={searchParams.get("review") === item.id && (peek || !searchParams.has("peek"))} item={item} onTab={toTab} onUpdate={openActivity} progressOpen={current === "动态" && activityOpen} composerId={composerId} onSplit={() => { setTab("子任务"); setSplitKey((k) => k + 1); }} />

      {/* 标签页 */}
      <TabBar value={current} onChange={setTab} label="工作项详情" className="mt-6" action={
        current === "动态" && !inactive && !activityOpen && (
          <button ref={composeButton} type="button" aria-controls={composerId} aria-expanded={false}
            onClick={openActivity} className={cx(btn2, sm, "mt-0.5 shrink-0 whitespace-nowrap")}><Plus />添加动态</button>
        )
      } items={tabs.map((t) => {
        const count = t === "子任务" ? (leaf ? 0 : descendants(items, item.id).length) : t === "检查项" ? openCk : t === "缺陷" ? defectsOpen : 0;
        return {
          value: t,
          label: tabLabel(t),
          icon: tabIcons[t],
          suffix: count > 0 ? <span className={cx("rounded px-1 text-[11px] tabular-nums", t === "子任务" ? "text-fg-4" : "bg-warn-soft text-warn")}>{count}</span> : undefined,
        };
      })} />

      <fieldset disabled={inactive && current !== "设置"} className="mt-4 min-w-0">
        {current === "子任务" && <WorkTree key={`${workspaceKey}-${item.id}-${splitKey}`} rootId={item.id} startAdding={splitKey > 0} />}
        {current === "迭代" && <ProjectIterations project={item} />}
        {current === "检查项" && <Checklist item={item} />}
        <Activity key={item.id} item={item} active={current === "动态"} open={activityOpen} composerId={composerId} focusRequest={activityFocus} linkedUpdate={linkedUpdate} onClose={closeActivity} onHundred={() => setCompletionOpen(true)} />
        {current === "缺陷" && <Defects item={item} />}
        {current === "AI 评测" && <Eval item={item} />}
        {current === "设置" && <ProjectSettings item={item} />}
      </fieldset>

      <Modal open={completionOpen && needsSubmission(items, item)} onOpenChange={(open) => { if (!finishing) setCompletionOpen(open); }} title="进度已到 100%，下一步？" desc="提交给验证人验收，或者把不需要验收的小任务直接完成。不处理会一直显示为「100% 未提交」。">
        <ModalFooter>
          <button className={btnGhost} disabled={finishing} onClick={() => setCompletionOpen(false)}>稍后</button>
          {item.kind === "task" && <button data-action-feedback="local" disabled={finishing || openChecks(items, item).length > 0} className={cx(btn2, "liquid-button liquid-success min-w-24", confirmed && "disabled:opacity-100")} aria-busy={finishing && !confirmed} onClick={async () => {
            setFinishing(true);
            try { if ((await setStatus(item.id, "done", undefined, () => acknowledge("complete"))).ok) setCompletionOpen(false); }
            finally { clearFeedback(); setFinishing(false); }
          }}><LiquidButtonFace>直接完成</LiquidButtonFace>{confirmed && <ActionFeedback variant="complete" message="已完成" />}</button>}
          <button data-guide="submit" autoFocus disabled={finishing} className={cx(btn2, "form-trigger form-trigger-accent")} onClick={() => { setCompletionOpen(false); setSubmitPrompt((n) => n + 1); setTimeout(() => document.getElementById("next-step")?.scrollIntoView({ behavior: "smooth", block: "center" }), 50); }}>提交验收</button>
        </ModalFooter>
      </Modal>
      {editing && <WorkItemForm item={item} onDone={() => setEditing(false)} />}
      <LifecycleDialog item={item} action={life} onClose={() => setLife(null)} />
    </>
  );

  if (peek) return body;

  return (
    <div>
      <div className="sticky top-0 z-20 flex h-11 items-center gap-2 border-b border-line bg-surface/85 px-4 backdrop-blur md:rounded-t-xl md:px-6">
        <nav className="flex min-w-0 flex-1 items-center gap-1 text-[13px] text-fg-3">
          <Link href="/projects" className="shrink-0 transition-colors hover:text-fg">项目</Link>
          {ancestors(items, item).map((a) => (
            <span key={a.id} className="flex min-w-0 items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-4" />
              <Link href={`/item/${a.id}`} className="truncate transition-colors hover:text-fg">{a.title}</Link>
            </span>
          ))}
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-fg-4" />
          <span className="truncate text-fg">{item.title}</span>
        </nav>
        {actions}
      </div>
      <div className="mx-auto max-w-[1180px] px-4 pb-64 pt-6 md:pb-16 md:px-10">{body}</div>
    </div>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="text-xs text-fg-4">{label}</span>
      {children}
    </div>
  );
}

function WorkItemProgress({ items, item, leaf, done }: { items: Items; item: WorkItem; leaf: boolean; done: boolean }) {
  const progress = progressOf(items, item);
  const plan = !leaf && !done ? plannedProgress(item) : undefined;
  const leaves = leaf ? [] : descendants(items, item.id).filter((child) => isLeaf(items, child.id) && !isInactive(items, child));
  return (
    <Prop label="进度">
      <Progress value={progress} plan={plan} />
      {!leaf && <span className="text-xs tabular-nums text-fg-3">{leaves.filter((child) => statusOf(items, child) === "done").length}/{leaves.length} 完成</span>}
      {plan !== undefined && plan - progress >= 20 && <Badge className="bg-danger-soft text-danger">落后 {plan - progress}%</Badge>}
    </Prop>
  );
}

function AlertsChip({ related }: { related: ReturnType<typeof useStore>["alerts"] }) {
  const { items } = useStore();
  const urgent = related.filter((a) => a.level === "urgent").length;
  return (
    <Pop>
      <PopTrigger asChild>
        <button className={cx("ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs transition-colors hover:bg-hover data-[state=open]:bg-active", urgent ? "text-danger" : "text-fg-3")}>
          <BellRing className="h-3.5 w-3.5" />系统跟进 {related.length} 件
        </button>
      </PopTrigger>
      <PopContent align="end" className="w-96 p-2">
        <div className="px-1 pb-2 text-xs text-fg-3">按提醒规则发送单独消息或纳入每日摘要</div>
        <ul className="max-h-80 space-y-0.5 overflow-y-auto">
          {related.slice(0, 20).map((a) => (
            <li key={a.id}>
              <Link href={`/item/${a.itemId}`} className="flex items-start gap-2 rounded-md px-1.5 py-1.5 text-[13px] hover:bg-hover">
                <span className={cx("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", LEVEL_CLS[a.level])} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{items.find((x) => x.id === a.itemId)?.title}</span>
                  <span className="block text-xs text-fg-3">{a.text}</span>
                </span>
                <span className="flex shrink-0 -space-x-1">{a.to.map((t) => <Avatar key={t} id={t} size={4} className="ring-2 ring-surface" />)}</span>
              </Link>
            </li>
          ))}
        </ul>
      </PopContent>
    </Pop>
  );
}

function TitleEditor({ item, editable, size }: { item: WorkItem; editable: boolean; size: "lg" | "md" }) {
  const { edit } = useStore();
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const originalTitle = useRef(item.title);
  const saving = useRef(false);
  const cls = cx("w-full break-words font-semibold leading-tight tracking-tight", size === "lg" ? "text-2xl" : "text-xl");
  if (!editable) return <h1 className={cls}>{item.title}</h1>;
  const save = async () => {
    const t = draft?.trim();
    if (saving.current) return;
    if (!t || t === originalTitle.current) { setDraft(null); return; }
    saving.current = true;
    try {
      const result = await edit(item.id, { title: t }, "修改标题", { title: originalTitle.current });
      if (result.ok) {
        setDraft(null);
        toast("标题已更新", t);
      } else if (result.conflicts?.title !== undefined) {
        toast("标题已被其他人更新", `最新标题：${result.conflicts.title}。可复制输入内容后按 Esc 退出，再重新编辑。`, "warn");
      }
    } finally { saving.current = false; }
  };
  if (draft === null) {
    return <h1 className={cx(cls, "-mx-1.5 cursor-text rounded-md px-1.5 transition-colors hover:bg-hover")} title="点击修改标题" onClick={() => { originalTitle.current = item.title; setDraft(item.title); }}>{item.title}</h1>;
  }
  return (
    <input
      autoFocus
      aria-label="标题"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void save(); if (e.key === "Escape") { e.stopPropagation(); setDraft(null); } }}
      className={cx(cls, "-mx-1.5 rounded-md bg-accent-soft/60 px-1.5 outline-none")}
    />
  );
}

function ItemActions({ item, onEdit, onLife, onReport, compact }: { item: WorkItem; onEdit: () => void; onLife: (a: LifecycleAction) => void; onReport?: () => void; compact?: boolean }) {
  const { items, acc, practice } = useStore();
  const { canCancel, canDelete, deleteHint, canArchive, canRestore, canUnarchive } = useLifecycle(item);
  const canEdit = !isInactive(items, item) && canEditPlan(items, item, acc);
  const canEditScreenshots = !practice && canAddItemScreenshots(items, item, acc);
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {onReport && !compact && <button className={btnGhost} onClick={onReport}><Newspaper />周报</button>}
      {item.kind === "task" && isLeaf(items, item.id) && <CopyBranch id={item.id} compact={compact} />}
      {(canEdit || canEditScreenshots || canCancel || canDelete || canRestore || canUnarchive || (onReport && compact)) && (
        <Menu>
          <Tip content="更多操作"><MenuTrigger className={iconBtn} aria-label="更多操作"><MoreHorizontal /></MenuTrigger></Tip>
          <MenuContent align="end" className="w-52">
            {canRestore && <MenuItem icon={<RotateCcw />} onSelect={() => onLife("restore")}>恢复工作项…</MenuItem>}
            {canUnarchive && <MenuItem icon={<RotateCcw />} onSelect={() => onLife("unarchive")}>解除归档…</MenuItem>}
            {(canEdit || canEditScreenshots) && <MenuItem icon={<Pencil />} onSelect={onEdit}>{canEdit ? "编辑属性…" : "编辑截图…"}</MenuItem>}
            {onReport && compact && <MenuItem icon={<Newspaper />} onSelect={onReport}>周报</MenuItem>}
            {(canCancel || canArchive || canDelete) && <MenuSeparator />}
            {canCancel && <MenuItem icon={<XCircle />} onSelect={() => onLife("cancel")}>取消{item.kind === "project" ? "项目" : "这一项"}…</MenuItem>}
            {canArchive && <MenuItem icon={<Archive />} onSelect={() => onLife("archive")}>归档项目…</MenuItem>}
            {canDelete && <MenuItem icon={<Trash2 />} danger disabled={!!deleteHint} hint={deleteHint} onSelect={() => onLife("delete")}>删除…</MenuItem>}
          </MenuContent>
        </Menu>
      )}
    </div>
  );
}

function CopyBranch({ id, compact }: { id: string; compact?: boolean }) {
  const toast = useToast();
  const name = branchNameFor(id);
  return (
    <Tip content={`复制分支名 ${name}，PR 会自动关联到这个任务`}>
      <button
        className={compact ? iconBtn : btnGhost}
        aria-label="复制分支名"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(name);
            toast("分支名已复制", `${name} · 用它建分支，PR 会自动关联`);
          } catch {
            toast("复制失败", name, "warn");
          }
        }}
      >
        <GitBranch />{!compact && "分支名"}
      </button>
    </Tip>
  );
}

function L({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return <label className={cx("block text-xs text-fg-3", className)}>{label}<div className="mt-1">{children}</div></label>;
}

/** 项目设置：里程碑、成员、飞书群、代码仓库 —— 不再占据首屏 */
function ProjectSettings({ item }: { item: WorkItem }) {
  const { items, acc, edit } = useStore();
  const toast = useToast();
  const members = membersOf(items, item);
  const manage = !isInactive(items, item) && canManage(items, item, acc);
  return (
    <div className="max-w-4xl divide-y divide-line">
      <Section title="里程碑">
        <ProjectMilestones item={item} manage={manage} />
      </Section>
      <Section title={`成员 · ${members.length}`} desc="成员才能看到这个项目；担任负责人、执行人、验证人的人自动可见">
        <div className="flex flex-wrap items-center gap-2">
          <People ids={members} />
          {manage && (
            <PersonPicker exclude={members} title="添加成员" onPick={async (id) => { const r = await edit(item.id, { members: [...(item.members ?? []), id] }, `添加成员 ${person(id).name}`); if (r.ok) toast(`已添加成员 ${person(id).name}`); }}>
              <button className={cx(btn2, sm)}><Plus />添加</button>
            </PersonPicker>
          )}
        </div>
      </Section>
      <Section title="飞书项目群" desc="项目风险和周报会推送到这个群；机器人需先加入该群"><ProjectFeishu key={item.id} item={item} manage={manage} /></Section>
      <Section title="代码仓库" desc="每个仓库可绑定一个项目。分支名或合并请求标题带任务编号时会自动关联。"><RepoCard project={item} manage={manage} /></Section>
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="grid gap-3 py-6 first:pt-2 md:grid-cols-[220px_minmax(0,1fr)] md:gap-8">
      <div>
        <h3 className="text-[13px] font-medium text-fg">{title}</h3>
        {desc && <p className="mt-1 text-xs leading-relaxed text-fg-3">{desc}</p>}
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function ProjectMilestones({ item, manage }: { item: WorkItem; manage: boolean }) {
  const milestones = item.milestones ?? [];
  const [editing, setEditing] = useState(false);
  return (
    <div className="space-y-3">
      {milestones.length ? (
        <ol className="space-y-2">
          {milestones.map((milestone, index) => {
            const late = !milestone.done && milestone.date < today();
            return (
              <li key={index} className="flex items-center gap-2.5 text-[13px]">
                <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", milestone.done ? "bg-st-done" : late ? "bg-st-blocked" : "border border-fg-4")} />
                <span className={cx("min-w-0 flex-1 break-words", milestone.done && "text-fg-3 line-through")}>{milestone.name}</span>
                <span className={cx("shrink-0 text-xs tabular-nums", late ? "text-danger" : "text-fg-3")}>{fmt(milestone.date)}{milestone.done ? " · 已完成" : late ? " · 已逾期" : ""}</span>
              </li>
            );
          })}
        </ol>
      ) : <p className="text-sm text-fg-3">暂无里程碑</p>}
      {manage && <button type="button" className={cx(btn2, sm)} onClick={() => setEditing(true)}><Pencil />编辑里程碑</button>}
      {manage && editing && <MilestoneEditor item={item} onClose={() => setEditing(false)} />}
    </div>
  );
}

function MilestoneEditor({ item, onClose }: { item: WorkItem; onClose: () => void }) {
  const { edit } = useStore();
  const [original] = useState(() => item.milestones ?? []);
  const [rows, setRows] = useState(() => original.map((value, id) => ({ id, value })));
  const nextId = useRef(original.length);
  const [busy, setBusy] = useState(false);
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const stale = JSON.stringify(original) !== JSON.stringify(item.milestones ?? []);
  const valid = rows.every(({ value }) => value.name.trim() && value.date);
  const update = (id: number, patch: Partial<Milestone>) => setRows((current) => current.map((row) => row.id === id ? { ...row, value: { ...row.value, ...patch } } : row));
  const save = async () => {
    if (busy || !valid || stale) return;
    setBusy(true);
    try {
      const milestones = rows.map(({ value }) => ({ ...value, name: value.name.trim() }));
      if (!(await edit(item.id, { milestones }, "编辑里程碑")).ok) return;
      await acknowledge();
      onClose();
    } finally { clearFeedback(); setBusy(false); }
  };
  return (
    <Modal open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title="编辑里程碑" className="max-w-xl">
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy} className="space-y-3 px-5 py-4">
          {rows.map(({ id, value }, index) => (
            <div key={id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 rounded-lg border border-line p-2 sm:grid-cols-[minmax(0,1fr)_9rem_auto_auto] sm:items-end">
              <L label="名称" className="col-span-2 sm:col-span-1"><input required maxLength={300} className={field} value={value.name} onChange={(event) => update(id, { name: event.target.value })} /></L>
              <L label="日期"><DateField label="里程碑日期" value={value.date} disabled={busy} onPick={(date) => update(id, { date })} /></L>
              <div className="flex items-center gap-2 sm:contents">
                <label className="flex h-8 items-center gap-1.5 whitespace-nowrap text-xs text-fg-3"><input type="checkbox" className="accent-[var(--color-accent)]" checked={value.done} onChange={(event) => update(id, { done: event.target.checked })} />完成</label>
                <button type="button" className={iconBtn} aria-label={`删除里程碑 ${value.name || index + 1}`} onClick={() => setRows((current) => current.filter((row) => row.id !== id))}><Trash2 /></button>
              </div>
            </div>
          ))}
          <button type="button" className={cx(btn2, sm)} disabled={rows.length >= 100} onClick={() => {
            const id = nextId.current++;
            setRows((current) => [...current, { id, value: { name: "", date: "", done: false } }]);
          }}><Plus />添加里程碑</button>
          {stale && !busy && <p role="alert" className="text-xs text-danger">里程碑已更新，请重新打开后编辑。</p>}
        </fieldset>
        <ModalFooter>
          <button type="button" className={btnGhost} disabled={busy} onClick={onClose}>取消</button>
          <button data-action-feedback="local" type="submit" className={cx(btn, "liquid-button min-w-24", confirmed && "disabled:opacity-100")} disabled={busy || !valid || stale} aria-busy={busy && !confirmed}><LiquidButtonFace>保存</LiquidButtonFace>{confirmed && <ActionFeedback message="已保存" />}</button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function ProjectFeishu({ item, manage }: { item: WorkItem; manage: boolean }) {
  const { edit } = useStore();
  const [group, setGroup] = useState(item.feishuGroup ?? "");
  const [chatId, setChatId] = useState(item.feishuChatId ?? "");
  const [busy, setBusy] = useState(false);
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const dirty = group !== (item.feishuGroup ?? "") || chatId !== (item.feishuChatId ?? "");
  async function save() {
    if (busy || !dirty) return;
    setBusy(true);
    try {
      const result = await edit(item.id, { feishuGroup: group.trim(), feishuChatId: chatId.trim() }, "修改飞书项目群");
      if (result.ok) await acknowledge();
    } finally { clearFeedback(); setBusy(false); }
  }
  if (!manage) return <p className="text-[13px] text-fg-2">{item.feishuGroup || "未填写群名"} <span className="text-fg-4">· {item.feishuChatId || "未绑定 chat_id"}</span></p>;
  return (
    <div className="grid max-w-lg gap-3">
      <L label="群显示名"><input className={field} value={group} onChange={(e) => setGroup(e.target.value)} maxLength={300} /></L>
      <L label="群 chat_id · 清空可停止向此群推送"><input className={field} placeholder="oc_ 开头的群 ID" value={chatId} onChange={(e) => setChatId(e.target.value)} maxLength={150} /></L>
      <div><button data-action-feedback="local" disabled={busy || !dirty} onClick={save} className={cx(btn, sm, "liquid-button min-w-18")} aria-busy={busy && !confirmed}><LiquidButtonFace>保存</LiquidButtonFace>{confirmed && <ActionFeedback message="已保存" />}</button></div>
    </div>
  );
}

/** 项目绑定的仓库、进行中与未关联的合并请求。 */
function RepoCard({ project, manage }: { project: WorkItem; manage: boolean }) {
  const { items, repoEvents, repoProviders, repoConfigured, bindRepo, unbindRepo, linkRepoEvent, ignoreRepoEvent } = useStore();
  const toast = useToast();
  const [repo, setRepo] = useState("");
  const [selectedProvider, setSelectedProvider] = useState<RepoProvider>();
  const provider = selectedProvider ?? REPO_PROVIDERS.find((value) => repoProviders?.[value]) ?? (repoConfigured ? "gitea" : "github");
  const all = descendants(items, project.id);
  const openPrs = all.filter((x) => x.pr && x.status !== "done");
  const tasks = all.filter((x) => isLeaf(items, x.id));
  const unlinked = repoEvents.filter((e) => e.status === "unlinked" && e.projectId === project.id);
  const warned = repoEvents.filter((e) => e.warning && (e.projectId === project.id || all.some((x) => x.id === e.itemId))).slice(0, 3);
  const add = async () => {
    const r = await bindRepo(project.id, repo, provider);
    if (!r.ok) return;
    toast("仓库已绑定", r.reason ?? repo.trim());
    setRepo("");
  };
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {(project.repos ?? []).map((r) => (
          <span key={r} className="inline-flex h-7 items-center gap-1.5 rounded-md bg-sunken px-2 font-mono text-xs text-fg-2">
            <GitBranch className="h-3 w-3 text-fg-4" />{repoLabel(r)}
            {manage && <button aria-label={`解除绑定 ${r}`} onClick={async () => { if ((await unbindRepo(project.id, r)).ok) toast("已解除绑定", r); }} className="text-fg-4 hover:text-danger"><X className="h-3 w-3" /></button>}
          </span>
        ))}
        {!project.repos?.length && <span className="text-[13px] text-fg-3">还没有绑定仓库</span>}
      </div>
      {manage && (
        <div className="mt-3 flex max-w-lg flex-wrap items-center gap-1.5">
          <Select label="仓库平台" value={provider} options={REPO_PROVIDERS.map((value) => ({ value, label: REPO_PROVIDER_LABELS[value] }))}
            onValueChange={(value) => { if (isRepoProvider(value)) setSelectedProvider(value); }} className="w-28 shrink-0" />
          <input aria-label="仓库地址" value={repo} onChange={(e) => setRepo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && repo.trim() && add()}
            placeholder={provider === "gitlab" ? "group/subgroup/repo 或链接" : "owner/repo 或链接"} className={cx(field, "min-w-32 flex-1 font-mono text-xs")} />
          <button disabled={!repo.trim()} onClick={add} className={cx(btn2, sm)}><Plus />绑定</button>
        </div>
      )}

      {openPrs.length > 0 && (
        <div className="mt-5">
          <div className="mb-1.5 text-xs text-fg-4">进行中的 PR · {openPrs.length}</div>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {openPrs.map((x) => (
              <li key={x.id} className="flex flex-wrap items-center gap-x-2 px-3 py-2 text-[13px]">
                <a href={x.pr!.url} target="_blank" rel="noreferrer" className="font-mono text-xs text-fg-3 hover:text-fg">#{x.pr!.number}</a>
                <Link href={`/item/${x.id}`} className="min-w-0 flex-1 truncate font-medium hover:underline">{x.title}</Link>
                <span className="text-xs text-fg-3">
                  {x.status === "review" ? `等 ${verifiersOf(items, x).map((v) => person(v).name).join("、") || "验证人"} 验收${x.reviewSince ? ` · 已等 ${daysBetween(x.reviewSince, today())} 天` : ""}` : "开发中"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {unlinked.length > 0 && (
        <div className="mt-5">
          <div className="mb-1.5 text-xs text-fg-4">未关联任务的 PR · {unlinked.length} · 分支名和标题里没有任务编号</div>
          <ul className="divide-y divide-line rounded-lg border border-line">
            {unlinked.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-[13px]">
                <span className="font-mono text-xs text-fg-3">#{e.number}</span>
                <span className="min-w-0 flex-1 truncate">{e.title}</span>
                {manage && (
                  <>
                    <Select value="" placeholder="关联到任务…" onValueChange={(value) => { linkRepoEvent(e.id, value); toast("已关联", e.title); }} className="h-7 w-auto! py-0 text-xs"
                      options={tasks.map((t) => ({ value: t.id, label: t.title }))} />
                    <button onClick={() => ignoreRepoEvent(e.id)} className={cx(btnGhost, sm)}>忽略</button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {warned.length > 0 && (
        <ul className="mt-4 space-y-1 text-xs text-danger">
          {warned.map((e) => <li key={e.id}>#{e.number} {e.title}：{e.warning}</li>)}
        </ul>
      )}
    </div>
  );
}

function NextStep({ item, onTab, onUpdate, progressOpen, composerId, onSplit, startSubmit = false, focusReview }: { item: WorkItem; startSubmit?: boolean; focusReview: boolean; onTab: (t: string) => void; onUpdate: () => void; progressOpen: boolean; composerId: string; onSplit: () => void }) {
  const { setStatus, submit, verify, items, me, acc, practice } = useStore();
  const toast = useToast();
  const [form, setForm] = useState<null | "block" | "submit" | "reject">(startSubmit && isLeaf(items, item.id) && !isInactive(items, item) && !["done", "review", "release", "production-review"].includes(statusOf(items, item)) && (isAssignee(item, me) || canManage(items, item, acc)) ? "submit" : null);
  const reasonId = useId();
  const submitId = useId();
  const [submitting, setSubmitting] = useState(false);
  const submitted = useActionFeedback();
  const [text, setText] = useState("");
  const [link, setLink] = useState(item.deliverable ?? "");
  const [archiving, setArchiving] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const inherited = verifiersOf(items, item);
  const needPick = !inherited.some((id) => verifierAllowed(item, id));
  const candidates = PEOPLE.filter((p) => p.active !== false && verifierAllowed(item, p.id));
  const [pick, setPick] = useState<string[]>(needPick && candidates.some((p) => p.id === item.owner) ? [item.owner] : []);
  const leaf = isLeaf(items, item.id);
  const canSplit = levelLabel(items, item) !== "子任务" && canAddChild(items, item, acc);
  const st = statusOf(items, item);
  const vs = needPick ? pick : inherited;
  const names = (ids: string[]) => ids.map((v) => person(v).name).join("、");
  const doer = isAssignee(item, me) || canManage(items, item, acc);
  const nextStep = useRef<HTMLDivElement>(null);
  const production = requiresProduction(item);
  const missingCriteria = usesAcceptanceCriteria(item) && !hasAcceptanceCriteria(item);
  const acceptsWholeRequirement = !leaf && (usesAcceptanceCriteria(item) || production);
  const reviewing = st === "review" && (leaf || acceptsWholeRequirement) && !isInactive(items, item) && canVerifyDelivery(items, item, acc);
  useEffect(() => {
    if (!focusReview || !reviewing) return;
    const frame = requestAnimationFrame(() => {
      nextStep.current?.scrollIntoView({ block: "nearest" });
      nextStep.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusReview, reviewing]);
  const run = async (operation: Promise<{ ok: boolean; reason?: string }>, title: string, desc?: string) => {
    const r = await operation;
    if (!r.ok) return;
    toast(title, desc);
    setForm(null);
    setText("");
  };

  const submitForReview = async () => {
    if (submitting || finishing || !link.trim() || !vs.length) return;
    setSubmitting(true);
    try {
      const result = await submit(item.id, link.trim(), text.trim(), needPick ? pick : undefined, () => submitted.acknowledge("submit"));
      if (!result.ok) return;
      toast(production ? "已提交测试验收" : "已提交验收", "验收人可在工作台查看");
      setForm(null);
      setText("");
    } finally {
      submitted.clearFeedback();
      setSubmitting(false);
    }
  };

  const finish = async (accept: boolean) => {
    if (finishing) return;
    setFinishing(true);
    try {
      if (accept) await verify(item.id, true, "", () => acknowledge("complete"));
      else await setStatus(item.id, "done", undefined, () => acknowledge("complete"));
    } finally { clearFeedback(); setFinishing(false); }
  };

  if (isInactive(items, item)) return null;
  if (production && (isPublishing(st) || (st === "done" && item.publication))) {
    return <ProductionStep key={`${st}-${item.publication?.id ?? item.releaseCycle?.id}`} item={item} />;
  }

  let tone: "action" | "wait" | "done" | "warn" = "wait";
  let Icon: LucideIcon = Clock;
  let title = "";
  let desc: ReactNode = null;
  let actions: ReactNode = null;

  if (acceptsWholeRequirement && st === "review") {
    tone = "action"; Icon = Eye; title = production ? "子任务已完成，待测试验收" : "子任务已完成，待整体验收";
    desc = missingCriteria ? "请先在需求的编辑页填写验收标准。" : "按需求的验收标准确认整体交付。";
    actions = <>
      {openChecks(items, item).length > 0 && <button onClick={() => onTab("检查项")} className={btn2}><ListChecks />查看检查项</button>}
      {reviewing && production && <button type="button" disabled={finishing} aria-expanded={form === "reject"} aria-controls={reasonId} onClick={() => setForm("reject")} className={btn2}><Undo2 />打回修改</button>}
      {reviewing && <button data-action-feedback="local" disabled={finishing} onClick={() => void finish(true)} className={cx(btn, "liquid-button liquid-success min-w-24")} aria-busy={finishing && !confirmed}>
        <LiquidButtonFace><Check />{production ? "测试验收通过" : "验收通过"}</LiquidButtonFace>{confirmed && <ActionFeedback variant="complete" message="已通过" />}
      </button>}
    </>;
  } else if (acceptsWholeRequirement && production && item.checks.findLast((check) => check.type === "线上验收" || check.type === "测试验收")?.result === "不通过") {
    tone = "warn"; Icon = Undo2; title = "验收打回，待修改";
    desc = "请重新打开并修复相关子任务。子任务完成后，再做测试验收。";
  } else if (!leaf) {
    const left = openChecks(items, item).length;
    if (st === "done" && item.kind === "project" && canManage(items, item, acc)) {
      // 项目全部完成：提示负责人归档，停止提醒、保留历史
      tone = "done"; Icon = PartyPopper; title = "项目已全部完成"; desc = "确认上线后可以归档：项目变为只读，停止待办和提醒，历史统计保留";
      actions = <button onClick={() => setArchiving(true)} className={btn2}><Archive />归档项目</button>;
    } else {
      // 进行中的上级：进度条已经说明一切，不再占一整块
      if (st !== "review") return null;
      tone = "action"; Icon = ListChecks; title = `子任务都完成了，还差 ${left} 项检查项`; desc = "确认完检查项后会自动变成「已完成」";
      actions = <button onClick={() => onTab("检查项")} className={btn}><ListChecks />去确认</button>;
    }
  } else if (item.kind === "project") {
    tone = "action"; Icon = Sparkles; title = "把项目拆成需求或任务"; desc = "每一项指定执行人和截止日期，进度会自动汇总到这里";
    actions = <button data-guide="add-first" onClick={onSplit} className={btn}><Plus />添加第一项</button>;
  } else if (st === "review") {
    if (canVerifyDelivery(items, item, acc)) {
      tone = "action"; Icon = Eye; title = production ? "轮到你做测试验收" : "轮到你验收";
      desc = <ReviewSubmission item={item} showAuthor />;
      actions = (
        <>
          {production && openChecks(items, item).length > 0 && <button type="button" onClick={() => onTab("检查项")} className={btn2}><ListChecks />查看检查项</button>}
          <button data-guide="reject" disabled={finishing} aria-expanded={form === "reject"} aria-controls={form === "reject" ? reasonId : undefined} onClick={() => setForm("reject")} className={cx(btn2, "form-trigger form-trigger-warning")}><Undo2 />打回修改</button>
          <button data-action-feedback="local" data-guide="accept" disabled={finishing} onClick={() => void finish(true)} className={cx(btn, "liquid-button liquid-success min-w-24", confirmed && "disabled:opacity-100")} aria-busy={finishing && !confirmed}><LiquidButtonFace><Check />{production ? "测试验收通过" : "验收通过"}</LiquidButtonFace>{confirmed && <ActionFeedback variant="complete" message="已通过" />}</button>
        </>
      );
    } else {
      Icon = Clock; title = `已提交，等待 ${names(inherited) || "验证人"} ${production ? "测试验收" : "验收"}`;
      desc = practice ? "练习已提交，可在指南里切换到验证人继续操作。" : `${item.reviewSince ? fmt(item.reviewSince) + " 提交 · " : ""}超过 1 天没处理会自动飞书提醒，不用自己去催`;
      if (doer) actions = <button onClick={() => run(setStatus(item.id, "doing"), "已撤回", "可以继续修改后再提交")} className={btn2}><RotateCcw />撤回</button>;
    }
  } else if (st === "done") {
    tone = "done"; Icon = PartyPopper; title = "已完成"; desc = item.doneAt ? `${fmt(item.doneAt)} 完成` : undefined;
    if (doer) actions = <button onClick={() => run(setStatus(item.id, "doing"), "已重新打开")} className={btn2}><RotateCcw />重新打开</button>;
  } else if (!doer) {
    Icon = Hand; title = `由 ${assigneeNames(item)} 负责`; desc = "最新情况都在下方「动态」里，也可以在那里留言";
  } else if (needsSubmission(items, item)) {
    tone = "action"; Icon = Send; title = "进度 100%，还没提交";
    desc = "提交验收或直接完成后，这项待办才会结束";
    actions = <>
      {item.kind === "task" && <button data-action-feedback="local" disabled={submitting || finishing || openChecks(items, item).length > 0} onClick={() => void finish(false)} className={cx(btn2, "liquid-button liquid-success min-w-24", confirmed && "disabled:opacity-100")} aria-busy={finishing && !confirmed}><LiquidButtonFace>直接完成</LiquidButtonFace>{confirmed && <ActionFeedback variant="complete" message="已完成" />}</button>}
      <button data-guide="submit" disabled={submitting || finishing} aria-expanded={form === "submit"} aria-controls={form === "submit" ? submitId : undefined} onClick={() => setForm("submit")} className={cx(btn2, "form-trigger form-trigger-accent")}><Send />{production ? "提交测试验收" : "提交验收"}</button>
    </>;
  } else if (st === "todo") {
    tone = "action"; Icon = Play; title = "轮到你了：开始这项工作"; desc = canSplit ? "可以先拆分工作，再更新进度。" : undefined;
    actions = (
      <>
        {canSplit && <button data-guide="split" onClick={onSplit} className={btn2}><ListTree />拆成子任务</button>}
        <StartActionButton data-guide="start" onStart={(feedback) => run(setStatus(item.id, "doing", undefined, feedback), "已开始", "做完后记得提交验收")} className={btn}><Play />开始</StartActionButton>
      </>
    );
  } else if (st === "blocked") {
    tone = "warn"; Icon = OctagonAlert; title = `阻塞中：${item.blockedReason ?? ""}`;
    desc = `${item.blockedSince ? `已阻塞 ${daysBetween(item.blockedSince, today())} 天 · ` : ""}超过 1 天会自动通知负责人和上级`;
    actions = <button onClick={() => run(setStatus(item.id, "doing"), "已解除阻塞")} className={btn}><Play />解除阻塞</button>;
  } else {
    const lastFail = [...item.checks].reverse().find((c) => c.result === "不通过");
    const rejected = lastFail && item.checks.at(-1) === lastFail;
    tone = rejected ? "warn" : "action"; Icon = rejected ? Undo2 : Send;
    title = rejected ? `${person(lastFail.by).name} 打回了：${lastFail.note}` : production ? "做完后提交测试验收" : "做完后提交验收";
    desc = rejected ? "改好后重新提交验收即可，之前的交付物链接会自动带上" : practice ? "填写交付说明或链接，本次练习不发送通知" : `附上预览链接或 PR，${names(vs) || "验证人"} 会收到飞书通知`;
    actions = (
      <>
        {item.kind === "task" && <Tip content="不需要别人验收的小任务，如文档、配置"><button data-action-feedback="local" disabled={submitting || finishing || openChecks(items, item).length > 0} onClick={() => void finish(false)} className={cx(btn2, "liquid-button liquid-success", confirmed && "disabled:opacity-100")} aria-busy={finishing && !confirmed}><LiquidButtonFace>直接完成</LiquidButtonFace>{confirmed && <ActionFeedback variant="complete" message="已完成" />}</button></Tip>}
        <button disabled={submitting || finishing} aria-expanded={form === "block"} aria-controls={form === "block" ? reasonId : undefined} onClick={() => setForm("block")} className={cx(btn2, "form-trigger form-trigger-warning")}><OctagonAlert />遇到阻塞</button>
        <UpdateActionButton data-guide="open-progress" disabled={submitting || finishing} aria-expanded={progressOpen} aria-controls={composerId} onActivate={onUpdate} className={btn2}><MessageSquareText />更新进展</UpdateActionButton>
        <button data-guide="submit" disabled={submitting || finishing} aria-expanded={form === "submit"} aria-controls={form === "submit" ? submitId : undefined} onClick={() => setForm("submit")} className={cx(btn2, "form-trigger form-trigger-accent")}><Send />{production ? "提交测试验收" : "提交验收"}</button>
      </>
    );
  }

  const toneCls = { action: "border-accent/25 bg-accent-soft/60", wait: "border-line bg-canvas", done: "border-st-done/25 bg-ok-soft", warn: "border-danger/25 bg-danger-soft" }[tone];
  const iconCls = { action: "bg-accent text-white", wait: "bg-surface text-fg-3 ring-1 ring-line-strong", done: "bg-st-done text-white", warn: "bg-st-blocked text-white" }[tone];

  return (
    <div ref={nextStep} id="next-step" tabIndex={reviewing ? -1 : undefined} className={cx("item-next-step mt-4 rounded-lg border px-4 py-3", toneCls, !!actions && "has-actions")}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-[1_1_13rem] items-center gap-3">
          <span className={cx("next-step-icon flex h-7 w-7 shrink-0 items-center justify-center rounded-full", iconCls)}><Icon className="h-3.5 w-3.5" /></span>
          <div className="min-w-0">
            <div className="break-words text-[13px] font-medium text-fg">{title}</div>
            {desc && <div className="next-step-description mt-0.5 text-xs text-fg-3">{desc}</div>}
          </div>
        </div>
        {actions && <div className="next-step-actions ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">{actions}</div>}
      </div>
      <LifecycleDialog item={item} action={archiving ? "archive" : null} onClose={() => setArchiving(false)} />

      {form === "submit" && (
        <div id={submitId} data-guide-form="" className="form-entry mt-3 space-y-2 border-t border-line pt-3">
          {missingCriteria && <p className="text-xs text-warn">提交前请在需求的编辑页填写验收标准。</p>}
          <input data-guide={!link.trim() ? "deliverable" : undefined} autoFocus value={link} onChange={(e) => setLink(e.target.value)} placeholder={production ? "测试环境链接或验收说明（必填）" : "交付物：预览链接 / PR 地址 / 文档链接（必填）"} className={field} />
          <input data-guide={(item.rework ?? 0) > 0 && !text.trim() ? "revision-note" : undefined} value={text} onChange={(e) => setText(e.target.value)} placeholder="补充说明（可选）：改了什么、怎么测" className={field} />
          {needPick && (
            <div>
              <div className="text-xs text-fg-3">
                {!candidates.length
                  ? `团队里暂时没有可用的验证人。请先邀请成员${item.kind === "task" ? "，或用「直接完成」结束这项任务" : ""}。`
                  : inherited.length ? "项目需要由执行人以外的成员验收：" : "这项工作还没有验证人，选一位来验收："}
              </div>
              {candidates.length > 0 && <PersonSelect multiple label="验证人" value={pick} onPick={setPick} people={candidates}
                data-guide={!vs.length ? "verifier" : undefined} disabled={submitting} className="mt-1.5 max-w-72" />}
            </div>
          )}
          <div className="flex items-center justify-end gap-1.5 pt-1">
            <button onClick={() => setForm(null)} disabled={submitting} className={btnGhost}>取消</button>
            <button data-action-feedback="local" data-guide="submit-confirm" disabled={submitting || finishing || !link.trim() || !vs.length} aria-busy={submitting && !submitted.confirmed} onClick={submitForReview} className={cx(btn, "liquid-button min-w-24")}><LiquidButtonFace><Send />提交</LiquidButtonFace>{submitted.confirmed && <ActionFeedback variant="submit" message="已提交验收" />}</button>
          </div>
        </div>
      )}
      {(form === "block" || form === "reject") && (
        <div id={reasonId} key={form} data-guide-form={form === "reject" ? "" : undefined} className="form-entry mt-3 flex flex-wrap items-center gap-1.5 border-t border-line pt-3">
          <input
            data-guide={form === "reject" && !text.trim() ? "reject-reason" : undefined}
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && text.trim() && !e.nativeEvent.isComposing) void (form === "block" ? run(setStatus(item.id, "blocked", text.trim()), "已标记阻塞", "满 1 天会自动通知负责人") : run(verify(item.id, false, text.trim()), "已打回", "已记录原因，返工 +1")); }}
            placeholder={form === "block" ? "填写阻塞原因" : "填写需要修改的内容"}
            className={cx(field, "min-w-48 flex-1")}
          />
          <button onClick={() => setForm(null)} className={btnGhost}>取消</button>
          <button
            data-guide={form === "reject" ? "reject-confirm" : undefined}
            disabled={!text.trim()}
            onClick={() =>
              form === "block"
                ? run(setStatus(item.id, "blocked", text.trim()), "已标记阻塞", "满 1 天会自动通知负责人")
                : run(verify(item.id, false, text.trim()), "已打回", "已记录原因，返工 +1")
            }
            className={cx(btn2, "form-trigger form-trigger-warning")}
          >
            {form === "block" ? "标记阻塞" : "打回"}
          </button>
        </div>
      )}
    </div>
  );
}

function Activity({ item, active, open, composerId, focusRequest, linkedUpdate, onClose, onHundred }: {
  item: WorkItem; active: boolean; open: boolean; composerId: string; focusRequest: number;
  linkedUpdate: string | null;
  onClose: (restoreFocus?: boolean) => void; onHundred: () => void;
}) {
  const { items, postUpdate, editUpdate, retractUpdate, me, acc } = useStore();
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const leaf = item.kind !== "project" && !isInactive(items, item) && isLeaf(items, item.id) && item.status !== "done" && item.status !== "review" && !isPublishing(item.status) && (isAssignee(item, me) || canManage(items, item, acc));
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<Mentions>([]);
  const [action, setAction] = useState<{ mode: "edit" | "retract"; item: WorkItem; key: string; update: Update } | null>(null);
  const [editText, setEditText] = useState("");
  const [editMentions, setEditMentions] = useState<Mentions>([]);
  const [saving, setSaving] = useState(false);
  const [draftProgress, setProg] = useState<number | null>(null);
  const prog = draftProgress ?? item.progress;
  const noteInput = useRef<HTMLDivElement>(null);
  const canPost = !isInactive(items, item);
  useEffect(() => {
    if (!active || !linkedUpdate) return;
    document.getElementById(`activity-${item.id}-${linkedUpdate}`)?.scrollIntoView({ block: "nearest" });
  }, [active, item.id, linkedUpdate]);
  const focusedRequest = useRef(0);
  useEffect(() => {
    if (!active || !open || !canPost || focusedRequest.current === focusRequest) return;
    focusedRequest.current = focusRequest;
    noteInput.current?.focus();
  }, [active, open, canPost, focusRequest]);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [posting, setPosting] = useState(false);
  const updates = (active ? [item, ...descendants(items, item.id)] : []).flatMap((x) => x.updates.map((u, index) => ({
    ...u, x, kind: "update" as const, key: updateKey(u, index),
  })));
  const logs = (active ? item.log : []).map((l) => ({ ...l, text: readableLog(l.text, (id) => person(id).name), progress: undefined, x: item, attachmentIds: undefined, kind: "log" as const }));
  const all = [...updates, ...logs].map((e, i) => ({ ...e, i })).sort((a, b) => b.date.localeCompare(a.date) || (a.at && b.at ? b.at.localeCompare(a.at) : 0) || b.i - a.i);
  const clearDraft = () => { setText(""); setMentions([]); setAttachmentIds([]); setProg(null); };
  const send = async () => {
    if (!text.trim() || uploading || posting || (leaf && (!Number.isFinite(prog) || prog < 0 || prog > 100))) return;
    setPosting(true);
    try {
      const r = await postUpdate(item.id, text.trim(), leaf ? prog : undefined, attachmentIds, mentions.map(({ id }) => id));
      if (!r.ok) return;
      clearDraft();
      await acknowledge("publish");
      const finished = leaf && prog === 100;
      onClose(!finished);
      if (finished) onHundred();
    } finally { clearFeedback(); setPosting(false); }
  };
  const saveAction = async () => {
    if (!action || saving || (action.mode === "edit" && !editText.trim())) return;
    setSaving(true);
    try {
      const expected = action.update.editedAt ?? null;
      const result = action.mode === "edit"
        ? await editUpdate(action.item.id, action.key, editText.trim(), editMentions.map(({ id }) => id), expected)
        : await retractUpdate(action.item.id, action.key, expected);
      if (result.ok) setAction(null);
    } finally { setSaving(false); }
  };
  const actionFooter = (mentionButton?: ReactNode) => (
    <ModalFooter left={mentionButton}>
      <button type="button" disabled={saving} onClick={() => setAction(null)} className={btnGhost}>取消</button>
      <button type="button" disabled={saving || (action?.mode === "edit" && !editText.trim())} onClick={() => void saveAction()} className={btn}>
        {action?.mode === "edit" ? "保存修改" : "确认撤回"}
      </button>
    </ModalFooter>
  );
  return (
    <div hidden={!active} className="max-w-3xl space-y-4">
      {canPost && (
        <div id={composerId} hidden={!open} className="animate-fade-in">
          <AttachmentComposer itemId={item.id} ids={attachmentIds} onChange={setAttachmentIds} onBusyChange={setUploading}><div className="rounded-lg border border-line-strong bg-surface transition focus-within:border-focus/55">
            <MentionInput
              item={item} inputRef={noteInput} mentions={mentions} onMentions={setMentions}
              aria-label="动态内容"
              data-guide={leaf && !text.trim() ? "progress-note" : undefined}
              value={text}
              onChange={setText}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
              placeholder={leaf ? "说一句做到哪了：完成了什么、卡在哪、下一步…" : item.kind === "project" ? "写一条项目记录…" : "留言…"}
              className="min-h-14 w-full px-3 pt-2.5 text-[13px] leading-6"
              footer={(mentionButton) => <div className="space-y-1 px-2 pb-2 pt-1">
                {leaf && <ProgressEditor guidePreset={leaf && !!text.trim() && !(prog > 0)} value={prog} onChange={setProg} />}
                <div className="flex items-center gap-2">
                  {mentionButton}
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <span className="hidden text-[11px] text-fg-4 sm:inline">⌘ + 回车发布</span>
                    <button type="button" disabled={uploading || posting} onClick={() => { clearDraft(); onClose(); }} className={cx(btnGhost, sm)}>取消</button>
                    <button data-action-feedback="local" data-guide={leaf ? "publish-progress" : undefined} disabled={!text.trim() || uploading || posting || (leaf && (!Number.isFinite(prog) || prog < 0 || prog > 100))} onClick={send} className={cx(btn, sm, "liquid-button min-w-18", confirmed && "disabled:opacity-100")} aria-busy={posting && !confirmed}><LiquidButtonFace><Send />发布</LiquidButtonFace>{confirmed && <ActionFeedback variant="publish" message="已发布" />}</button>
                  </div>
                </div>
              </div>}
            />
          </div></AttachmentComposer>
        </div>
      )}
      {all.length ? (
        <ol className="relative space-y-4 pl-7 before:absolute before:inset-y-1 before:left-[9px] before:w-px before:bg-line">
          {all.map((u) => (
            <li key={u.kind === "update" ? `${u.x.id}-${u.key}` : `log-${u.i}`}
              id={u.kind === "update" ? `activity-${u.x.id}-${u.key}` : undefined}
              className={cx("relative scroll-m-4 text-sm", u.kind === "update" && u.x.id === item.id && u.key === linkedUpdate && "rounded-sm bg-accent-soft")}>
              <span className="absolute -left-7 top-0">
                {u.kind === "update" ? <Avatar id={u.by} size={5} className="ring-4 ring-surface" /> : <span className="ml-[6px] mt-1.5 block h-2 w-2 rounded-full bg-line-strong ring-4 ring-surface" />}
              </span>
              <div className="flex flex-wrap items-center gap-x-2 text-xs text-fg-2">
                <span className="text-[13px] font-semibold text-fg">{person(u.by).name}</span>
                {u.x.id !== item.id && <Link href={`/item/${u.x.id}`} className="hover:text-fg hover:underline">{u.x.title}</Link>}
                {u.progress !== undefined && <span className="rounded bg-sunken px-1.5 tabular-nums">进度 {u.progress}%</span>}
                <span>{fmt(u.date)}</span>
                {u.kind === "update" && u.editedAt && !u.retractedAt && <span>已编辑</span>}
                {u.kind === "update" && !isInactive(items, u.x) && editableUpdate(u, me) && (
                  <Menu>
                    <MenuTrigger asChild><button type="button" aria-label="动态操作" className={cx(iconBtn, "ml-auto size-6")}><MoreHorizontal /></button></MenuTrigger>
                    <MenuContent align="end">
                      <MenuItem icon={<Pencil />} onSelect={() => { setEditText(u.text); setEditMentions(u.mentions ?? []); setAction({ mode: "edit", item: u.x, key: u.key, update: u }); }}>编辑动态</MenuItem>
                      <MenuItem icon={<Undo2 />} onSelect={() => setAction({ mode: "retract", item: u.x, key: u.key, update: u })}>撤回动态</MenuItem>
                    </MenuContent>
                  </Menu>
                )}
              </div>
              {u.kind === "update" && u.retractedAt ? (
                <p className="mt-1 inline-flex max-w-full items-center gap-1.5 rounded bg-sunken px-2 py-0.5 text-fg-2">
                  <Undo2 aria-hidden className="size-3.5 shrink-0" />已撤回一条动态
                </p>
              ) : (
                <><div className={cx("mt-1 whitespace-pre-wrap wrap-anywhere leading-6", u.kind === "log" ? "text-fg-2" : "text-fg")}>
                  {u.kind === "update" ? <MentionText text={u.text} mentions={u.mentions} /> : u.text}
                </div><AttachmentList ids={u.attachmentIds} /></>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <Empty>还没有动态</Empty>
      )}
      {action && <Modal open onOpenChange={(open) => { if (!open && !saving) setAction(null); }}
        title={action.mode === "edit" ? "编辑动态" : "撤回动态"}
        desc={action.mode === "retract" ? "正文和附件会从动态中移除，已记录的进度会保留。已送达的飞书预览可能仍可见。" : undefined}>
        {action.mode === "edit" ? <MentionInput item={action.item} autoFocus aria-label="编辑动态内容" value={editText} onChange={setEditText}
          mentions={editMentions} onMentions={setEditMentions} className={cx(field, "mx-5 my-4 min-h-24 w-[calc(100%-2.5rem)]! py-2")}
          footer={actionFooter} /> : actionFooter()}
      </Modal>}
    </div>
  );
}

function Checklist({ item }: { item: WorkItem }) {
  const { toggleCheck, items, acc } = useStore();
  const [action, setAction] = useState<{ type: "add" } | { type: "edit" | "delete"; check: CheckItem } | null>(null);
  const toast = useToast();
  const verifier = canVerify(items, item, acc);
  const manager = canManage(items, item, acc);
  const names = verifiersOf(items, item).filter((v) => verifierAllowed(item, v)).map((v) => person(v).name).join("、") || "验证人";
  const canEdit = item.kind === "project" && manager && !isInactive(items, item);
  const checks = visibleChecks(items, item);
  // 与服务端 toggleCheck 规则一致：评审 / 测试 / 验收类只能由验证人确认，其余验证人或项目管理者都可以
  const blockedReason = ({ id, label }: CheckItem) => {
    if (isInactive(items, item)) return "已取消或已归档，不能修改";
    if (id === "code-review" && isAssignee(item, acc.id)) return "需由执行人以外的验证人确认";
    if (/评审|测试|验收/.test(label)) return verifier ? undefined : `需由${names}确认`;
    return verifier || manager ? undefined : `需由${names}或项目负责人确认`;
  };
  return (
    <div className="max-w-3xl space-y-3">
      {canEdit && <div className="flex justify-end"><button type="button" className={cx(btn2, sm)} onClick={() => setAction({ type: "add" })}><Plus />添加检查项</button></div>}
      <Card>
        {!checks.length && <Empty>暂无检查项</Empty>}
        <ul className="divide-y divide-line">
          {checks.map((c) => {
            const auto = autoCheck(items, item, c);
            const ok = auto ?? c.done;
            const why = blockedReason(c);
            return (
              <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                <input type="checkbox" id={`chk-${item.id}-${c.id}`} checked={ok} disabled={auto !== undefined || !!why} title={auto === undefined ? why : "由系统自动判断"} onChange={async () => { if ((await toggleCheck(item.id, c.id)).ok && !c.done) toast("已确认", c.label); }} className="h-4 w-4 accent-[var(--color-accent)] transition disabled:cursor-not-allowed" />
                <label htmlFor={`chk-${item.id}-${c.id}`} className={cx("flex-1", ok && "text-fg-3 line-through decoration-line-strong", auto === undefined && !why && "cursor-pointer")}>{c.label}</label>
                {auto === undefined && !ok && why && <span className="text-xs text-fg-4">{why}</span>}
                {auto !== undefined && <Badge className="bg-sunken text-fg-2 ring-line-strong">自动</Badge>}
                {c.source === "AI 应用" && <Badge>{c.source}</Badge>}
                {auto === undefined && c.done && c.doneBy && <span className="text-xs text-fg-4">{person(c.doneBy).name} {c.doneAt && fmt(c.doneAt)}</span>}
                {canEdit && (
                  <Menu>
                    <MenuTrigger className={iconBtn} aria-label={`操作：${c.label}`}><MoreHorizontal /></MenuTrigger>
                    <MenuContent align="end">
                      <MenuItem icon={<Pencil />} onSelect={() => setAction({ type: "edit", check: c })}>编辑</MenuItem>
                      <MenuItem icon={<Trash2 />} onSelect={() => setAction({ type: "delete", check: c })}>删除</MenuItem>
                    </MenuContent>
                  </Menu>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      {canEdit && action && <ProjectCheckDialog itemId={item.id} check={"check" in action ? action.check : undefined} deleting={action.type === "delete"} onClose={() => setAction(null)} />}
    </div>
  );
}

function ProjectCheckDialog({ itemId, check, deleting, onClose }: { itemId: string; check?: CheckItem; deleting: boolean; onClose: () => void }) {
  const { saveProjectCheck, deleteProjectCheck } = useStore();
  const [label, setLabel] = useState(check?.label ?? "");
  const [busy, setBusy] = useState(false);
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const submit = async () => {
    if (busy || !label.trim()) return;
    setBusy(true);
    try {
      const result = deleting && check ? await deleteProjectCheck(itemId, check.id) : await saveProjectCheck(itemId, label.trim(), check?.id);
      if (result.ok) { await acknowledge(); onClose(); }
    } finally { clearFeedback(); setBusy(false); }
  };
  return (
    <Modal open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={deleting ? "删除检查项" : check ? "编辑检查项" : "添加检查项"}>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="space-y-2 px-5 py-4">
          {deleting ? <p className="break-words text-sm">删除「{check?.label}」？</p> : (
            <label className="block text-sm">
              检查内容
              <input required maxLength={200} disabled={busy} value={label} onChange={(event) => setLabel(event.target.value)} className={cx(field, "mt-1")} />
            </label>
          )}
          {!deleting && check?.done && <p className="text-xs text-fg-3">修改内容后需要重新确认。</p>}
        </div>
        <ModalFooter>
          <button type="button" className={btnGhost} disabled={busy} onClick={onClose}>取消</button>
          <button data-action-feedback="local" type="submit" className={cx(deleting ? cx(btn2, "text-danger") : btn, !deleting && "liquid-button", "min-w-24", confirmed && "disabled:opacity-100")} disabled={busy || !label.trim()} aria-busy={busy && !confirmed}>
            {deleting ? "删除" : <LiquidButtonFace>保存</LiquidButtonFace>}{confirmed && <ActionFeedback variant={deleting ? "danger" : "ripple"} message={deleting ? "已删除" : "已保存"} />}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function Defects({ item }: { item: WorkItem }) {
  const { items, acc, can, fixDefect } = useStore();
  const toast = useToast();
  const scope = [item, ...descendants(items, item.id)];
  const defects = scope.flatMap((x) => x.defects.map((d) => ({ ...d, x })));
  const [open, setOpen] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);

  async function fix(itemId: string, defectId: string) {
    if (fixing) return;
    setFixing(defectId);
    try { if ((await fixDefect(itemId, defectId)).ok) toast("已标记修复"); }
    finally { setFixing(null); }
  }

  return (
    <Card>
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h3 className="text-sm font-semibold">缺陷</h3>
        {can("quality") && !isInactive(items, item) && <button type="button" onClick={() => setOpen(true)}
          className={cx(btnGhost, sm)}><Plus />登记缺陷</button>}
      </div>
      {open && <DefectDialog item={item} onClose={() => setOpen(false)} />}
      {defects.length ? (
        <ul className="divide-y divide-line">
          {defects.map((x) => (
            <li key={`${x.x.id}-${x.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              <div className="min-w-[min(100%,12rem)] flex-1">
                <AttachmentList ids={x.attachmentIds} inlineWith={
                  <div className="flex items-start gap-2">
                    <Badge className={x.severity <= "P1" ? "bg-danger-soft text-danger ring-danger/40" : undefined}>{x.severity}</Badge>
                    <div className="min-w-0">
                      <Link href={`/item/${x.x.id}/defect/${x.id}`} className="wrap-anywhere font-medium text-accent hover:underline">{x.title}</Link>
                      <div className="mt-0.5 wrap-anywhere text-xs text-fg-3">
                        {x.x.id !== item.id && <>{x.x.title} · </>}{x.foundAt}发现{x.foundAt === "线上" && <span className="text-danger">（逃逸）</span>} · {person(x.owner).name} · {x.status === "open" ? <span className="text-fg">未关闭</span> : "已修复"}
                      </div>
                    </div>
                  </div>
                } />
              </div>
              {x.status === "open" && canMaintainDefect(items, x.x, x, acc) &&
                <button disabled={fixing !== null} onClick={() => void fix(x.x.id, x.id)} className="ml-auto shrink-0 text-xs text-ok hover:underline">
                  {fixing === x.id ? "处理中…" : "标记已修复"}
                </button>}
            </li>
          ))}
        </ul>
      ) : (
        !open && <Empty>暂无缺陷</Empty>
      )}
    </Card>
  );
}

function Eval({ item }: { item: WorkItem }) {
  const { addBadCase, setBadCase } = useStore();
  const e = item.eval!;
  const latest = e.prompts[e.prompts.length - 1];
  const pass = latest.passRate >= e.threshold;
  const pending = e.badCases.filter((b) => b.status === "待处理").length;
  const [bc, setBc] = useState({ input: "", expected: "", actual: "" });
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card className="p-4">
          <div className="text-xs text-fg-3">{e.metric}（{latest.version}）</div>
          <div className={cx("mt-1 text-2xl font-semibold tabular-nums", pass ? "text-ok" : "text-danger")}>{latest.passRate}%</div>
          <div className="text-xs text-fg-4">目标 ≥ {e.threshold}%</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-fg-3">成本 / 千次调用</div>
          <div className={cx("mt-1 text-2xl font-semibold tabular-nums", e.costPerK <= e.costBudget ? "text-ok" : "text-danger")}>¥{e.costPerK}</div>
          <div className="text-xs text-fg-4">预算 ¥{e.costBudget}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-fg-3">P95 延迟</div>
          <div className="mt-1 text-2xl font-semibold tabular-nums">{(e.latencyP95 / 1000).toFixed(1)}s</div>
          <div className="text-xs text-fg-4">{e.model}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-fg-3">待处理 Bad Case</div>
          <div className={cx("mt-1 text-2xl font-semibold tabular-nums", pending ? "text-fg" : "text-ok")}>{pending}</div>
          <div className="text-xs text-fg-4">共 {e.badCases.length} 条</div>
        </Card>
      </div>
      <Card className="p-4">
        <h3 className="text-sm font-semibold">Prompt 版本与评测结果 <span className="font-normal text-fg-4">· {e.dataset}（{e.datasetSize} 条）</span></h3>
        <div className="mt-4 space-y-2">
          {e.prompts.map((p) => (
            <div key={p.version} className="flex items-center gap-3 text-sm">
              <span className="w-8 font-medium">{p.version}</span>
              <div className="relative h-5 flex-1 rounded bg-sunken">
                <div className={cx("h-full rounded", p.passRate >= e.threshold ? "bg-st-done" : "bg-fg-4")} style={{ width: `${p.passRate}%` }} />
                <div className="absolute inset-y-0 border-l-2 border-dashed border-danger/40" style={{ left: `${e.threshold}%` }} />
              </div>
              <span className="w-10 text-right tabular-nums">{p.passRate}%</span>
              <span className="hidden w-40 truncate text-xs text-fg-3 md:block">{p.note}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card className="overflow-x-auto">
        <h3 className="border-b border-line px-4 py-3 text-sm font-semibold">Bad Case <span className="font-normal text-fg-4">· 产品、测试、开发都可以随手补充</span></h3>
        <div className="flex flex-wrap gap-2 border-b border-line bg-canvas px-4 py-3">
          <input value={bc.input} onChange={(x) => setBc({ ...bc, input: x.target.value })} placeholder="输入" className={cx(field, "w-48! py-1.5")} />
          <input value={bc.expected} onChange={(x) => setBc({ ...bc, expected: x.target.value })} placeholder="期望" className={cx(field, "w-40! py-1.5")} />
          <input value={bc.actual} onChange={(x) => setBc({ ...bc, actual: x.target.value })} placeholder="实际" className={cx(field, "w-40! py-1.5")} />
          <button disabled={!bc.input.trim()} onClick={async () => { if ((await addBadCase(item.id, bc)).ok) setBc({ input: "", expected: "", actual: "" }); }} className={cx(btn, "py-1.5")}>添加</button>
        </div>
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-xs text-fg-3">
            <tr className="border-b border-line">
              {["输入", "期望", "实际", "状态", "提交人"].map((h) => <th key={h} className="px-4 py-2 font-normal">{h}</th>)}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {e.badCases.map((b) => (
              <tr key={b.id}>
                <td className="px-4 py-3">{b.input}</td>
                <td className="px-4 py-3 text-fg-2">{b.expected}</td>
                <td className="px-4 py-3 text-fg-2">{b.actual}</td>
                <td className="px-4 py-3">
                  <Select label="状态" value={b.status} onValueChange={(value) => setBadCase(item.id, b.id, value as typeof b.status)}
                    className={cx("w-auto! whitespace-nowrap px-1.5 py-0.5 text-xs", b.status === "已修复" ? "bg-ok-soft text-ok" : "bg-sunken text-fg-2")}
                    options={["待处理", "已修复", "已豁免"].map((s) => ({ value: s, label: s }))} />
                </td>
                <td className="px-4 py-3"><People ids={[b.by]} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
