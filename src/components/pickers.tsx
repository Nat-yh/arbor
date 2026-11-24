"use client";

/**
 * 属性就地编辑：状态 / 人 / 截止日期。
 * 列表行、详情头部、抽屉共用；没有权限时退化为只读展示，并用提示说明原因。
 */
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Search, UserRound } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { canEditPlan, canManage, roleOf } from "@/lib/access";
import { assigneeIds, assigneeNames, isAssignee, isPublishing, statusLabel, dateOffset, fmt, PEOPLE, person, STATUS, today, type Person, type Status, type WorkItem } from "@/lib/model";
import { useStore } from "@/lib/store";
import { isInactive, isLeaf, openChecks, statusOf } from "@/lib/tree";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Modal, ModalFooter, Pop, PopClose, PopContent, PopTrigger, Tip } from "./kit";
import { useToast } from "./Toast";
import { Avatar, btn, btnGhost, cx, DueText, field, iconBtn, relDue, StatusBadge, StatusIcon } from "./ui";

// -mx-1.5 让悬停底色向两侧外扩、文字仍与列对齐；max-w 要把这 12px 补回来，否则在按内容定宽的容器里文字会溢出

const trigger = "inline-flex max-w-[calc(100%+12px)] items-center gap-1.5 rounded-md px-1.5 py-1 -mx-1.5 text-left transition-colors outline-none hover:bg-hover data-[state=open]:bg-active";

/** 可被指派的人：已启用、非访客 */
export function useAssignable(requireProjectAccess = false) {
  const { accounts } = useStore();
  return useMemo(() => PEOPLE.filter((p) => {
    const a = accounts.find((x) => x.id === p.id);
    return p.active !== false && (!a || (a.active && roleOf(a) !== "guest")) && (!requireProjectAccess || (a ? a.menus.includes("projects") : p.canReceiveAssignment));
  }), [accounts, requireProjectAccess]);
}

// ───────── 状态 ─────────

export function StatusCell({ item, label = true, size }: { item: WorkItem; label?: boolean; size?: "lg" }) {
  const { items, me, acc, setStatus } = useStore();
  const toast = useToast();
  const [blocking, setBlocking] = useState(false);
  const [reason, setReason] = useState("");
  const st = statusOf(items, item);
  const leaf = isLeaf(items, item.id);
  const inactive = isInactive(items, item);
  const editable = leaf && !inactive && !isPublishing(st) && item.kind !== "project" && (isAssignee(item, me) || canManage(items, item, acc));
  const view = label ? <StatusBadge s={st} label={statusLabel(st, item)} /> : <StatusIcon s={st} className={size === "lg" ? "h-4 w-4" : undefined} />;

  if (!editable) {
    const why = inactive ? "已取消或已归档" : isPublishing(st) ? "在需求详情处理" : !leaf ? "由子任务自动汇总" : item.kind === "project" ? "由下层汇总" : `由 ${assigneeNames(item)} 更新`;
    return <Tip content={`${statusLabel(st, item)} · ${why}`}><span className="inline-flex cursor-default items-center">{view}</span></Tip>;
  }

  const run = async (s: Status, r?: string) => {
    const res = await setStatus(item.id, s, r);
    if (res.ok) toast(`已改为「${STATUS[s].label}」`, item.title);
    return res.ok;
  };
  const doneBlock = item.kind !== "task" ? "需提交验收" : st === "review" ? "等待验收中" : openChecks(items, item).length ? "检查项未完成" : undefined;
  const options: Status[] = ["todo", "doing", "blocked", "done"];

  return (
    <span className="contents" onClick={(e) => e.stopPropagation()}>
      <Menu>
        <MenuTrigger className={trigger} aria-label={`状态：${statusLabel(st, item)}，点击修改`} onClick={(e) => e.stopPropagation()}>{view}</MenuTrigger>
        <MenuContent onClick={(e) => e.stopPropagation()}>
          <MenuLabel>改状态</MenuLabel>
          {options.map((s) => (
            <MenuItem
              key={s}
              icon={<StatusIcon s={s} />}
              checked={st === s}
              disabled={st === s || (s === "done" && !!doneBlock)}
              hint={s === "done" ? doneBlock : s === "doing" && st === "review" ? "撤回" : undefined}
              onSelect={() => { if (s === "blocked") { setReason(""); setBlocking(true); } else void run(s); }}
            >
              {s === "blocked" ? "阻塞…" : STATUS[s].label}
            </MenuItem>
          ))}
          {item.kind === "task" && st !== "review" && st !== "done" && <><MenuSeparator /><div className="px-2 py-1 text-[11px] text-fg-4">需要别人验收？在详情里「提交验收」</div></>}
        </MenuContent>
      </Menu>
      <Modal open={blocking} onOpenChange={setBlocking} title="标记阻塞" desc={`「${item.title}」卡在哪了？阻塞超过 1 天会自动通知负责人。`}>
        <div className="px-5 pb-4 pt-3">
          <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} onKeyDown={async (e) => { if (e.key === "Enter" && reason.trim() && (await run("blocked", reason.trim()))) setBlocking(false); }} placeholder="填写阻塞原因" className={field} />
        </div>
        <ModalFooter left="回车确认">
          <button className={btnGhost} onClick={() => setBlocking(false)}>取消</button>
          <button className={btn} disabled={!reason.trim()} onClick={async () => { if (await run("blocked", reason.trim())) setBlocking(false); }}>标记阻塞</button>
        </ModalFooter>
      </Modal>
    </span>
  );
}

// ───────── 人 ─────────

type PersonSelection =
  | { multiple?: false; value?: string; onPick: (id: string) => void }
  | { multiple: true; value: string[]; onPick: (ids: string[], baseline?: string[]) => void };

type PersonPickerProps = PersonSelection & {
  children: ReactNode;
  exclude?: string[];
  title?: string;
  people?: Person[];
  matchTriggerWidth?: boolean;
  keepOpen?: boolean;
  deferSelection?: boolean;
  minSelected?: number;
  requireProjectAccess?: boolean;
};

const personPickerEvents = new EventTarget();

export function PersonPicker(props: PersonPickerProps) {
  const { children, exclude = [], title = "指派给", people: options, matchTriggerWidth, keepOpen, deferSelection, minSelected = 0 } = props;
  const assignable = useAssignable(props.requireProjectAccess);
  const pickerId = useId();
  const replaced = useRef(false);
  const baseline = useRef<string[]>([]);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [hi, setHi] = useState(0);
  const search = q.trim().toLowerCase();
  const ids = props.multiple ? (deferSelection ? draft : props.value) : [];
  const selected = (id: string) => props.multiple ? ids.includes(id) : props.value === id;
  const candidates = options ?? (props.multiple ? PEOPLE.filter((p) => selected(p.id) || assignable.includes(p)) : assignable);
  const list = candidates.filter((p) => !exclude.includes(p.id) &&
    (!search || p.name.toLowerCase().includes(search) || p.title.toLowerCase().includes(search)));
  const locked = (id: string) => props.multiple && selected(id) && ids.length <= minSelected;
  useEffect(() => {
    if (!open) return;
    const closeWhenReplaced = (event: Event) => {
      if ((event as CustomEvent<string>).detail === pickerId) return;
      replaced.current = true;
      setOpen(false);
      setHi(0);
      setQ("");
    };
    personPickerEvents.addEventListener("open", closeWhenReplaced);
    return () => personPickerEvents.removeEventListener("open", closeWhenReplaced);
  }, [open, pickerId]);
  const changeOpen = (next: boolean) => {
    if (next) {
      replaced.current = false;
      if (deferSelection && props.multiple) {
        baseline.current = props.value;
        setDraft(props.value);
      }
      personPickerEvents.dispatchEvent(new CustomEvent("open", { detail: pickerId }));
    }
    setOpen(next);
    setHi(0);
    if (!next) setQ("");
  };
  const pick = (id: string) => {
    if (locked(id)) return;
    if (!props.multiple || !keepOpen) changeOpen(false);
    if (props.multiple) {
      const next = selected(id) ? ids.filter((value) => value !== id) : [...ids, id];
      if (deferSelection) setDraft(next);
      else props.onPick(next);
    } else if (!selected(id)) {
      props.onPick(id);
    }
  };
  return (
    <Pop open={open} onOpenChange={changeOpen}>
      <PopTrigger asChild>{children}</PopTrigger>
      <PopContent className={matchTriggerWidth ? "w-[max(15rem,var(--radix-popover-trigger-width))] border border-line" : "w-60 border border-line"}
        onClick={(e) => e.stopPropagation()} onCloseAutoFocus={(e) => { if (replaced.current) e.preventDefault(); }}>
        <div className="flex items-center gap-2 border-b border-line px-2 pb-1.5 pt-1">
          <Search className="h-3.5 w-3.5 text-fg-4" />
          <input
            autoFocus
            value={q}
            onChange={(e) => { setQ(e.target.value); setHi(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setHi((v) => Math.min(v + 1, Math.max(0, list.length - 1))); }
              if (e.key === "ArrowUp") { e.preventDefault(); setHi((v) => Math.max(v - 1, 0)); }
              if (e.key === "Enter" && !e.nativeEvent.isComposing) { e.preventDefault(); if (list[hi]) pick(list[hi].id); }
            }}
            aria-label={title}
            placeholder={`${title}…`}
            className="h-7 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4"
          />
        </div>
        <ul className="max-h-64 overflow-y-auto pt-1" role="listbox" aria-label={title} aria-multiselectable={props.multiple || undefined}>
          {list.map((p, i) => (
            <li key={p.id} role="option" aria-selected={selected(p.id)} aria-disabled={locked(p.id) || undefined}>
              <button type="button" disabled={locked(p.id)} onMouseEnter={() => setHi(i)} onClick={() => pick(p.id)} className={cx("person-picker-option flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] disabled:opacity-60", i === hi && "bg-hover")}>
                <Avatar id={p.id} size={5} />
                <span className="flex-1 truncate">{p.name}</span>
                <span className="text-[11px] text-fg-4">{p.title}</span>
                {selected(p.id) && (props.multiple ? <Check className="h-3.5 w-3.5 shrink-0 text-accent" aria-hidden /> : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" />)}
              </button>
            </li>
          ))}
          {!list.length && <li className="px-2 py-3 text-center text-xs text-fg-4">没有匹配的人</li>}
        </ul>
        {props.multiple && keepOpen && <div className="mt-1 flex items-center justify-between gap-2 border-t border-line px-2 pt-1.5 text-xs text-fg-3">
          <span aria-live="polite">已选 {ids.length} 人</span>
          <PopClose className={cx(btn, "h-7 px-2 text-xs")} onClick={() => {
            if (!deferSelection) return;
            const previous = baseline.current;
            if (ids.length !== previous.length || ids.some((id, index) => id !== previous[index])) props.onPick(ids, previous);
          }}>完成选择</PopClose>
        </div>}
      </PopContent>
    </Pop>
  );
}

export function PersonSelect(props: PersonSelection & {
  label: string;
  people?: Person[];
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  "data-guide"?: string;
  keepOpen?: boolean;
  requireProjectAccess?: boolean;
}) {
  const { label, placeholder = "请选择", className, disabled } = props;
  const ids = props.multiple ? props.value : props.value ? [props.value] : [];
  const summary = ids.map((id) => person(id).name).join("、") || placeholder;
  return (
    <PersonPicker {...props} title={`选择${label}`} matchTriggerWidth>
      <button type="button" disabled={disabled} data-guide={props["data-guide"]} aria-label={`${label}：${summary}`}
        className={cx(field, "arbor-control flex min-w-0 items-center gap-2 text-left hover:border-fg-4 disabled:opacity-50", className)}>
        {ids.length > 0 && <Avatar id={ids[0]} size={5} />}
        <span className="min-w-0 flex-1 truncate" title={summary}>{summary}</span>
        <ChevronDown aria-hidden className="size-3.5 shrink-0 text-fg-3" />
      </button>
    </PersonPicker>
  );
}

export function AssigneeAvatars({ ids }: { ids: string[] }) {
  const names = ids.map((id) => person(id).name).join("、") || "未分配";
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" role="img" aria-label={names} title={names}>
      {ids.length ? <Avatar id={ids[0]} size={5} /> : <UserRound className="h-4 w-4 text-warn" />}
      {ids.length > 1 && <span className="text-[11px] tabular-nums text-fg-3">+{ids.length - 1}</span>}
    </span>
  );
}

export function PersonCell({ item, field: f = "assignee", compact }: { item: WorkItem; field?: "assignee" | "owner"; compact?: boolean }) {
  const { items, acc, edit } = useStore();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const id = item[f];
  const ids = f === "assignee" ? assigneeIds(item) : [id].filter(Boolean);
  const name = ids.map((id) => person(id).name).join("、") || "未分配";
  const view = (
    <>
      <AssigneeAvatars ids={ids} />
      {!compact && <span className={cx("truncate text-[13px]", ids.length ? "text-fg-2" : "text-warn")}>{name}</span>}
    </>
  );
  if (isInactive(items, item) || !canEditPlan(items, item, acc)) return <span className="inline-flex min-w-0 max-w-full items-center gap-1.5" title={name}>{view}</span>;
  const label = f === "assignee" ? "执行人" : "负责人";
  const button = <button type="button" disabled={saving} className={trigger} title={name} aria-label={`${label}：${name}，点击修改`} onClick={(e) => e.stopPropagation()}>{view}</button>;
  if (f === "assignee") {
    return (
      <PersonPicker multiple keepOpen deferSelection requireProjectAccess minSelected={1} value={ids} title="指派执行人" onPick={async (assignees, baseline) => {
        setSaving(true);
        try {
          const r = await edit(item.id, { assignees }, "修改执行人", { assignees: baseline ?? ids });
          if (r.ok) toast("已更新执行人", item.title);
          else if (r.conflicts) toast("执行人已被其他人更新", "请刷新后再试", "warn");
        } finally {
          setSaving(false);
        }
      }}>
        {button}
      </PersonPicker>
    );
  }
  return (
    <PersonPicker value={id} title="设置负责人"
      onPick={async (next) => { const r = await edit(item.id, { [f]: next }, `${label} → ${person(next).name}`); if (r.ok) toast(`${label}已改为 ${person(next).name}`, item.title); }}>
      {button}
    </PersonPicker>
  );
}

// ───────── 日期 ─────────

function nextWeekday(from: string, wd: number) {
  const d = new Date(`${from}T00:00:00Z`).getUTCDay();
  return dateOffset(from, ((wd - d + 7) % 7) || 7);
}

export function DatePicker({ value, onPick, children, min, label = "截止日期" }: {
  value: string; onPick: (d: string) => void; children: ReactNode; min?: string; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const t = today();
  const initialMonth = `${(value || t).slice(0, 7)}-01`;
  const [month, setMonth] = useState(initialMonth);
  const firstDay = new Date(`${month}T00:00:00Z`);
  const lastDay = new Date(firstDay);
  lastDay.setUTCMonth(lastDay.getUTCMonth() + 1, 0);
  const [year, monthNumber] = month.split("-");
  const leadingDays = (firstDay.getUTCDay() + 6) % 7;
  const days = lastDay.getUTCDate();
  const quick = [
    { label: "今天", d: t },
    { label: "明天", d: dateOffset(t, 1) },
    { label: "本周五", d: new Date(`${t}T00:00:00Z`).getUTCDay() === 5 ? t : nextWeekday(t, 5) },
    { label: "下周一", d: nextWeekday(t, 1) },
    { label: "两周后", d: dateOffset(t, 14) },
  ];
  const shiftMonth = (direction: -1 | 1) => {
    setMonth((current) => {
      const date = new Date(`${current}T00:00:00Z`);
      date.setUTCMonth(date.getUTCMonth() + direction);
      return date.toISOString().slice(0, 10);
    });
  };
  const pick = (d: string) => {
    if (min && d < min) return;
    setOpen(false);
    if (d !== value) onPick(d);
  };
  return (
    <Pop open={open} onOpenChange={(next) => {
      if (next) setMonth(initialMonth);
      setOpen(next);
    }}>
      <PopTrigger asChild>{children}</PopTrigger>
      <PopContent aria-label={`选择${label}`} className="w-64 max-w-[var(--radix-popover-content-available-width)] p-2" onClick={(e) => e.stopPropagation()}>
        <div className="mb-1 flex items-center justify-between">
          <button type="button" className={iconBtn} aria-label="上个月" onClick={() => shiftMonth(-1)}><ChevronLeft /></button>
          <span aria-live="polite" className="text-[13px] font-medium tabular-nums text-fg">{year}年{Number(monthNumber)}月</span>
          <button type="button" className={iconBtn} aria-label="下个月" onClick={() => shiftMonth(1)}><ChevronRight /></button>
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center">
          {["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day} aria-hidden="true" className="py-1 text-xs text-fg-4">{day}</span>)}
          {Array.from({ length: leadingDays }, (_, index) => <span key={`gap-${index}`} aria-hidden="true" />)}
          {Array.from({ length: days }, (_, index) => {
            const day = index + 1;
            const date = dateOffset(month, index);
            const selected = date === value;
            return (
              <button key={date} type="button" aria-label={`${year}年${Number(monthNumber)}月${day}日`}
                aria-pressed={selected} aria-current={date === t ? "date" : undefined} disabled={!!min && date < min}
                onClick={() => pick(date)}
                className={cx("h-8 rounded-md text-xs tabular-nums disabled:opacity-40",
                  selected ? "bg-accent-soft font-semibold text-accent-fg" : "text-fg-2 enabled:hover:bg-hover",
                  date === t && !selected && "font-semibold text-accent-fg")}>
                {day}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-1 border-t border-line pt-2">
          {quick.map((q) => (
            <button key={q.label} type="button" title={fmt(q.d)} disabled={!!min && q.d < min} onClick={() => pick(q.d)}
              className="rounded-md px-1.5 py-1 text-xs text-fg-3 enabled:hover:bg-hover enabled:hover:text-fg disabled:opacity-40">
              {q.label}
            </button>
          ))}
        </div>
      </PopContent>
    </Pop>
  );
}

export function DateField({ label, value, onPick, min, disabled, className }: {
  label: string; value: string; onPick: (date: string) => void; min?: string; disabled?: boolean; className?: string;
}) {
  const display = value ? value.replaceAll("-", "/") : "请选择日期";
  return (
    <DatePicker label={label} value={value} min={min} onPick={onPick}>
      <button type="button" aria-label={`${label}：${display}`} disabled={disabled}
        className={cx(field, "arbor-control flex items-center justify-between gap-2 text-left tabular-nums hover:border-fg-4 disabled:opacity-50", className)}>
        <span className={cx("min-w-0 truncate", !value && "text-fg-4")}>{display}</span>
        <CalendarDays aria-hidden="true" className="size-4 shrink-0 text-fg-3" />
      </button>
    </DatePicker>
  );
}

export function DueCell({ item, withIcon }: { item: WorkItem; withIcon?: boolean }) {
  const { items, acc, edit } = useStore();
  const toast = useToast();
  const view = <>{withIcon && <CalendarDays className="h-3.5 w-3.5 text-fg-4" />}<DueText items={items} item={item} /></>;
  if (isInactive(items, item) || !canEditPlan(items, item, acc) || statusOf(items, item) === "done") return <span className="inline-flex items-center gap-1.5" title={`截止 ${item.due}`}>{view}</span>;
  return (
    <DatePicker value={item.due} min={item.start} onPick={async (d) => { const r = await edit(item.id, { due: d }, `截止 ${fmt(item.due)} → ${fmt(d)}`); if (r.ok) toast(`截止改为 ${fmt(d)}（${relDue(d)}）`, item.title); }}>
      <button className={trigger} aria-label={`截止 ${item.due}，点击修改`} onClick={(e) => e.stopPropagation()}>{view}</button>
    </DatePicker>
  );
}
