"use client";

/**
 * 快速新建：按 C 或点侧栏「新建」。标题 + 回车即可创建，属性用胶囊就地选。
 * 上级决定类型：无上级 = 项目；项目下可选需求 / 任务；需求、任务下 = 任务。
 */
import { ActionFeedback, LiquidButtonFace, useActionFeedback } from "./ActionFeedback";
import { DraftScreenshots, useScreenshotDraft } from "./DraftScreenshots";
import { SelectionMotion } from "./SelectionMotion";
import * as DG from "@radix-ui/react-dialog";
import { CalendarDays, ChevronDown, FolderKanban, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { canAddChild } from "@/lib/access";
import { dateOffset, fmt, KIND_LABEL, person, today, type Kind, type WorkItem } from "@/lib/model";
import { useOptionalStore, useStore } from "@/lib/store";
import { ancestors, descendants, isInactive, levelLabel } from "@/lib/tree";
import { modalBackdrop, Pop, PopContent, PopTrigger } from "./kit";
import { AssigneeAvatars, DatePicker, PersonPicker, useAssignable } from "./pickers";
import { useToast } from "./Toast";
import { btn, cx, iconBtn, Kbd, relDue, StatusIcon } from "./ui";

const EVENT = "arbor:create";

/** 从当前页面推断默认上级，打开新建框 */
export function openCreate(pathOrParent?: string | null) {
  const m = pathOrParent?.match(/^\/item\/([^/?]+)/);
  const parentId = m ? decodeURIComponent(m[1]) : pathOrParent && !pathOrParent.startsWith("/") ? pathOrParent : undefined;
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { parentId } }));
}

export default function QuickCreate() {
  const store = useOptionalStore();
  return store ? <Loaded /> : null;
}

const chip = "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg-2 ring-1 ring-line-strong transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-active [&_svg]:h-3.5 [&_svg]:w-3.5";

function Loaded() {
  const { items, me, acc, projects, addItem, practice } = useStore();
  const router = useRouter();
  const toast = useToast();
  const people = useAssignable();
  const [open, setOpen] = useState(false);
  const [parentId, setParentId] = useState<string | null>(null);
  const [kind, setKind] = useState<Kind>("task");
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [assigned, setAssigned] = useState<string[]>([me]);
  const [owner, setOwner] = useState(me);
  const [verifiers, setVerifiers] = useState<string[]>([]);
  const [due, setDue] = useState(dateOffset(today(), 7));
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const screenshots = useScreenshotDraft();
  const canAddScreenshots = kind !== "project" && !practice;
  const submitting = useRef(false);
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const titleRef = useRef<HTMLTextAreaElement>(null);

  // 能作为上级的：自己能管理或执行的、未取消/归档的项
  const parents = useMemo(() => {
    const live = projects.filter((p) => !p.archivedAt && !isInactive(items, p));
    return live.flatMap((p) => [p, ...descendants(items, p.id).filter((d) => !isInactive(items, d))])
      .filter((x) => levelLabel(items, x) !== "子任务" && canAddChild(items, x, acc));
  }, [items, projects, acc]);
  const parent = parentId ? items.find((x) => x.id === parentId) : undefined;
  const kinds: Kind[] = !parent ? ["project"] : parent.kind === "project" ? ["feature", "task"] : ["task"];

  const reset = (pid: string | null) => {
    const p = pid ? items.find((x) => x.id === pid) : undefined;
    setParentId(pid);
    setKind(!p ? "project" : p.kind === "project" ? "feature" : "task");
    setAssigned([me]);
    setOwner(me);
    setVerifiers(p && p.kind === "project" && p.owner !== me ? [p.owner] : []);
    setDue(p && p.due < dateOffset(today(), 7) && p.due >= today() ? p.due : dateOffset(today(), p ? 7 : 30));
    setTitle(""); setDesc("");
  };

  useEffect(() => {
    const onCreate = (e: Event) => {
      const want = (e as CustomEvent<{ parentId?: string }>).detail?.parentId;
      const ok = want && parents.some((p) => p.id === want);
      const fallback = parents.find((p) => p.kind === "project")?.id ?? null;
      screenshots.clear();
      reset(ok ? want! : acc.canCreate && !fallback ? null : fallback);
      setOpen(true);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "c" || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]")) return;
      e.preventDefault();
      const m = window.location.pathname.match(/^\/item\/([^/]+)/);
      const peek = new URLSearchParams(window.location.search).get("peek");
      openCreate(peek ?? (m ? m[1] : null));
    };
    window.addEventListener(EVENT, onCreate);
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener(EVENT, onCreate); window.removeEventListener("keydown", onKey); };
  });

  const errors: string[] = [];
  if (!title.trim()) errors.push("填写标题");
  if (!assigned.length) errors.push("请至少选择一位执行人");
  if (kind === "feature" && !verifiers.length) errors.push("需求要指定验证人");
  if (parent && due > parent.due) errors.push(`截止晚于上级（${fmt(parent.due)}）`);
  const blocking = errors.filter((e) => !e.startsWith("截止晚于"));

  const submit = async () => {
    if (blocking.length || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const t = title.trim();
      const id = await addItem({
        parentId: parent?.id ?? null,
        kind,
        title: t,
        desc: desc.trim() || undefined,
        owner,
        assignees: assigned,
        due,
        ...(kind === "feature" ? {
          verifiers,
        } : {}),
        ...(kind === "project" ? { members: [...new Set([me, owner])] } : {}),
      }, canAddScreenshots ? screenshots.files : []);
      if (!id) return;
      await acknowledge();
      toast(`已创建${KIND_LABEL[kind]}「${t}」`, more ? "可以继续创建下一项" : `${pickedNames} · 截止 ${fmt(due)}`);
      if (more) { setTitle(""); setDesc(""); screenshots.clear(); titleRef.current?.focus(); return; }
      setOpen(false);
      if (kind === "project") router.push(`/item/${id}`);
      else {
        const path = window.location.pathname;
        const q = new URLSearchParams(window.location.search);
        q.set("peek", id);
        router.replace(`${path}?${q}`, { scroll: false });
      }
    } finally {
      submitting.current = false;
      clearFeedback();
      setBusy(false);
    }
  };

  const createdMessage = kind === "project" ? "项目已创建" : "已创建";
  const pickedNames = assigned.map((id) => person(id).name).join("、");

  return (
    <DG.Root open={open} onOpenChange={(next) => { if (!busy) setOpen(next); }} modal={!practice}>
      <DG.Portal>
        <DG.Overlay className={cx(modalBackdrop, "z-50")} />
        <DG.Content
          aria-describedby={undefined}
          onPaste={canAddScreenshots && !busy ? screenshots.onPaste : undefined}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.defaultPrevented || event.nativeEvent.isComposing || !event.currentTarget.contains(event.target as Node)) return;
            const shortcut = event.metaKey || event.ctrlKey;
            const titleEnter = event.target === titleRef.current && !event.shiftKey && !event.altKey;
            if (!shortcut && !titleEnter) return;
            event.preventDefault();
            if (!event.repeat) void submit();
          }}
          className="fixed left-1/2 top-[max(16px,4dvh)] z-50 flex max-h-[92dvh] w-[calc(100vw-32px)] max-w-2xl -translate-x-1/2 flex-col overflow-hidden arbor-dialog rounded-xl bg-surface shadow-pop outline-none md:top-[14vh] md:max-h-[80dvh]"
        >
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 px-4 pt-3.5 text-xs">
            <ParentPicker parents={parents} value={parentId} allowRoot={acc.canCreate} onPick={reset} />
            <ChevronDown className="h-3 w-3 -rotate-90 text-fg-4" />
            {kinds.length > 1 ? (
              <SelectionMotion value={kind} className="selection-segment flex rounded-md bg-sunken p-0.5" role="group" aria-label="新建类型">
                {kinds.map((k) => (
                  <button key={k} data-selection-value={k} aria-pressed={kind === k} disabled={busy} onClick={() => { setKind(k); if (k === "feature" && parent && parent.owner !== owner && !verifiers.length) setVerifiers([parent.owner]); }} className={cx("h-6 rounded px-2.5 text-xs transition-colors", kind === k ? "text-fg" : "text-fg-3 hover:text-fg")}>
                    新{KIND_LABEL[k]}
                  </button>
                ))}
              </SelectionMotion>
            ) : (
              <span className="font-medium text-fg-2">新{parent && parent.kind !== "project" ? (parent.kind === "task" ? "子任务" : "任务") : KIND_LABEL[kind]}</span>
            )}
            <DG.Close disabled={busy} className={cx(iconBtn, "ml-auto")} aria-label="关闭"><X /></DG.Close>
          </div>
          <DG.Title className="sr-only">新建{KIND_LABEL[kind]}</DG.Title>

          <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
            <div className="px-4 pt-2">
              <textarea
                ref={titleRef}
                autoFocus
                rows={1}
                value={title}
                onChange={(e) => setTitle(e.target.value.replace(/\n/g, ""))}
                placeholder={`${KIND_LABEL[kind]}名称`}
                className="w-full resize-none bg-transparent text-lg font-medium leading-snug outline-none placeholder:text-fg-4"
              />
              <textarea
                rows={2}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder={kind === "task" ? "补充说明（可选）" : "背景 / 目标（可选）"}
                className="mt-1 w-full resize-none bg-transparent text-[13px] leading-relaxed text-fg-2 outline-none placeholder:text-fg-4"
              />
            </div>

            {canAddScreenshots && <div className="px-4 pb-3"><DraftScreenshots draft={screenshots} busy={busy} /></div>}

            <div className="flex flex-wrap items-center gap-1.5 px-4 pb-3">
              <PersonPicker value={owner} onPick={setOwner} title="选择负责人">
                <button type="button" disabled={busy} className={cx(chip, "max-w-full")} aria-label={`负责人：${person(owner).name}`}>
                  <AssigneeAvatars ids={[owner]} /><span className="shrink-0 text-fg-4">负责人</span>
                  <span className="truncate">{person(owner).name}</span>
                </button>
              </PersonPicker>
              <PersonPicker multiple keepOpen requireProjectAccess value={assigned} onPick={setAssigned} title="选择执行人">
                <button type="button" disabled={busy} className={cx(chip, "max-w-full")} aria-label={`执行人：${pickedNames || "未分配"}`}>
                  <AssigneeAvatars ids={assigned} /><span className="shrink-0 text-fg-4">执行人</span>
                  <span className="truncate" title={pickedNames}>{pickedNames || "请选择"}</span>
                </button>
              </PersonPicker>
              <DatePicker value={due} onPick={setDue}>
                <button className={cx(chip, parent && due > parent.due && "text-warn ring-warn/40")}><CalendarDays /><span className="text-fg-4">截止</span>{fmt(due)}<span className="text-fg-4">· {relDue(due)}</span></button>
              </DatePicker>
              {kind === "feature" && <VerifierChip value={verifiers} onChange={setVerifiers} people={people} />}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-3 border-t border-line px-4 py-2.5">
            <div className="min-w-0 flex-1 truncate text-xs">
              {title.trim() && errors.length ? <span className={blocking.length ? "text-danger" : "text-warn"}>{errors.filter((e) => e !== "填写标题").join(" · ")}</span> : <span className="text-fg-4">{kind === "project" ? "创建后进入项目，在「需求与任务」里继续拆分" : "创建后在侧边打开，可以继续拆分子任务"}</span>}
            </div>
            <label className="flex cursor-pointer select-none items-center gap-1.5 text-xs text-fg-3">
              <span className={cx("relative h-4 w-7 rounded-full transition-colors", more ? "bg-accent" : "bg-line-strong")}>
                <span className={cx("absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-[left]", more ? "left-3.5" : "left-0.5")} />
              </span>
              <input type="checkbox" className="sr-only" checked={more} onChange={(e) => setMore(e.target.checked)} />
              连续创建
            </label>
            <button data-action-feedback="local" disabled={!!blocking.length || busy} aria-busy={busy && !confirmed} onClick={() => void submit()} className={cx(btn, "liquid-button")}>
              <LiquidButtonFace>{`创建${KIND_LABEL[kind]}`} <Kbd className="border-current/25">⌘↵</Kbd></LiquidButtonFace>
              {confirmed && <ActionFeedback message={createdMessage} />}
            </button>
          </div>
        </DG.Content>
      </DG.Portal>
    </DG.Root>
  );
}

function ParentPicker({ parents, value, allowRoot, onPick }: { parents: WorkItem[]; value: string | null; allowRoot: boolean; onPick: (id: string | null) => void }) {
  const { items } = useStore();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const cur = value ? items.find((x) => x.id === value) : undefined;
  const list = parents.filter((p) => !q || p.title.includes(q));
  const depth = (x: WorkItem) => ancestors(items, x).length;
  return (
    <Pop open={open} onOpenChange={setOpen}>
      <PopTrigger asChild>
        <button className={chip}>
          {cur ? <StatusIcon s={cur.status} /> : <FolderKanban />}
          <span className="max-w-56 truncate">{cur ? cur.title : "新项目"}</span>
          <ChevronDown className="h-3! w-3! text-fg-4" />
        </button>
      </PopTrigger>
      <PopContent className="w-80">
        <div className="flex items-center gap-2 border-b border-line px-2 pb-1.5 pt-1">
          <Search className="h-3.5 w-3.5 text-fg-4" />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="放到哪个项目 / 需求下…" className="h-7 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4" />
        </div>
        <ul className="max-h-72 overflow-y-auto pt-1">
          {allowRoot && !q && (
            <li><button onClick={() => { onPick(null); setOpen(false); }} className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[13px] hover:bg-hover"><Sparkles className="h-3.5 w-3.5 text-accent" />新项目（不放在任何项目下）</button></li>
          )}
          {list.map((p) => (
            <li key={p.id}>
              <button onClick={() => { onPick(p.id); setOpen(false); }} className={cx("flex h-8 w-full items-center gap-2 rounded-md pr-2 text-left text-[13px] hover:bg-hover", p.id === value && "bg-hover")} style={{ paddingLeft: 8 + (q ? 0 : depth(p)) * 14 }}>
                <StatusIcon s={p.status} />
                <span className={cx("min-w-0 flex-1 truncate", p.kind === "project" && "font-medium")}>{p.title}</span>
                <span className="text-[11px] text-fg-4">{levelLabel(items, p)}</span>
              </button>
            </li>
          ))}
          {!list.length && <li className="px-2 py-3 text-center text-xs text-fg-4">没有可放入的项目</li>}
        </ul>
      </PopContent>
    </Pop>
  );
}

function VerifierChip({ value, onChange, people }: { value: string[]; onChange: (v: string[]) => void; people: ReturnType<typeof useAssignable> }) {
  return (
    <PersonPicker multiple keepOpen value={value} onPick={onChange} people={people} title="选择验证人">
      <button type="button" className={cx(chip, "max-w-full min-w-0", !value.length && "text-warn ring-warn/40")}>
        <ShieldCheck aria-hidden />
        <span className="shrink-0 text-fg-4">验证人</span>
        <span className="truncate">{value.length ? value.map((v) => person(v).name).join("、") : "未指定"}</span>
      </button>
    </PersonPicker>
  );
}
