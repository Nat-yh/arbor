"use client";

import { useState, useSyncExternalStore, type FormEvent } from "react";
import { btn, field } from "@/components/ui";

function subscribeToInvite(callback: () => void) {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

const inviteFromLocation = () => new URLSearchParams(window.location.hash.slice(1)).get("invite") ?? "";
const emptyInvite = () => "";

export default function LocalLogin({ afterFeishu }: { afterFeishu: boolean }) {
  const invite = useSyncExternalStore(subscribeToInvite, inviteFromLocation, emptyInvite);
  const [registerOverride, setRegisterOverride] = useState<boolean | null>(null);
  const register = registerOverride ?? Boolean(invite);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const values = new FormData(event.currentTarget);
    const login = { username: values.get("username"), password: values.get("password") };
    const body = register
      ? { ...login, action: "register", name: values.get("name"), code: invite || values.get("code") }
      : { ...login, action: "login" };
    setPending(true);
    setError("");
    try {
      const response = await fetch("/api/auth/local", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.reason ?? "请求失败，请重试");
      const home = new URL("/", window.location.origin).href;
      if (invite && register) window.location.replace(home);
      else window.location.assign(home);
    } catch (err) {
      setError(err instanceof Error ? err.message : "请求失败，请重试");
      setPending(false);
    }
  }

  return (
    <div className={afterFeishu ? "mt-5 border-t border-line pt-5" : "mt-7"}>
      <form key={String(register)} className="space-y-3 text-sm" onSubmit={submit}>
        {register && (
          <>
            {invite ? (
              <h2 className="font-semibold">接受团队邀请</h2>
            ) : (
              <label className="block space-y-1">
                <span>初始化码或邀请码</span>
                <input className={`${field} w-full`} name="code" type="password" autoComplete="off" minLength={64} maxLength={64} required />
              </label>
            )}
            <label className="block space-y-1">
              <span>显示名称</span>
              <input className={`${field} w-full`} name="name" autoComplete="name" maxLength={80} required />
            </label>
          </>
        )}
        <label className="block space-y-1">
          <span>用户名</span>
          <input className={`${field} w-full`} name="username" autoComplete="username" autoCapitalize="none" spellCheck={false}
            minLength={3} maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{2,63}" required />
          {register && <span className="block text-xs text-fg-3">3–64 位字母、数字、点、下划线或短横线，以字母或数字开头。</span>}
        </label>
        <label className="block space-y-1">
          <span>密码</span>
          <input className={`${field} w-full`} name="password" type="password" autoComplete={register ? "new-password" : "current-password"}
            minLength={register ? 12 : undefined} maxLength={128} required />
          {register && <span className="block text-xs text-fg-3">至少 12 个字符。</span>}
        </label>
        {error && <p role="alert" className="rounded-md bg-danger-soft p-2 text-danger">{error}</p>}
        <button className={`${btn} h-11 w-full`} type="submit" disabled={pending}>
          {pending ? "正在提交…" : register ? "创建账号" : "使用账号登录"}
        </button>
      </form>
      <button type="button" className="mt-3 min-h-8 text-sm text-accent-fg underline-offset-4 hover:underline" disabled={pending}
        onClick={() => { setRegisterOverride(!register); setError(""); }}>
        {register ? "返回账号登录" : "使用初始化码或邀请码"}
      </button>
    </div>
  );
}
