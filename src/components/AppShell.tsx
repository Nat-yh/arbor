"use client";
import { usePathname } from "next/navigation";
import { Suspense, ViewTransition, type ReactNode } from "react";
import { APP_NAME } from "@/lib/brand";
import { StoreProvider, useOptionalStore } from "@/lib/store";
import { ToastProvider } from "./Toast";
import AccountGate from "./AccountGate";
import CommandPalette from "./CommandPalette";
import { TipProvider } from "./kit";
import Nav from "./Nav";
import PeekPanel from "./Peek";
import QuickCreate from "./QuickCreate";
import PracticeGuide, { PracticeBanner } from "./PracticeGuide";

export default function AppShell({ children, version }: { children: ReactNode; version?: ReactNode }) {
  const path = usePathname();
  if (path === "/login") return <>{children}</>;
  return <ToastProvider><StoreProvider><TipProvider>
    <PracticeBanner />
    <Workspace path={path} version={version}>{children}</Workspace>
    <Suspense fallback={null}><PracticeGuide /></Suspense>
  </TipProvider></StoreProvider></ToastProvider>;
}

const menuMotion = { "menu-down": "menu-down", "menu-up": "menu-up", default: "none" };

function Workspace({ children, path, version }: { children: ReactNode; path: string; version?: ReactNode }) {
  const store = useOptionalStore();
  return <div key={store?.workspaceKey ?? "loading"} className={store?.practice ? "practice-workspace" : undefined}>
    <div className="flex min-h-screen flex-col md:flex-row">
      <Suspense fallback={<aside className="p-4 text-[13px] text-fg-3 md:w-60">{APP_NAME}</aside>}><Nav version={version} /></Suspense>
      {/* 内容区：白色内嵌面板，与侧栏的浅灰底拉开层次 */}
      <main className="min-w-0 flex-1 bg-surface md:my-2 md:mr-2 md:min-h-[calc(100vh-16px)] md:rounded-xl md:border md:border-line">
        <ViewTransition name="arbor-menu-content" update={menuMotion} default="none">
          <div className={path.startsWith("/item/") ? undefined : "px-4 py-6 md:px-10 md:py-8"}>
            <AccountGate>{children}</AccountGate>
          </div>
        </ViewTransition>
      </main>
    </div>
    <Suspense fallback={null}><PeekPanel /></Suspense>
    <Suspense fallback={null}><QuickCreate /></Suspense>
    <Suspense fallback={null}><CommandPalette /></Suspense>
  </div>;
}
