"use client";

import { useState, type FormEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { accountRoleId, MENUS, ROLES, SCOPES, roleLabel, roleOf, type Account, type RoleId, type RolePermissions, type RoleTemplate } from "@/lib/access";
import { person } from "@/lib/model";
import { childrenOf } from "@/lib/tree";
import { useStore } from "@/lib/store";
import { Modal, ModalFooter } from "./kit";
import RoleMembers from "./RoleMembers";
import { Badge, Card, btn, btn2, btnDanger, btnGhost, cx, field, sm } from "./ui";

type Draft = Omit<RoleTemplate, "id" | "revision">;

function permissionSummary(permissions: RolePermissions) {
  const hasProjects = permissions.menus.includes("projects");
  const scope = hasProjects ? SCOPES.find(({ key }) => key === permissions.scope)?.label : "项目菜单未开启";
  const performance = permissions.menus.includes("performance") ? (permissions.perf === "all" ? "全员绩效" : "本人绩效") : undefined;
  return [scope, performance, hasProjects && permissions.canCreate ? "可新建项目" : "不可新建项目"].filter(Boolean).join(" · ");
}

export default function Roles({ roles }: { roles: RoleTemplate[] }) {
  const { accounts, saveRoleTemplate, deleteRoleTemplate } = useStore();
  const [editing, setEditing] = useState<RoleTemplate | "new" | null>(null);
  const [viewing, setViewing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<RoleTemplate | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const membersOfRole = (id: string) => accounts.filter((account) => accountRoleId(account) === id);
  const assigned = (id: string) => membersOfRole(id).length;
  const customRole = roles.find(({ id }) => id === viewing);
  const builtinRole = viewing && Object.hasOwn(ROLES, viewing) ? ROLES[viewing as RoleId] : undefined;

  function beginDelete(role: RoleTemplate) {
    setError("");
    setDeleting(role);
  }

  async function remove() {
    if (!deleting || pending) return;
    setPending(true);
    setError("");
    try {
      const result = await deleteRoleTemplate(deleting.id);
      if (!result.ok) setError(result.reason ?? "删除失败");
      else setDeleting(null);
    } finally {
      setPending(false);
    }
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="text-xs font-medium text-fg-4">角色列表</h2>
        <button type="button" className={cx(btn2, sm)} onClick={() => setEditing("new")}><Plus className="h-3.5 w-3.5" />新建角色</button>
      </div>
      <Card>
        <ul className="divide-y divide-line">
          {Object.entries(ROLES).map(([id, role]) => (
            <li key={id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{role.label}</span><Badge>内置</Badge></div>
                <p className="mt-1 text-xs text-fg-3">{permissionSummary(role.preset)}</p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-fg-3">{assigned(id)} 人</span>
                <button type="button" aria-label={`查看角色 ${role.label}`} className={cx(btnGhost, sm)} onClick={() => setViewing(id)}>查看详情</button>
              </div>
            </li>
          ))}
          {roles.map((role) => {
            const count = assigned(role.id);
            return (
              <li key={role.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><span className="break-words font-medium">{role.name}</span><Badge>自定义</Badge></div>
                  {role.description && <p className="mt-1 break-words text-xs text-fg-3">{role.description}</p>}
                  <p className="mt-1 text-xs text-fg-3">{permissionSummary(role.permissions)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <span className="mr-1 text-xs text-fg-3">{count} 人</span>
                  <button type="button" aria-label={`查看角色 ${role.name}`} className={cx(btnGhost, sm)} onClick={() => setViewing(role.id)}>查看详情</button>
                  <button type="button" aria-label={`删除角色 ${role.name}`} className={cx(btnGhost, sm)} onClick={() => beginDelete(role)}><Trash2 className="h-3.5 w-3.5" />删除</button>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      <RoleAccessExceptions roles={roles} />
      {viewing && !editing && (customRole || builtinRole) && (
        <Modal open onOpenChange={(open) => { if (!open) setViewing(null); }}
          title={customRole?.name ?? builtinRole?.label} desc={customRole?.description || builtinRole?.desc}>
          <div className="space-y-4 px-5 py-4 text-[13px]">
            <RolePermissionOverview permissions={customRole?.permissions ?? builtinRole!.preset} />
            <RoleMembers key={viewing} roleId={viewing} members={membersOfRole(viewing)} roles={roles} />
          </div>
          <ModalFooter>
            {customRole && (
              <button type="button" className={cx(btn2, sm)} onClick={() => setEditing(customRole)}>
                <Pencil className="size-3.5" />编辑权限
              </button>
            )}
            <button type="button" className={cx(btn2, sm)} onClick={() => setViewing(null)}>关闭</button>
          </ModalFooter>
        </Modal>
      )}
      {editing && <RoleEditor key={editing === "new" ? "new" : editing.id} role={editing === "new" ? undefined : editing}
        assigned={editing === "new" ? 0 : assigned(editing.id)} onSave={saveRoleTemplate} onClose={() => setEditing(null)} />}
      {deleting && (
        <Modal open onOpenChange={(open) => { if (!open && !pending) setDeleting(null); }} title="删除角色"
          desc={assigned(deleting.id) ? `「${deleting.name}」仍有成员使用。更换这些成员的角色后再删除。` : `确认删除「${deleting.name}」？`}>
          {error && <p className="px-5 py-3 text-danger" role="alert">{error}</p>}
          <ModalFooter>
            <button type="button" className={cx(btn2, sm)} disabled={pending} onClick={() => setDeleting(null)}>关闭</button>
            <button type="button" className={cx(btnDanger, sm)} disabled={pending || assigned(deleting.id) > 0} onClick={() => void remove()}>{pending ? "删除中…" : "删除角色"}</button>
          </ModalFooter>
        </Modal>
      )}
    </section>
  );
}

function RolePermissionOverview({ permissions }: { permissions: RolePermissions }) {
  const menuNames = MENUS.filter(({ key }) => permissions.menus.includes(key)).map(({ label }) => label);
  const team = permissions.menus.includes("team") ? undefined : permissions.menus.includes("team:off") ? "团队入口已关闭" : "团队入口按系统默认";
  return (
    <section aria-label="角色权限">
      <h3 className="font-medium">权限</h3>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-fg-3">
        <dt>菜单</dt>
        <dd>工作台{menuNames.length ? `、${menuNames.join("、")}` : ""}{team && ` · ${team}`}</dd>
        <dt>数据及操作</dt>
        <dd>{permissionSummary(permissions)}</dd>
      </dl>
    </section>
  );
}

function RoleEditor({ role, assigned, onSave, onClose }: {
  role?: RoleTemplate;
  assigned: number;
  onSave: (draft: Draft, existing?: RoleTemplate) => Promise<{ ok: boolean; reason?: string }>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => role
    ? { name: role.name, description: role.description, permissions: role.permissions }
    : { name: "", description: "", permissions: ROLES.member.preset });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const { permissions } = draft;
  const setPermissions = (patch: Partial<RolePermissions>) => setDraft((current) => ({
    ...current, permissions: { ...current.permissions, ...patch },
  }));

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await onSave(draft, role);
      if (!result.ok) setError(result.reason ?? "保存失败");
      else onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onOpenChange={(open) => { if (!open && !saving) onClose(); }} title={role ? "编辑角色" : "新建角色"}
      desc={assigned ? `保存权限变更后会同步更新使用此角色的 ${assigned} 位成员。` : "选择分配此角色后成员可使用的功能。"} className="max-w-lg">
      <form onSubmit={submit}>
        <div className="max-h-[65dvh] space-y-4 overflow-y-auto px-5 py-4 text-[13px]">
          <label className="block space-y-1">
            <span>角色名称</span>
            <input className={cx(field, "w-full")} autoFocus required maxLength={40} value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
          </label>
          <label className="block space-y-1">
            <span>说明（选填）</span>
            <input className={cx(field, "w-full")} maxLength={200} value={draft.description}
              onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
          </label>
          <RolePermissionFields permissions={permissions} onChange={setPermissions} />
          {error && <p role="alert" className="rounded-md bg-danger-soft p-2 text-danger">{error}</p>}
        </div>
        <ModalFooter>
          <button type="button" className={cx(btn2, sm)} disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className={cx(btn, sm)} disabled={saving}>{saving ? "保存中…" : "保存角色"}</button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function RolePermissionFields({ permissions, onChange }: {
  permissions: RolePermissions;
  onChange: (patch: Partial<RolePermissions>) => void;
}) {
  const team = permissions.menus.includes("team") ? "team" : permissions.menus.includes("team:off") ? "team:off" : "default";
  return (
    <>
      <fieldset className="space-y-2">
        <legend className="mb-2 font-medium">菜单权限</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {MENUS.filter(({ key }) => key !== "team").map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2">
              <input type="checkbox" checked={permissions.menus.includes(key)}
                onChange={(event) => onChange({ menus: event.target.checked ? [...permissions.menus, key] : permissions.menus.filter((menu) => menu !== key) })} />
              {label}
            </label>
          ))}
        </div>
        <label className="flex flex-wrap items-center gap-2">
          团队入口
          <select className={field} value={team} onChange={(event) => {
            const choice = event.target.value;
            const menus = permissions.menus.filter((menu) => menu !== "team" && menu !== "team:off");
            onChange({ menus: choice === "team" || choice === "team:off" ? [...menus, choice] : menus });
          }}>
            <option value="default">按系统默认</option>
            <option value="team">允许</option>
            <option value="team:off">关闭</option>
          </select>
        </label>
      </fieldset>
      <label className="flex flex-wrap items-center gap-2">
        项目范围
        <select className={field} value={permissions.scope} onChange={(event) => onChange({ scope: event.target.value as RolePermissions["scope"] })}>
          {SCOPES.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
        </select>
      </label>
      <label className="flex flex-wrap items-center gap-2">
        绩效数据范围
        <select className={field} disabled={!permissions.menus.includes("performance")} value={permissions.perf}
          onChange={(event) => onChange({ perf: event.target.value as RolePermissions["perf"] })}>
          <option value="self">仅本人</option>
          <option value="all">全员</option>
        </select>
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={permissions.canCreate} onChange={(event) => onChange({ canCreate: event.target.checked })} />
        可以新建项目
      </label>
    </>
  );
}

function hasIndependentPermissions(account: Account) {
  return !account.roleTemplateId && roleOf(account) === "custom";
}

function RoleAccessExceptions({ roles }: { roles: RoleTemplate[] }) {
  const { accounts, items } = useStore();
  const [open, setOpen] = useState<string | null>(null);
  const exceptions = accounts.filter((account) => hasIndependentPermissions(account) || account.scope === "selected");
  if (!exceptions.length) return null;
  const active = exceptions.find(({ id }) => id === open);
  return (
    <section className="mt-6">
      <h2 className="mb-2 text-xs font-medium text-fg-4">独立权限与指定项目</h2>
      <Card>
        <ul className="divide-y divide-line">
          {exceptions.map((account) => (
            <li key={account.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <div>
                <span className="font-medium">{person(account.id).name}</span>
                <p className="mt-1 text-xs text-fg-3">
                  {roleLabel(account, roles)}{account.scope === "selected" && ` · ${account.projects.length} 个额外项目`}
                </p>
              </div>
              <button type="button" className={cx(btnGhost, sm)} onClick={() => setOpen(account.id)}
                aria-label={`配置 ${person(account.id).name} 的权限`}>配置</button>
            </li>
          ))}
        </ul>
      </Card>
      {active && <AccountAccessEditor key={active.id} account={active} projects={childrenOf(items, null)} onClose={() => setOpen(null)} />}
    </section>
  );
}

function AccountAccessEditor({ account, projects, onClose }: {
  account: Account;
  projects: { id: string; title: string }[];
  onClose: () => void;
}) {
  const { setAccount } = useStore();
  const independent = hasIndependentPermissions(account);
  const [permissions, setPermissions] = useState<RolePermissions>(() => ({
    menus: account.menus, scope: account.scope, perf: account.perf, canCreate: account.canCreate,
  }));
  const [selected, setSelected] = useState(account.projects);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const scope = independent ? permissions.scope : account.scope;

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await setAccount(account.id, {
        ...account, ...(independent ? permissions : {}), projects: scope === "selected" ? selected : [],
      });
      if (result.ok) onClose();
      else setError(result.reason ?? "保存失败");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onOpenChange={(open) => { if (!open && !saving) onClose(); }}
      title={independent ? "独立权限" : "指定项目"} desc={person(account.id).name}>
      <form onSubmit={save}>
        <div className="space-y-4 px-5 py-4 text-[13px]">
          {independent && <RolePermissionFields permissions={permissions}
            onChange={(patch) => setPermissions((previous) => ({ ...previous, ...patch }))} />}
          {scope === "selected" && (
            <fieldset className="space-y-2">
              <legend className="mb-2 font-medium">额外可查看的项目</legend>
              {projects.length ? projects.map(({ id, title }) => (
                <label key={id} className="flex items-center gap-2">
                  <input type="checkbox" checked={selected.includes(id)} onChange={(event) => {
                    const checked = event.target.checked;
                    setSelected((previous) => checked ? [...previous, id] : previous.filter((project) => project !== id));
                  }} />
                  {title}
                </label>
              )) : <p className="text-fg-3">暂无项目可选</p>}
            </fieldset>
          )}
          {error && <p role="alert" className="rounded-md bg-danger-soft p-2 text-danger">{error}</p>}
        </div>
        <ModalFooter>
          <button type="button" className={cx(btn2, sm)} disabled={saving} onClick={onClose}>取消</button>
          <button type="submit" className={cx(btn, sm)} disabled={saving}>{saving ? "保存中…" : "保存权限"}</button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
