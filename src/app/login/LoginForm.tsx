"use client";
import { LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Select } from "@/components/kit";
import { btn, btn2 } from "@/components/ui";

export default function LoginForm({ demo, configured, choices, error }: { demo: boolean; configured: boolean; choices: { id: string; name: string }[]; error: string }) {
  const [id, setId] = useState(choices[0]?.id ?? "");
  const [message, setMessage] = useState(error);
  const [busy, setBusy] = useState(false);
  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setMessage("");
    try {
      const res = await fetch("/api/auth/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.reason ?? "登录失败");
      window.location.assign(new URL("/", window.location.origin).href);
    } catch (err) { setMessage(err instanceof Error ? err.message : "登录失败"); setBusy(false); }
  };
  return (
    <>
      {message && <p role="alert" className="mt-5 rounded-lg bg-danger-soft p-3 text-[13px] text-danger">{message}</p>}
      {configured && (
        <a className={`${btn} arbor-login-action mt-7 h-12 w-full rounded-lg text-sm`} href="/api/auth/feishu">
          <LogIn aria-hidden="true" className="size-5" />
          飞书登录
        </a>
      )}
      {demo && choices.length > 0 && (
        <form className={`${configured ? "mt-6 border-t border-line pt-5" : "mt-7"} space-y-3`} onSubmit={(event) => void login(event)}>
          <label className="block text-sm font-medium" htmlFor="demo-identity">演示身份</label>
          <Select id="demo-identity" className="h-11 text-sm" value={id} onValueChange={setId}
            options={choices.map((choice) => ({ value: choice.id, label: choice.name }))} />
          <button className={`${configured ? btn2 : btn} h-12 w-full rounded-lg text-sm`} type="submit" disabled={busy}>
            {busy ? "登录中…" : "选择身份登录"}
          </button>
        </form>
      )}
    </>
  );
}
