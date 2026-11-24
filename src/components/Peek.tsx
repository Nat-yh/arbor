"use client";

/**
 * 侧边详情抽屉：在列表里点任务，从右侧打开详情，不丢失列表上下文。
 * 状态放在 URL 的 ?peek= 里，可以分享、可以前进后退。
 */
import * as DG from "@radix-ui/react-dialog";
import Link from "next/link";
import { ChevronRight, Maximize2, X } from "lucide-react";
import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useRef, useState, type MouseEvent } from "react";
import { ItemView } from "@/app/item/[id]/ItemDetail";
import { useOptionalStore } from "@/lib/store";
import { ancestors } from "@/lib/tree";
import { modalBackdrop, Tip } from "./kit";
import { cx, iconBtn } from "./ui";

export function usePeek() {
  const params = useSearchParams();
  const id = params.get("peek");
  const set = useCallback((next: string | null, review = false) => {
    const url = new URL(window.location.href);
    if (next) url.searchParams.set("peek", next);
    else url.searchParams.delete("peek");
    if (next && review) url.searchParams.set("review", next);
    else url.searchParams.delete("review");
    window.history.replaceState(null, "", url);
  }, []);
  /** 给 Link 用：普通点击打开抽屉，⌘/Ctrl/中键点击照常在新标签打开整页 */
  const onLinkClick = useCallback((itemId: string, review = false) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    set(itemId, review);
  }, [set]);
  return { id, open: set, close: () => set(null), onLinkClick };
}

export default function PeekPanel() {
  const store = useOptionalStore();
  const { id, close } = usePeek();
  const path = usePathname();
  const previousFocus = useRef<HTMLElement | null>(null);
  const activeId = id && path !== `/item/${id}` ? id : null;
  const [last, setLast] = useState(activeId ? { id: activeId, path } : null);
  if (activeId && (last?.id !== activeId || last.path !== path)) setLast({ id: activeId, path });
  const displayedId = activeId ?? (last?.path === path ? last.id : null);
  const item = displayedId ? store?.get(displayedId) : undefined;

  // 抽屉里的就是当前整页本身时不再叠一层
  if (!displayedId || !store) return null;
  const trail = item ? ancestors(store.items, item) : [];
  const backdrop = cx(modalBackdrop, "z-40");

  return (
    <DG.Root open={!!activeId} onOpenChange={(open) => { if (!open) close(); }} modal={!store.practice}>
      <DG.Portal>
        {store.practice
          ? <div aria-hidden="true" data-state={activeId ? "open" : "closed"} className={backdrop} />
          : <DG.Overlay className={backdrop} />}
        <DG.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            const focused = document.activeElement;
            previousFocus.current = focused instanceof HTMLElement ? focused : null;
            event.preventDefault();
            (event.currentTarget as HTMLElement).focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            previousFocus.current?.focus();
          }}
          onInteractOutside={(event) => {
            if (store.practice && (event.target as HTMLElement).closest(".practice-coach, .practice-banner")) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            // 标题等内联输入先处理自己的 Esc，不随输入一起关闭抽屉。
            if ((event.target as HTMLElement).closest("input, textarea, select, [contenteditable=true]")) event.preventDefault();
          }}
          className="item-peek fixed inset-y-0 right-0 z-40 flex w-full max-w-[min(760px,100vw)] arbor-drawer flex-col bg-surface shadow-panel outline-none md:inset-y-2 md:right-2 md:rounded-xl"
        >
          <DG.Title className="sr-only">{item?.title ?? "工作项详情"}</DG.Title>
          <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-3">
            <nav className="flex min-w-0 flex-1 items-center gap-1 text-xs text-fg-3">
              {trail.map((a, i) => (
                <span key={a.id} className="flex min-w-0 items-center gap-1">
                  {i > 0 && <ChevronRight className="h-3 w-3 shrink-0 text-fg-4" />}
                  <Link href={`/item/${a.id}`} className="truncate hover:text-fg">{a.title}</Link>
                </span>
              ))}
            </nav>
            <Tip content="打开完整页面"><Link href={`/item/${displayedId}`} aria-label="打开完整页面" className={iconBtn}><Maximize2 className="h-3.5! w-3.5!" /></Link></Tip>
            <Tip content="关闭 · Esc"><DG.Close aria-label="关闭详情" className={iconBtn}><X /></DG.Close></Tip>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable] px-4 pb-64 pt-5 md:px-6 md:pb-10">
            {item ? <ItemView key={displayedId} id={displayedId} mode="peek" /> : <div className="text-[13px] text-fg-3">找不到这一项，可能已被删除或你没有权限。</div>}
          </div>
        </DG.Content>
      </DG.Portal>
    </DG.Root>
  );
}
