"use client";

/**
 * 迭代（版本）：一个项目 = 一个系统，按版本节奏推进。
 * 迭代挂在项目上；需求 / 任务归入迭代，下级默认沿用上级；结束迭代时没做完的结转到下一期。
 */
import { CalendarRange, Check, ChevronDown, ChevronRight, Flag, Inbox, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { canEditPlan, canManage } from "@/lib/access";
import { dateOffset, daysBetween, fmt, today, type Iteration, type WorkItem } from "@/lib/model";
import { useStore } from "@/lib/store";
import { BACKLOG, currentIteration, doneInIteration, isInactive, iterationOf, iterationPhase, iterationScope, iterationStats, levelLabel, parentIterationOf, projectOf, statusOf, type IterationPhase } from "@/lib/tree";
import { ActionFeedback, LiquidButtonFace, useActionFeedback } from "./ActionFeedback";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Modal, ModalFooter, Tip } from "./kit";
import { usePeek } from "./Peek";
import { DateField, DueCell, PersonCell, StatusCell } from "./pickers";
import { useToast } from "./Toast";
import { Badge, btn, btn2, btnGhost, Card, cx, field, iconBtn, Progress, sm } from "./ui";

const PHASE: Record<IterationPhase, { label: string; cls: string }> = {
  active: { label: "进行中", cls: "bg-accent-soft text-accent-fg" },
  overdue: { label: "已到期未结束", cls: "bg-warn-soft text-warn" },
  planned: { label: "未开始", cls: "bg-sunken text-fg-3" },
  closed: { label: "已结束", cls: "bg-sunken text-fg-4" },
};

const openIterations = (project: WorkItem) => (project.iterations ?? []).filter((i) => !i.closedAt).sort((a, b) => a.start.localeCompare(b.start));

function phaseText(it: Iteration, asOf = today()) {
  const phase = iterationPhase(it, asOf);
  if (phase === "active") { const left = daysBetween(asOf, it.end); return left === 0 ? "今天结束" : `剩 ${left} 天`; }
  if (phase === "overdue") return `已超出 ${daysBetween(it.end, asOf)} 天`;
  if (phase === "planned") return `${daysBetween(asOf, it.start)} 天后开始`;
  return it.closedAt ? `${fmt(it.closedAt)} 结束` : "";
}

/** 名称自动递增：V2.2 → V2.3，第 3 迭代 → 第 4 迭代 */
function nextName(last?: string) {
  if (!last) return "";
  const m = /(\d+)(?!.*\d)/.exec(last);
  return m ? last.slice(0, m.index) + (Number(m[1]) + 1) + last.slice(m.index + m[1].length) : "";
}

// ───────── 工作项上的迭代胶囊：显示 + 就地修改 ─────────

/** 迭代胶囊：显示实际所属迭代（沿用上级的显示为浅色），可管理者点击改归属 */
export function IterationCell({ item, compact }: { item: WorkItem; compact?: boolean }) {
  const { items, acc, edit } = useStore();
  const toast = useToast();
  const project = projectOf(items, item);
  if (item.kind === "project" || !project.iterations?.length) return null;
  const it = iterationOf(items, item);
  const inherited = !!it && !item.iteration;
  const explicitBacklog = item.iteration === BACKLOG;
  const editable = !isInactive(items, item) && canEditPlan(items, item, acc);
  const label = it ? it.name : "待规划";
  const chipClass = cx("inline-flex h-6 max-w-[min(100%,8rem)] items-center gap-1 rounded-md px-1.5 text-xs align-middle",
    it ? (inherited ? "text-fg-3" : "text-fg-2") : "text-fg-4", compact && !it && "work-tree-unplanned");
  const chip = (
    <>
      <CalendarRange className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{label}</span>
    </>
  );
  if (!editable) {
    const display = <span title={label} className={chipClass}>{chip}</span>;
    return compact ? display : <Tip content={inherited ? "沿用上级的迭代" : "所属迭代"}>{display}</Tip>;
  }
  const parentIt = project.iterations.find((i) => i.id === parentIterationOf(items, item));
  // 上级的迭代还没结束时才能「沿用上级」；否则只能明确放进待规划
  const canInherit = !!parentIt && !parentIt.closedAt;
  const backlogValue = parentIt ? BACKLOG : null;
  const move = async (to: string | null) => {
    if ((to ?? undefined) === item.iteration) return;
    const name = to && to !== BACKLOG ? project.iterations!.find((i) => i.id === to)!.name : to === null && parentIt ? `沿用上级（${parentIt.name}）` : "待规划";
    const r = await edit(item.id, { iteration: to ?? undefined }, `迭代 → ${name}`);
    if (r.ok) toast(`已移到「${name}」`);
  };
  return (
    <Menu>
      <MenuTrigger
        title={label}
        aria-label={`所属迭代：${label}，点击修改`}
        className={cx(chipClass, "cursor-pointer transition-colors hover:bg-active data-[state=open]:bg-active")}
        onClick={(event) => event.stopPropagation()}
      >
        {chip}
        {compact && <ChevronDown aria-hidden="true" className="size-3 shrink-0" />}
      </MenuTrigger>
      <MenuContent onClick={(e) => e.stopPropagation()}>
        <MenuLabel>移到迭代</MenuLabel>
        {openIterations(project).map((i) => (
          <MenuItem key={i.id} checked={item.iteration === i.id} hint={`${fmt(i.start)}–${fmt(i.end)}`} onSelect={() => void move(i.id)}>{i.name}</MenuItem>
        ))}
        {item.iteration && project.iterations.find((i) => i.id === item.iteration)?.closedAt && (
          <MenuItem checked disabled hint="已结束">{project.iterations.find((i) => i.id === item.iteration)!.name}</MenuItem>
        )}
        <MenuSeparator />
        {canInherit && <MenuItem checked={!item.iteration} onSelect={() => void move(null)}>沿用上级（{parentIt!.name}）</MenuItem>}
        <MenuItem checked={backlogValue ? explicitBacklog : !item.iteration} onSelect={() => void move(backlogValue)}>待规划</MenuItem>
      </MenuContent>
    </Menu>
  );
}

// ───────── 项目的「迭代」标签页 ─────────

export function ProjectIterations({ project }: { project: WorkItem }) {
  const { items, acc } = useStore();
  const manage = !isInactive(items, project) && canManage(items, project, acc);
  const [editing, setEditing] = useState<Iteration | "new" | null>(null);
  const [closing, setClosing] = useState<Iteration | null>(null);
  const list = project.iterations ?? [];
  const current = currentIteration(project);
  const upcoming = openIterations(project).filter((i) => i.id !== current?.id);
  const closed = list.filter((i) => i.closedAt).sort((a, b) => b.start.localeCompare(a.start));
  const backlog = iterationScope(items, project, null).filter((x) => statusOf(items, x) !== "done");

  return (
    <div className="max-w-5xl space-y-3">
      {list.length > 0 && manage && (
        <div className="flex justify-end">
          <button type="button" onClick={() => setEditing("new")} className={cx(btn, sm)}><Plus />新建迭代</button>
        </div>
      )}

      {!list.length && (
        <Card className="px-4 py-6 text-center">
          <p className="text-sm text-fg-3">暂无迭代</p>
          {manage && <button type="button" onClick={() => setEditing("new")} className={cx(btn, sm, "mt-3")}><Plus />新建迭代</button>}
        </Card>
      )}

      {current && <IterationCard key={current.id} project={project} it={current} highlight defaultOpen manage={manage} onEdit={() => setEditing(current)} onClose={() => setClosing(current)} />}
      {upcoming.map((it) => <IterationCard key={it.id} project={project} it={it} manage={manage} onEdit={() => setEditing(it)} onClose={() => setClosing(it)} />)}
      {list.length > 0 && <BacklogCard items={backlog} />}
      {closed.length > 0 && (
        <details className="group pt-2">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1 text-xs text-fg-3 transition-colors hover:text-fg">
            <ChevronRight className="h-3.5 w-3.5 transition group-open:rotate-90" />已结束的迭代 · {closed.length}
          </summary>
          <div className="mt-2 space-y-3">{closed.map((it) => <IterationCard key={it.id} project={project} it={it} manage={false} />)}</div>
        </details>
      )}

      {editing && <IterationDialog project={project} it={editing === "new" ? undefined : editing} onDone={() => setEditing(null)} />}
      {closing && <CloseDialog project={project} it={closing} onDone={() => setClosing(null)} />}
    </div>
  );
}

function IterationCard({ project, it, highlight, defaultOpen, manage, onEdit, onClose }: { project: WorkItem; it: Iteration; highlight?: boolean; defaultOpen?: boolean; manage: boolean; onEdit?: () => void; onClose?: () => void }) {
  const { items } = useStore();
  const [open, setOpen] = useState(!!defaultOpen);
  const phase = iterationPhase(it);
  const scope = iterationScope(items, project, it.id);
  const stats = iterationStats(items, scope, it.id);
  const to = it.summary?.to ? project.iterations?.find((i) => i.id === it.summary!.to)?.name ?? it.summary.toName ?? "已删除的迭代" : "待规划";
  return (
    <Card className={cx("overflow-hidden", highlight && "ring-1 ring-accent/30")}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <button onClick={() => setOpen((v) => !v)} className="flex min-w-0 flex-1 basis-64 items-center gap-2 text-left" aria-expanded={open}>
          {open ? <ChevronDown className="h-4 w-4 shrink-0 text-fg-4" /> : <ChevronRight className="h-4 w-4 shrink-0 text-fg-4" />}
          <span className="text-[15px] font-semibold text-fg">{it.name}</span>
          <Badge className={PHASE[phase].cls}>{PHASE[phase].label}</Badge>
          <span className="truncate text-xs tabular-nums text-fg-3">{fmt(it.start)} – {fmt(it.end)} · {phaseText(it)}</span>
        </button>
        {it.closedAt && it.summary ? (
          <span className="text-xs text-fg-3">完成 <b className="font-medium text-fg-2">{it.summary.done}/{it.summary.planned}</b>{it.summary.carried > 0 && ` · ${it.summary.carried} 项结转到「${to}」`}</span>
        ) : (
          <span className="flex items-center gap-3 text-xs text-fg-3">
            <Progress value={stats.progress} width="w-20" />
            <span className="tabular-nums">完成 {stats.done}/{stats.total}</span>
            {stats.overdue > 0 && <span className="text-danger">逾期 {stats.overdue}</span>}
            {stats.blocked > 0 && <span className="text-danger">阻塞 {stats.blocked}</span>}
          </span>
        )}
        {manage && !it.closedAt && (
          <span className="flex items-center gap-1">
            <Tip content="编辑迭代"><button onClick={onEdit} className={iconBtn} aria-label={`编辑迭代 ${it.name}`}><Pencil /></button></Tip>
            {phase !== "planned" && <button onClick={onClose} className={cx(btn2, sm)}><Flag />结束迭代…</button>}
          </span>
        )}
      </div>
      {it.goal && <p className="-mt-1 px-4 pb-3 pl-10 text-xs text-fg-3">目标：{it.goal}</p>}
      {open && <ItemRows items={scope} empty={it.closedAt ? "这个迭代没有记录到工作项" : "暂无工作项"} />}
    </Card>
  );
}

function BacklogCard({ items: list }: { items: WorkItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="overflow-hidden">
      <button onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-4 py-3 text-left" aria-expanded={open}>
        {open ? <ChevronDown className="h-4 w-4 shrink-0 text-fg-4" /> : <ChevronRight className="h-4 w-4 shrink-0 text-fg-4" />}
        <Inbox className="h-4 w-4 text-fg-3" />
        <span className="text-[13px] font-medium text-fg">待规划</span>
        <span className="text-xs text-fg-3">{list.length} 项未归入迭代、也没完成</span>
      </button>
      {open && <ItemRows items={list} empty="所有未完成的工作都已经归入迭代" />}
    </Card>
  );
}

function ItemRows({ items: list, empty }: { items: WorkItem[]; empty: string }) {
  const { items } = useStore();
  const peek = usePeek();
  if (!list.length) return <div className="border-t border-line px-4 py-6 text-center text-xs text-fg-4">{empty}</div>;
  return (
    <ul className="border-t border-line text-[13px]">
      {list.map((x) => {
        const parent = x.parentId ? items.find((p) => p.id === x.parentId) : undefined;
        return (
          <li key={x.id} onClick={() => peek.open(x.id)} className="flex min-h-10 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-4 py-1.5 last:border-b-0 hover:bg-hover">
            <span className="flex min-w-0 flex-1 basis-56 items-center gap-2">
              <span onClick={(e) => e.stopPropagation()}><StatusCell item={x} label={false} /></span>
              <span className="shrink-0 text-[11px] text-fg-4">{levelLabel(items, x)}</span>
              <span className={cx("truncate", statusOf(items, x) === "done" && "text-fg-3")}>{x.title}</span>
              {parent && parent.kind !== "project" && <span className="hidden truncate text-xs text-fg-4 sm:inline">· {parent.title}</span>}
            </span>
            <span className="flex items-center gap-3" onClick={(e) => e.stopPropagation()}>
              <PersonCell item={x} compact />
              <span className="w-16"><DueCell item={x} /></span>
              <IterationCell item={x} compact />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ───────── 新建 / 编辑 ─────────

function IterationDialog({ project, it, onDone }: { project: WorkItem; it?: Iteration; onDone: () => void }) {
  const { saveIteration, deleteIteration, items } = useStore();
  const toast = useToast();
  const last = [...(project.iterations ?? [])].sort((a, b) => a.end.localeCompare(b.end)).at(-1);
  const defaultStart = last && last.end >= today() ? dateOffset(last.end, 1) : today();
  const [f, setF] = useState({ name: it?.name ?? nextName(last?.name), start: it?.start ?? defaultStart, end: it?.end ?? dateOffset(it?.start ?? defaultStart, 13), goal: it?.goal ?? "" });
  const [busy, setBusy] = useState(false);
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const inUse = !!it && items.some((x) => x.iteration === it.id && !isInactive(items, x));
  const valid = f.name.trim() && f.start && f.end && f.start <= f.end;
  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const r = await saveIteration(project.id, { name: f.name.trim(), start: f.start, end: f.end, goal: f.goal.trim() || undefined }, it?.id);
      if (r.ok) { await acknowledge(); toast(it ? "迭代已更新" : `已新建迭代「${f.name.trim()}」`); onDone(); }
    } finally { clearFeedback(); setBusy(false); }
  };
  const remove = async () => {
    if (!it || busy) return;
    setBusy(true);
    try { const r = await deleteIteration(project.id, it.id); if (r.ok) { toast(`已删除迭代「${it.name}」`); onDone(); } } finally { setBusy(false); }
  };
  return (
    <Modal open onOpenChange={(v) => !v && !busy && onDone()} title={it ? `编辑迭代「${it.name}」` : "新建迭代"}>
      <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <div className="grid gap-3 px-5 pb-4 pt-3 sm:grid-cols-2">
          <label className="block text-xs text-fg-3 sm:col-span-2">名称<input autoFocus required maxLength={60} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="如 V2.3 或 第 4 迭代" className={cx(field, "mt-1")} /></label>
          <label className="block text-xs text-fg-3">开始<DateField label="开始日期" value={f.start} disabled={busy} onPick={(start) => setF((current) => ({ ...current, start }))} className="mt-1" /></label>
          <label className="block text-xs text-fg-3">结束<DateField label="结束日期" value={f.end} min={f.start} disabled={busy} onPick={(end) => setF((current) => ({ ...current, end }))} className="mt-1" /></label>
          <div className="flex flex-wrap gap-1.5 sm:col-span-2">
            {[7, 14, 21, 28].map((d) => <button type="button" key={d} onClick={() => setF({ ...f, end: dateOffset(f.start, d - 1) })} className={cx(btnGhost, sm, daysBetween(f.start, f.end) === d - 1 && "bg-accent-soft text-accent-fg")}>{d / 7} 周</button>)}
          </div>
          <label className="block text-xs text-fg-3 sm:col-span-2">目标 <span className="text-fg-4">（可选）</span><textarea rows={2} maxLength={500} value={f.goal} onChange={(e) => setF({ ...f, goal: e.target.value })} className={cx(field, "mt-1")} /></label>
          {f.start > f.end && <p className="text-xs text-danger sm:col-span-2">结束日期不能早于开始日期</p>}
        </div>
        <ModalFooter left={it && <Tip content={inUse ? "迭代里还有工作项，先移出才能删除" : "删除这个空迭代"}><span><button type="button" disabled={inUse || busy} onClick={() => void remove()} className={cx(btnGhost, sm, "text-danger")}><Trash2 />删除</button></span></Tip>}>
          <button type="button" onClick={onDone} disabled={busy} className={btnGhost}>取消</button>
          <button data-action-feedback="local" type="submit" disabled={!valid || busy} className={cx(btn, "liquid-button min-w-20")} aria-busy={busy && !confirmed}><LiquidButtonFace>{it ? "保存" : "新建"}</LiquidButtonFace>{confirmed && <ActionFeedback message={it ? "已保存" : "已新建"} />}</button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

// ───────── 结束迭代 ─────────

function CloseDialog({ project, it, onDone }: { project: WorkItem; it: Iteration; onDone: () => void }) {
  const { items, closeIteration } = useStore();
  const toast = useToast();
  const scope = iterationScope(items, project, it.id);
  const unfinished = scope.filter((x) => !doneInIteration(items, x, it.id));
  const targets = openIterations(project).filter((i) => i.id !== it.id);
  const [moveTo, setMoveTo] = useState<string | null>(targets.find((i) => i.start > it.start)?.id ?? targets[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const submit = async () => {
    setBusy(true);
    try {
      const r = await closeIteration(project.id, it.id, unfinished.length ? moveTo : null);
      if (r.ok) { await acknowledge(); toast(`迭代「${it.name}」已结束`, `完成 ${scope.length - unfinished.length}/${scope.length}${unfinished.length ? `，${unfinished.length} 项已结转` : ""}`); onDone(); }
    } finally { clearFeedback(); setBusy(false); }
  };
  const option = (id: string | null, title: ReactNode, hint: string) => (
    <label key={id ?? "backlog"} className={cx("flex cursor-pointer items-center gap-2.5 rounded-md px-3 py-2 ring-1 transition-colors", moveTo === id ? "bg-accent-soft/60 ring-accent/40" : "ring-line-strong hover:bg-hover")}>
      <input type="radio" name="moveTo" checked={moveTo === id} onChange={() => setMoveTo(id)} className="accent-[var(--color-accent)]" />
      <span className="text-[13px] text-fg">{title}</span><span className="text-xs text-fg-3">{hint}</span>
    </label>
  );
  return (
    <Modal open onOpenChange={(v) => !v && !busy && onDone()} title={`结束迭代「${it.name}」`} desc={`完成 ${scope.length - unfinished.length}/${scope.length} 项。结束后这一期的完成情况会留档，迭代不能再修改。`}>
      <div className="space-y-3 px-5 pb-4 pt-3 text-[13px]">
        {unfinished.length ? (
          <>
            <div className="text-xs text-fg-3">还有 {unfinished.length} 项没做完，结转到：</div>
            <div className="grid gap-1.5">
              {targets.map((i) => option(i.id, i.name, `${fmt(i.start)} – ${fmt(i.end)}`))}
              {option(null, "待规划", "先不排期，之后再归入迭代")}
            </div>
            <ul className="max-h-40 space-y-1 overflow-y-auto rounded-md bg-sunken px-3 py-2 text-xs text-fg-2">
              {unfinished.map((x) => <li key={x.id} className="flex items-center gap-2"><span className="shrink-0 text-fg-4">{levelLabel(items, x)}</span><span className="truncate">{x.title}</span></li>)}
            </ul>
            <p className="text-xs text-fg-4">已完成的子任务会留在「{it.name}」，只有没做完的部分跟着上级结转。</p>
          </>
        ) : (
          <p className="flex items-center gap-2 text-fg-2"><Check className="h-4 w-4 text-ok" />这一期的工作全部完成了。</p>
        )}
      </div>
      <ModalFooter>
        <button onClick={onDone} disabled={busy} className={btnGhost}>取消</button>
        <button data-action-feedback="local" onClick={() => void submit()} disabled={busy} className={cx(btn, "liquid-button")} aria-busy={busy && !confirmed}><LiquidButtonFace>{unfinished.length ? "结束并结转" : "结束迭代"}</LiquidButtonFace>{confirmed && <ActionFeedback message="已结束" />}</button>
      </ModalFooter>
    </Modal>
  );
}

/** 详情页属性行用：项目有迭代时才显示 */
export const hasIterations = (items: WorkItem[], item: WorkItem) => item.kind !== "project" && !!projectOf(items, item).iterations?.length;
