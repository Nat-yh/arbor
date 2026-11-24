import type { ReactNode } from "react";
import AvatarPhoto from "./AvatarPhoto";
import { daysBetween, fmt, person, STATUS, today, type Status, type WorkItem } from "@/lib/model";
import { dueStateOf, levelLabel, projectWorkCounts, type Items } from "@/lib/tree";

export function cx(...c: (string | false | undefined | null)[]) {
  return c.filter(Boolean).join(" ");
}

// ───────── 按钮 / 输入框（class 形式，便于 Link、label 复用）─────────

const btnBase =
  "inline-flex h-8 shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-medium arbor-control disabled:pointer-events-none disabled:opacity-45 [&_svg]:h-3.5 [&_svg]:w-3.5";
/** 主按钮：品牌色 */
export const btn = cx(btnBase, "arbor-primary bg-accent text-white shadow-[inset_0_1px_0_rgb(255_255_255/0.12)]");
/** 次按钮：白底细边 */
export const btn2 = cx(btnBase, "bg-surface text-fg-2 shadow-[0_1px_1px_rgb(15_15_30/0.04)] ring-1 ring-line-strong hover:bg-hover hover:text-fg");
/** 幽灵按钮：无边框 */
export const btnGhost = cx(btnBase, "px-2 font-normal text-fg-3 hover:bg-hover hover:text-fg");
/** 危险按钮 */
export const btnDanger = cx(btnBase, "bg-danger text-white hover:opacity-90");
/** 小号修饰 */
export const sm = "h-7 px-2.5 text-xs";
export const iconBtn = "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-3 arbor-control hover:bg-hover hover:text-fg [&_svg]:h-4 [&_svg]:w-4";

export const field =
  "w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] text-fg outline-none transition placeholder:text-fg-4 focus:border-focus";

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <kbd className={cx("inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line-strong bg-surface px-1 font-sans text-[10px] font-medium text-fg-3", className)}>{children}</kbd>;
}

// ───────── 容器 ─────────

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-lg border border-line bg-surface", className)}>{children}</div>;
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cx("inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded px-1.5 text-[11px] font-medium", className ?? "bg-sunken text-fg-2")}>
      {children}
    </span>
  );
}

export const AiBadge = () => <Badge className="bg-accent-soft text-accent-fg">AI</Badge>;

const itemTypeStyle = {
  项目: "bg-violet-50 text-violet-800",
  需求: "bg-accent-soft text-accent-fg",
  任务: "bg-sunken text-fg-2",
  子任务: "border border-line-strong text-fg-3",
};

export function ItemTypeBadge({ items, item }: { items: Items; item: WorkItem }) {
  const type = levelLabel(items, item);
  return <Badge className={itemTypeStyle[type]}>{type}</Badge>;
}

// ───────── 状态 ─────────

/** 状态图标：Linear 式的圆形进度符号，颜色即语义 */
export function StatusIcon({ s, className }: { s: Status; className?: string }) {
  const c = cx("h-3.5 w-3.5 shrink-0", STATUS[s].color, className);
  switch (s) {
    case "todo":
      return <svg viewBox="0 0 14 14" className={c} aria-hidden><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="2.2 1.8" /></svg>;
    case "doing":
      return <svg viewBox="0 0 14 14" className={c} aria-hidden><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M7 3.5 A3.5 3.5 0 0 1 7 10.5 Z" fill="currentColor" /></svg>;
    case "release":
    case "production-review":
    case "review":
      return <svg viewBox="0 0 14 14" className={c} aria-hidden><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" /><path d="M7 3.5 A3.5 3.5 0 1 1 3.5 7 L7 7 Z" fill="currentColor" /></svg>;
    case "done":
      return <svg viewBox="0 0 14 14" className={c} aria-hidden><circle cx="7" cy="7" r="6.25" fill="currentColor" /><path d="M4.4 7.2 6.2 9 9.7 5.3" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>;
    case "blocked":
      return <svg viewBox="0 0 14 14" className={c} aria-hidden><circle cx="7" cy="7" r="6.25" fill="currentColor" /><path d="M7 3.9v3.6" stroke="white" strokeWidth="1.6" strokeLinecap="round" /><circle cx="7" cy="9.9" r="0.95" fill="white" /></svg>;
    case "cancelled":
      return <svg viewBox="0 0 14 14" className={c} aria-hidden><circle cx="7" cy="7" r="6.25" fill="currentColor" /><path d="m5 5 4 4M9 5 5 9" stroke="white" strokeWidth="1.5" strokeLinecap="round" /></svg>;
  }
}

/** 兼容旧调用：图标 + 文字，可选「含阻塞」 */
export function StatusBadge({ s, blocked, label }: { s: Status; blocked?: boolean; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px]">
      <StatusIcon s={s} />
      <span className={STATUS[s].cls}>{label ?? STATUS[s].label}</span>
      {blocked && s !== "blocked" && <span className="rounded bg-danger-soft px-1 text-[11px] font-medium text-danger">含阻塞</span>}
    </span>
  );
}

// ───────── 人 ─────────

const HUES = [272, 200, 155, 30, 340, 60, 240, 300, 180, 10];
export function hueOf(id: string) {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

export function Avatar({ id, size = 6, className }: { id: string; size?: 4 | 5 | 6 | 8; className?: string }) {
  const p = person(id);
  const sz = size === 4 ? "h-4 w-4 text-[9px]" : size === 5 ? "h-5 w-5 text-[10px]" : size === 6 ? "h-6 w-6 text-[11px]" : "h-8 w-8 text-xs";
  if (!id || id === "—") return <span title="未分配" className={cx("inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-fg-4", sz, className)} />;
  const h = hueOf(id);
  return (
    <span
      title={`${p.name}${p.title ? ` · ${p.title}` : ""}`}
      style={{ background: `oklch(0.93 0.045 ${h})`, color: `oklch(0.42 0.11 ${h})` }}
      className={cx("relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden rounded-full font-medium", sz, className)}
    >
      {p.name.slice(-1)}
      {p.avatarUrl && <AvatarPhoto key={p.avatarUrl} url={p.avatarUrl} />}
    </span>
  );
}

export function People({ ids }: { ids: string[] }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      {ids.map((id) => (
        <span key={id} className="inline-flex items-center gap-1.5 whitespace-nowrap text-[13px] text-fg-2">
          <Avatar id={id} size={5} />
          {person(id).name}
        </span>
      ))}
    </span>
  );
}

export function AvatarStack({ ids, max = 5 }: { ids: string[]; max?: number }) {
  const shown = ids.slice(0, max);
  return (
    <span className="inline-flex items-center -space-x-1.5">
      {shown.map((id) => <Avatar key={id} id={id} size={5} className="ring-2 ring-surface" />)}
      {ids.length > max && <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-sunken px-1 text-[10px] text-fg-3 ring-2 ring-surface">+{ids.length - max}</span>}
    </span>
  );
}

// ───────── 日期 / 进度 ─────────

/** 相对日期：逾期 N 天 / 今天 / 明天 / 剩 N 天 / 远期日期 */
export function relDue(due: string, asOf = today()) {
  const d = daysBetween(asOf, due);
  if (d < 0) return `逾期 ${-d} 天`;
  if (d === 0) return "今天";
  if (d === 1) return "明天";
  if (d <= 7) return `剩 ${d} 天`;
  return fmt(due);
}

export function DueText({ items, item, className }: { items: Items; item: WorkItem; className?: string }) {
  const s = dueStateOf(items, item);
  if (s === "done") return <span className={cx("shrink-0 whitespace-nowrap text-xs text-fg-4", className)}>{item.doneAt ? `${fmt(item.doneAt)} 完成` : "已完成"}</span>;
  const cls = s === "overdue" ? "font-medium text-danger" : s === "soon" ? "font-medium text-warn" : "text-fg-3";
  return <span title={`截止 ${item.due}`} className={cx("shrink-0 whitespace-nowrap text-xs tabular-nums", cls, className)}>{relDue(item.due)}</span>;
}

export function ProjectWorkCounts({ items, projectId, compact = false }: { items: Items; projectId: string; compact?: boolean }) {
  const { doing, todo } = projectWorkCounts(items, projectId);
  if (compact) return (
    <span className="shrink-0 text-[11px] tabular-nums text-fg-3" title={`进行中 ${doing} 项，未开始 ${todo} 项`}>
      <span className="sr-only">进行中和未开始的需求与任务共 </span>{doing + todo}
    </span>
  );
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-xs tabular-nums text-fg-3">
      <span className="whitespace-nowrap">进行中 <span className="font-medium text-fg">{doing}</span></span>
      <span className="whitespace-nowrap">未开始 <span className="font-medium text-fg">{todo}</span></span>
    </span>
  );
}

export function Progress({ value, plan, className, width = "w-16" }: { value: number; plan?: number; className?: string; width?: string }) {
  const lag = plan !== undefined && plan - value >= 20;
  return (
    <div className={cx("flex items-center gap-2", className)} title={plan !== undefined ? `实际 ${value}% · 按时间应达 ${plan}%` : `${value}%`}>
      <div className={cx("relative h-1 rounded-full bg-sunken", width)}>
        <div className={cx("h-full rounded-full transition-[width,background-color] duration-300 ease-out", value === 100 ? "bg-st-done" : lag ? "bg-st-blocked" : "bg-accent")} style={{ width: `${value}%` }} />
        {plan !== undefined && plan > 0 && plan < 100 && <div className="absolute -top-[3px] h-2.5 w-0.5 rounded-full bg-fg-4" style={{ left: `${plan}%` }} />}
      </div>
      <span className="w-8 text-right text-xs tabular-nums text-fg-3">{value}%</span>
    </div>
  );
}

// ───────── 页面结构 ─────────

export function PageHeader({ title, desc, action }: { title: ReactNode; desc?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight text-fg">{title}</h1>
        {desc && <p className="mt-1 text-[13px] text-fg-3">{desc}</p>}
      </div>
      {action}
    </div>
  );
}

export function Stat({ label, value, hint, tone, icon: I }: { label: string; value: ReactNode; hint?: string; tone?: "red" | "amber" | "green"; icon?: React.ComponentType<{ className?: string }> }) {
  const c = tone === "red" ? "text-danger" : tone === "amber" ? "text-warn" : tone === "green" ? "text-ok" : "text-fg";
  return (
    <Card className="p-4">
      <div className="flex items-center gap-1.5 text-xs text-fg-3">{I && <I className="h-3.5 w-3.5 text-fg-4" />}{label}</div>
      <div className={cx("mt-1.5 text-2xl font-semibold tabular-nums tracking-tight", c)}>{value}</div>
      {hint && <div className="mt-1 text-xs text-fg-4">{hint}</div>}
    </Card>
  );
}

export const Empty = ({ children }: { children: ReactNode }) => <div className="px-4 py-8 text-center text-[13px] text-fg-4">{children}</div>;

export const LEVEL_CLS = { urgent: "bg-st-blocked", warn: "bg-st-doing", info: "bg-st-todo" };

export function NoAccess({ text }: { text: string }) {
  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-line bg-surface p-8 text-center">
      <div className="text-[15px] font-semibold">没有访问权限</div>
      <p className="mt-2 text-[13px] text-fg-3">{text}</p>
    </div>
  );
}
