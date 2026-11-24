"use client";

import { useState } from "react";
import { btn2, field, sm } from "@/components/ui";

type Invitation = { link: string; expiresAt: string };

export default function MemberInvitation() {
  const [pending, setPending] = useState(false);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [message, setMessage] = useState("");

  async function issue() {
    setPending(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/invitations", { method: "POST" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.reason ?? "生成邀请链接失败");
      const link = new URL("/login", window.location.origin);
      link.hash = new URLSearchParams({ invite: data.code }).toString();
      setInvitation({ link: link.href, expiresAt: data.expiresAt });
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "生成邀请链接失败，请重试");
    } finally {
      setPending(false);
    }
  }

  async function copy(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setMessage("已复制邀请链接");
    } catch {
      setMessage("请选中链接手动复制");
    }
  }

  return (
    <div className="relative shrink-0">
      <button type="button" className={`${btn2} ${sm}`} disabled={pending}
        onClick={() => {
          if (invitation) { setInvitation(null); setMessage(""); }
          else void issue();
        }}>
        {pending ? "正在生成…" : invitation ? "关闭邀请" : "邀请成员"}
      </button>
      {invitation && (
        <div className="absolute right-0 z-10 mt-2 w-64 max-w-[calc(100vw-2rem)] space-y-2 rounded-lg border border-line bg-surface p-3 shadow-lg">
          <label className="block space-y-1">
            <span>成员邀请链接</span>
            <input className={`${field} w-full font-mono text-xs`} readOnly value={invitation.link} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <p className="text-xs text-fg-3">有效期至 {new Date(invitation.expiresAt).toLocaleString()}，仅可使用一次。请私下发给受邀成员。</p>
          <button type="button" className={`${btn2} ${sm}`} onClick={() => void copy(invitation.link)}>复制邀请链接</button>
          {message && <p role="status" className="text-xs text-fg-3">{message}</p>}
        </div>
      )}
      {!invitation && message && <p role="alert" className="absolute right-0 z-10 mt-2 w-52 rounded-md bg-danger-soft p-2 text-danger">{message}</p>}
    </div>
  );
}
