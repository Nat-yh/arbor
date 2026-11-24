"use client";

import Link from "next/link";
import { useRef, useState, type MouseEvent, type ReactNode } from "react";
import { BellRing, BookOpen, ChartColumn, ChevronDown, FolderKanban, Inbox, LogOut, PenSquare, RotateCcw, Search, Settings, ShieldCheck, Users, Menu as MenuIcon, X } from "lucide-react";
import { Logo } from "./Logo";
import GettingStarted from "./GettingStarted";
import { usePathname } from "next/navigation";
import { APP_NAME, APP_TAGLINE } from "@/lib/brand";
import { myQueue } from "@/lib/queue";
import { roleLabel, type MenuKey } from "@/lib/access";
import { PEOPLE, person } from "@/lib/model";
import { useOptionalStore } from "@/lib/store";
import { statusOf } from "@/lib/tree";
import { OPEN_PALETTE } from "./CommandPalette";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Tip } from "./kit";
import { openCreate } from "./QuickCreate";
import { SelectionMotion } from "./SelectionMotion";
import { Avatar, cx, iconBtn, Kbd, ProjectWorkCounts, StatusIcon } from "./ui";

const NAV: { href: string; label: string; icon: typeof Inbox; menu?: MenuKey }[] = [
  { href: "/", label: "工作台", icon: Inbox },
  { href: "/team", label: "团队", icon: Users, menu: "team" },
  { href: "/projects", label: "项目", icon: FolderKanban, menu: "projects" },
  { href: "/alerts", label: "自动提醒", icon: BellRing, menu: "alerts" },
  { href: "/quality", label: "质量中心", icon: ShieldCheck, menu: "quality" },
  { href: "/performance", label: "绩效看板", icon: ChartColumn, menu: "performance" },
  { href: "/settings", label: "系统设置", icon: Settings, menu: "settings" },
];

const row = "group flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2 text-[13px] arbor-control";

function tiltNavIcon(event: MouseEvent<HTMLAnchorElement>) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const icon = event.currentTarget.querySelector("[data-nav-icon]");
  if (!icon) return;
  icon.getAnimations().find((animation) => animation.id === "nav-icon-tilt")?.cancel();
  icon.animate([
    { transform: "rotate(0deg)" },
    { transform: "rotate(-14deg)", offset: .28 },
    { transform: "rotate(5deg)", offset: .63 },
    { transform: "rotate(0deg)" },
  ], { id: "nav-icon-tilt", duration: 310, easing: "cubic-bezier(.22,.65,.32,1)" });
}

export default function Nav({ version }: { version?: ReactNode }) {
  const path = usePathname();
  const store = useOptionalStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const guideTrigger = useRef<HTMLButtonElement>(null);
  if (!store) return <aside className="p-4 text-[13px] text-fg-3 md:w-60">{APP_NAME}</aside>;
  const { me, setMe, reset, logout, demoMode, can, acc, accounts, projects, items, practice, myRoleLabel, roleTemplates } = store;
  const accountRole = (practice ? undefined : myRoleLabel) ?? roleLabel(acc, roleTemplates);
  const visibleNav = NAV.filter((item) => !item.menu || can(item.menu));
  const mine = myQueue(store, me).length;
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  const live = projects.filter((p) => !p.archivedAt && p.status !== "cancelled");
  const menuPaths = [...visibleNav.map(({ href }) => href), ...live.map(({ id }) => `/item/${id}`)];
  const activePath = menuPaths.indexOf(path);
  const transitionTypes = (href: string) => {
    const next = menuPaths.indexOf(href);
    if (next === activePath) return undefined;
    return [next > activePath ? "menu-down" : "menu-up"];
  };

  return (
    <aside className="sticky top-0 z-30 flex w-full shrink-0 flex-col gap-0 border-b border-line bg-canvas px-3 py-2 md:h-screen md:w-60 md:gap-3 md:border-b-0 md:py-3">
      <div className="flex items-center gap-1">
        <button aria-label={mobileOpen ? "关闭导航" : "打开导航"} aria-expanded={mobileOpen} onClick={() => setMobileOpen((v) => !v)} className={cx(iconBtn, "md:hidden")}>{mobileOpen ? <X /> : <MenuIcon />}</button>
        <div className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1">
          <Logo size={24} className="shrink-0" />
          <span className="flex min-w-0 flex-col leading-tight"><span className="truncate text-[13px] font-semibold">{APP_NAME}</span><span className="truncate text-[11px] text-fg-4">{APP_TAGLINE}</span></span>
        </div>
        <Tip content={<span className="flex items-center gap-1.5">搜索 <Kbd className="border-white/20 bg-transparent text-white/70">⌘K</Kbd></span>}>
          <button aria-label="搜索" onClick={() => window.dispatchEvent(new Event(OPEN_PALETTE))} className={iconBtn}><Search /></button>
        </Tip>
      </div>

      <button
        onClick={() => openCreate(path)}
        className="hidden h-8 items-center gap-2 rounded-md bg-surface md:flex px-2 text-[13px] font-medium text-fg-2 shadow-[0_1px_1px_rgb(15_15_30/0.04)] ring-1 ring-line-strong transition-colors hover:text-fg"
      >
        <PenSquare className="h-3.5 w-3.5 text-fg-3" />
        <span className="flex-1 text-left">新建</span>
        <Kbd>C</Kbd>
      </button>

      <nav aria-label="主导航" className={cx("gap-0.5 md:flex md:min-h-0 md:flex-1 md:flex-col", mobileOpen ? "absolute inset-x-2 top-full flex max-h-[calc(100dvh-64px)] flex-col overflow-y-auto rounded-lg border border-line bg-surface p-2 shadow-pop md:static md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none" : "hidden")}>
        <SelectionMotion axis="y" value={visibleNav.find((n) => active(n.href))?.href ?? ""} className="flex shrink-0 flex-col gap-0.5">
          {visibleNav.map((n) => {
            const on = active(n.href);
            const badge = (n.href === "/" || n.href === "/alerts") && mine > 0 ? mine : 0;
            return (
              <Link key={n.href} href={n.href} transitionTypes={transitionTypes(n.href)} aria-current={on ? "page" : undefined} data-selection-value={n.href} onClick={(event) => { tiltNavIcon(event); setMobileOpen(false); }} className={cx(row, on ? "font-medium text-fg" : "text-fg-2 hover:text-fg")}>
                <n.icon data-nav-icon="" aria-hidden="true" className={cx("h-4 w-4 shrink-0", on ? "text-fg" : "text-fg-3 group-hover:text-fg-2")} />
                <span className="flex-1">{n.label}</span>
                {badge > 0 && <span className="min-w-5 rounded-full bg-accent px-1.5 text-center text-[11px] font-medium leading-[18px] text-white">{badge}</span>}
              </Link>
            );
          })}
        </SelectionMotion>
        <button className={cx(row, "md:hidden")} onClick={() => { setMobileOpen(false); openCreate(path); }}><PenSquare className="h-4 w-4" />新建</button>

        {can("projects") && live.length > 0 && (
          <div className="hidden min-h-0 flex-1 flex-col md:flex">
            <div className="flex items-center justify-between px-2 pb-1 pt-3 text-[11px] font-medium text-fg-4">
              <span>我的项目</span>
            </div>
            <SelectionMotion axis="y" value={path} className="-mr-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1">
              {live.map((p) => {
                const on = path === `/item/${p.id}`;
                return (
                  <Link key={p.id} data-guide-project={p.id} href={`/item/${p.id}`} transitionTypes={transitionTypes(`/item/${p.id}`)} aria-current={on ? "page" : undefined} data-selection-value={`/item/${p.id}`} className={cx(row, on ? "font-medium text-fg" : "text-fg-2 hover:text-fg")} title={p.title}>
                    <StatusIcon s={statusOf(items, p)} />
                    <span className="min-w-0 flex-1 truncate">{p.title}</span>
                    <ProjectWorkCounts items={items} projectId={p.id} compact />
                  </Link>
                );
              })}
            </SelectionMotion>
          </div>
        )}
        <div className="mt-auto shrink-0 pt-2">
          <button ref={guideTrigger} type="button" disabled={!!practice} className={cx(row, "w-full text-fg-2 hover:bg-hover disabled:opacity-50")} onClick={() => setGuideOpen(true)}>
            <BookOpen size={16} className="text-fg-3" aria-hidden="true" />使用指南
          </button>
          <div className="mt-2 border-t border-line pt-1">
            <Menu>
              <MenuTrigger aria-label={`账号菜单，${person(me).name}`} className={cx(row, "mt-1 h-10 w-full text-left hover:bg-hover data-[state=open]:bg-active")}>
                <Avatar id={me} size={6} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{person(me).name}</span>
                  <span className="block truncate text-[11px] text-fg-3">{accountRole}{person(me).title ? ` · ${person(me).title}` : ""}</span>
                </span>
                <ChevronDown size={14} className="shrink-0 text-fg-3" aria-hidden="true" />
              </MenuTrigger>
              <MenuContent className="w-60" side="top">
                <div className="flex items-center gap-2 px-2 py-1.5">
                  <Avatar id={me} size={6} />
                  <div className="min-w-0 leading-tight">
                    <div className="truncate text-[13px] font-medium">{person(me).name}</div>
                    <div className="truncate text-[11px] text-fg-4">{accountRole}{person(me).title ? ` · ${person(me).title}` : ""}</div>
                  </div>
                </div>
                {demoMode && (
                  <>
                    <MenuSeparator />
                    <MenuLabel>演示：切换身份</MenuLabel>
                    <div className="max-h-56 overflow-y-auto">
                      {PEOPLE.filter((p) => accounts.some((a) => a.id === p.id && a.active)).map((p) => (
                        <MenuItem key={p.id} icon={<Avatar id={p.id} size={4} />} checked={p.id === me} hint={roleLabel(accounts.find((a) => a.id === p.id)!, roleTemplates)} onSelect={() => p.id !== me && void setMe(p.id)}>
                          {p.name}
                        </MenuItem>
                      ))}
                    </div>
                    <MenuItem icon={<RotateCcw />} onSelect={() => void reset()}>重置示例数据</MenuItem>
                  </>
                )}
                {demoMode && <MenuSeparator />}
                <MenuItem icon={<LogOut />} onSelect={() => void logout()}>退出登录</MenuItem>
              </MenuContent>
            </Menu>
          </div>
        </div>
        <div className="shrink-0 px-2 pt-2 text-[11px] tabular-nums text-fg-3 empty:hidden">{version}</div>
      </nav>
      {guideOpen && <GettingStarted onClose={() => {
        setGuideOpen(false);
        requestAnimationFrame(() => guideTrigger.current?.focus());
      }} />}
    </aside>
  );
}
