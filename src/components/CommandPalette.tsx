"use client";

import * as DG from "@radix-ui/react-dialog";
import { BellRing, CornerDownLeft, FolderKanban, LayoutDashboard, Plus, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useOptionalStore, useStore } from "@/lib/store";
import { ancestors, levelLabel, statusOf } from "@/lib/tree";
import { openCreate } from "./QuickCreate";
import { Kbd, StatusIcon, cx } from "./ui";

interface Entry {
  key: string;
  label: string;
  hint?: string;
  icon?: React.ReactNode;
  href?: string;
  group: "工作项" | "跳转" | "操作";
}

export const OPEN_PALETTE = "arbor:open-palette";

/** ⌘K / Ctrl+K：搜索任务、项目，或直接跳转 */
export default function CommandPalette() {
  const store = useOptionalStore();
  return store ? <LoadedPalette /> : null;
}

function LoadedPalette() {
  const { items, visible } = useStore();
  const router = useRouter();
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_PALETTE, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_PALETTE, onOpen);
    };
  }, []);

  const entries = useMemo<(Entry & { item?: (typeof items)[number] })[]>(() => {
    const k = q.trim().toLowerCase();
    const pages: Entry[] = [
      { key: "p-home", group: "跳转", label: "工作台", icon: <LayoutDashboard className="h-4 w-4" />, href: "/" },
      { key: "p-proj", group: "跳转", label: "项目", icon: <FolderKanban className="h-4 w-4" />, href: "/projects" },
      { key: "p-alert", group: "跳转", label: "自动提醒", icon: <BellRing className="h-4 w-4" />, href: "/alerts" },
      { key: "a-new", label: "新建…", icon: <Plus className="h-4 w-4" />, group: "操作" },
    ];
    const hits = visible
      .filter((x) => !k || x.title.toLowerCase().includes(k))
      .slice(0, k ? 12 : 6)
      .map((x) => ({ key: x.id, group: "工作项" as const, label: x.title, hint: [levelLabel(items, x), ...ancestors(items, x).map((a) => a.title)].join(" · "), href: `/item/${x.id}`, item: x }));
    const pageHits = pages.filter((p) => !k || p.label.includes(k));
    return [...hits, ...pageHits];
  }, [q, visible, items]);

  const go = (e: Entry) => {
    setOpen(false);
    setQ("");
    if (e.key === "a-new") openCreate(path);
    else if (e.href) router.push(e.href);
  };
  const sel = Math.min(i, Math.max(0, entries.length - 1));

  return (
    <DG.Root open={open} onOpenChange={setOpen}>
      <DG.Portal>
        <DG.Overlay className="fixed inset-0 z-50 arbor-overlay bg-fg/25" />
        <DG.Content aria-describedby={undefined} onOpenAutoFocus={(event) => { event.preventDefault(); input.current?.focus(); }}
          className="fixed left-1/2 top-[12dvh] z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 arbor-dialog overflow-hidden rounded-xl bg-surface shadow-pop outline-none">
          <DG.Title className="sr-only">搜索与操作</DG.Title>
        <div className="flex items-center gap-2 border-b border-line px-4">
          <Search className="h-4 w-4 text-fg-4" />
          <input
            ref={input}
            value={q}
            onChange={(e) => { setQ(e.target.value); setI(0); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setI((v) => Math.min(v + 1, entries.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setI((v) => Math.max(v - 1, 0)); }
              if (e.key === "Enter" && entries[sel]) go(entries[sel]);
            }}
            aria-label="搜索任务、需求、项目"
            placeholder="搜索任务、需求、项目…"
            className="h-12 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4"
          />
          <Kbd>esc</Kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto p-1.5">
          {entries.map((e, n) => (
            <li key={e.key}>
              {(n === 0 || entries[n - 1].group !== e.group) && <div className="px-3 pb-1 pt-2 text-[11px] text-fg-4">{e.group}</div>}
              <button
                onMouseEnter={() => setI(n)}
                onClick={() => go(e)}
                className={cx("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] transition-colors", n === sel ? "bg-sunken" : "")}
              >
                {e.item && <StatusIcon s={statusOf(items, e.item)} />}
                {e.icon && <span className="text-fg-4">{e.icon}</span>}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{e.label}</span>
                  {e.hint && <span className="block truncate text-xs text-fg-4">{e.hint}</span>}
                </span>
                {n === sel && <CornerDownLeft className="h-3.5 w-3.5 text-fg-4" />}
              </button>
            </li>
          ))}
          {entries.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-fg-4">没有找到「{q}」</li>}
        </ul>
        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-fg-4"><span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd>选择</span><span className="flex items-center gap-1"><Kbd>↵</Kbd>打开</span><span className="flex items-center gap-1"><Kbd>esc</Kbd>关闭</span></div>
        </DG.Content>
      </DG.Portal>
    </DG.Root>
  );
}
