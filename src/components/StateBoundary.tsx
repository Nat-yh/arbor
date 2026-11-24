"use client";
import { usePathname } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import PageLoading from "./PageLoading";
import { useOptionalStore, useStoreLoading } from "@/lib/store";

/** 内容就绪后入场，查询参数变更不会重播整页动画。 */
export default function StateBoundary({ children }: { children: ReactNode }) {
  const store = useOptionalStore();
  const loading = useStoreLoading();
  const path = usePathname();
  if (!store) {
    return loading?.error
      ? <div role="alert" className="p-4 text-[13px] text-fg-3">{loading.error}<button onClick={loading.retry} className="ml-3 underline">重试</button></div>
      : <PageLoading />;
  }
  return (
    <Suspense fallback={<PageLoading />}>
      <div key={path} className="arbor-page-enter">{children}</div>
    </Suspense>
  );
}
