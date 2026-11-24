"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { accountRoleId, ROLES, roleLabel, type Account, type RoleTemplate } from "@/lib/access";
import { person } from "@/lib/model";
import { useStore } from "@/lib/store";
import { PersonPicker } from "./pickers";
import { Avatar, btn, btn2, btnGhost, cx, field, sm } from "./ui";

export default function RoleMembers({ roleId, members, roles }: {
  roleId: string;
  members: Account[];
  roles: RoleTemplate[];
}) {
  const { accounts, moveRoleMembers } = useStore();
  const [removing, setRemoving] = useState<string | null>(null);
  const [destination, setDestination] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const candidates = accounts.filter((account) => accountRoleId(account) !== roleId);
  const destinations = [
    ...Object.entries(ROLES).map(([id, role]) => ({ id, name: role.label })),
    ...roles,
  ].filter(({ id }) => id !== roleId);

  async function move(targetRoleId: string, members: { id: string; fromRoleId: string }[], success: string) {
    if (pending || !members.length) return;
    setMessage("");
    setError("");
    setPending(true);
    try {
      const result = await moveRoleMembers(targetRoleId, members);
      if (!result.ok) setError(result.reason ?? "成员角色保存失败");
      else {
        setRemoving(null);
        setMessage(success);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-label="角色成员" className="border-t border-line pt-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">成员 · {members.length} 人</h3>
        <PersonPicker multiple keepOpen deferSelection value={[]} title="搜索成员"
          people={candidates.map((account) => ({
            ...person(account.id), title: `${roleLabel(account, roles)}${account.active ? "" : " · 停用"}`,
          }))}
          onPick={(ids) => {
            const selected = candidates.filter(({ id }) => ids.includes(id));
            void move(roleId, selected.map((account) => ({ id: account.id, fromRoleId: accountRoleId(account) })), `已添加 ${selected.length} 位成员`);
          }}>
          <button type="button" className={cx(btn2, sm)} disabled={pending || !candidates.length}>
            <Plus className="size-3.5" />添加成员
          </button>
        </PersonPicker>
      </div>

      {members.length ? (
        <ul className="mt-2 divide-y divide-line rounded-md border border-line">
          {members.map((account) => {
            const member = person(account.id);
            return (
              <li key={account.id} className="p-2.5">
                <div className="flex items-center gap-2">
                  <Avatar id={account.id} size={6} />
                  <span className="min-w-0 flex-1 truncate" title={member.name}>{member.name}</span>
                  {!account.active && <span className="text-xs text-fg-3">停用</span>}
                  <button type="button" className={cx(btnGhost, sm)} disabled={pending}
                    aria-label={`移除 ${member.name}`} aria-expanded={removing === account.id}
                    onClick={() => {
                      setRemoving(removing === account.id ? null : account.id);
                      setDestination("");
                      setMessage("");
                      setError("");
                    }}>移除</button>
                </div>
                {removing === account.id && (
                  <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md bg-canvas p-2">
                    <label className="min-w-0 flex-1 space-y-1">
                      <span className="block text-xs">转到角色</span>
                      <select className={cx(field, "w-full")} value={destination} disabled={pending} onChange={(event) => setDestination(event.target.value)}>
                        <option value="">请选择角色</option>
                        {destinations.map(({ id, name }) => <option key={id} value={id}>{name}</option>)}
                      </select>
                    </label>
                    <button type="button" className={cx(btn, sm)} disabled={pending || !destination}
                      onClick={() => void move(destination, [{ id: account.id, fromRoleId: roleId }], `已移除 ${member.name}`)}>确认移除</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : <p className="mt-2 rounded-md border border-line px-3 py-4 text-center text-fg-3">还没有分配成员</p>}
      {pending && <p role="status" className="mt-2 text-xs text-fg-3">正在保存成员角色…</p>}
      {message && <p role="status" className="mt-2 text-xs text-fg-3">{message}</p>}
      {error && <p role="alert" className="mt-2 rounded-md bg-danger-soft p-2 text-danger">{error}</p>}
    </section>
  );
}
