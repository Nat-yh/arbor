"use client";

import { CircleCheck, Info, OctagonAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { cx } from "./ui";

type Tone = "success" | "info" | "warn";
interface T { id: number; title: string; desc?: string; tone: Tone }

const Ctx = createContext<(title: string, desc?: string, tone?: Tone) => void>(() => {});

/** 操作反馈：右上角轻提示，3 秒后自动消失 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<T[]>([]);
  const toast = useCallback((title: string, desc?: string, tone: Tone = "success") => {
    const id = Date.now() + Math.random();
    setList((l) => [...l.slice(-2), { id, title, desc, tone }]);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), 3200);
  }, []);
  const Icon = { success: CircleCheck, info: Info, warn: OctagonAlert };
  return (
    <Ctx.Provider value={toast}>
      {children}
      <div className="app-toasts pointer-events-none fixed inset-x-4 top-[max(1rem,env(safe-area-inset-top))] z-50 flex flex-col items-end gap-2 sm:left-auto sm:w-80">
        {list.map((t) => {
          const I = Icon[t.tone];
          return (
            <div key={t.id} role="status" className="pointer-events-auto flex w-80 max-w-full animate-toast items-start gap-3 rounded-lg bg-fg px-4 py-3 text-sm text-white shadow-pop">
              <I aria-hidden="true" className={cx("mt-0.5 h-4 w-4 shrink-0", t.tone === "success" ? "text-st-done" : t.tone === "warn" ? "text-st-doing" : "text-white/60")} />
              <div className="min-w-0 flex-1">
                <div className="font-medium">{t.title}</div>
                {t.desc && <div className="mt-0.5 text-xs text-white/60">{t.desc}</div>}
              </div>
              <button aria-label="关闭" onClick={() => setList((l) => l.filter((x) => x.id !== t.id))} className="text-white/60 hover:text-white">
                <X className="h-4 w-4" />
              </button>
            </div>
          );
        })}
      </div>
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
