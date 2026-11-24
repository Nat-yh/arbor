"use client";

import type { ReactNode } from "react";
import { useOptionalStore } from "@/lib/store";
import { NoAccess } from "./ui";

/** 账号被停用时，整个系统不可用 */
export default function AccountGate({ children }: { children: ReactNode }) {
  const store = useOptionalStore();
  if (store && !store.acc.active) return <div className="mx-auto max-w-2xl rounded-lg border border-line bg-surface"><NoAccess text="你的账号已被停用，如有疑问请联系管理员。" /></div>;
  return <>{children}</>;
}
