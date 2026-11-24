import type { Metadata } from "next";
import { Suspense } from "react";
import { readFile } from "node:fs/promises";
import { io } from "next/cache";
import AppShell from "@/components/AppShell";
import "./globals.css";
import { APP_NAME, APP_TAGLINE } from "@/lib/brand";

export const metadata: Metadata = {
  title: `${APP_NAME} · ${APP_TAGLINE}`,
  description: "AI 协同研发与交付管理平台",
};

async function ReleaseVersion() {
  await io();
  const version = await readFile("/run/arbor-activation/version", "utf8").then((value) => value.trim(), () => "");
  if (!/^v\d{8}\.\d{4}$/.test(version)) return null;
  return <span aria-label={`版本 ${version}`}>{version}</span>;
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="min-h-full bg-canvas text-fg">
        <Suspense fallback={<div className="p-8 text-sm text-fg-4">加载中…</div>}>
          <AppShell version={<Suspense fallback={null}><ReleaseVersion /></Suspense>}>{children}</AppShell>
        </Suspense>
      </body>
    </html>
  );
}
