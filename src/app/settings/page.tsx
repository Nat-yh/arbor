"use client";

import { ActionFeedback, LiquidButtonFace, useActionFeedback } from "@/components/ActionFeedback";
import { TabBar } from "@/components/TabBar";
import Roles from "@/components/Roles";
import MemberInvitation from "@/components/MemberInvitation";
import FeishuSettings from "@/components/FeishuSettings";
import StateBoundary from "@/components/StateBoundary";

import { Check, ChevronDown, Copy, Eye, GitPullRequest, MessagesSquare, RotateCcw, Shield, UsersRound } from "lucide-react";
import Link from "next/link";
import { useState, useSyncExternalStore } from "react";
import { useToast } from "@/components/Toast";
import { Select } from "@/components/kit";
import { Avatar, Badge, Card, NoAccess, PageHeader, btn, btn2, btnGhost, cx, field, sm } from "@/components/ui";
import { accountRoleId, ROLES, roleLabel, type Account, type RoleTemplate } from "@/lib/access";
import { REPO_PROVIDERS, REPO_PROVIDER_LABELS, isRepoProvider, repoParts, sameRepo, type RepoProvider } from "@/lib/repo-providers";
import { KIND_LABEL } from "@/lib/gitea";
import { person } from "@/lib/model";
import { useStore } from "@/lib/store";
import { childrenOf, isLeaf } from "@/lib/tree";

const settingsTabs = [
  { value: "members", label: "成员", icon: UsersRound },
  { value: "roles", label: "角色", icon: Shield },
  { value: "feishu", label: "飞书接入", icon: MessagesSquare },
  { value: "repo", label: "代码仓库", icon: GitPullRequest },
] as const;

export default function Settings() {
  return <StateBoundary><SettingsContent /></StateBoundary>;
}

function SettingsContent() {
  const { can, accounts, localAuthEnabled, roleTemplates = [] } = useStore();
  const [tab, setTab] = useState<(typeof settingsTabs)[number]["value"]>("members");
  const [open, setOpen] = useState<string | null>(null);
  if (!can("settings")) return <NoAccess text="系统设置仅管理员可见。" />;

  return (
    <div className="mx-auto max-w-[1180px] text-[13px]">
      <PageHeader title="系统设置" desc="管理成员、角色和外部集成。" />

      <TabBar value={tab} onChange={setTab} label="设置分类" className="mb-6"
        items={settingsTabs.map((item) => ({ ...item, id: `tab-${item.value}`, controls: `panel-${item.value}` }))} />
      <div id="panel-members" role="tabpanel" aria-labelledby="tab-members" hidden={tab !== "members"}>
      <div className="mb-2 flex min-h-8 items-center justify-between gap-3">
        <h2 className="text-xs font-medium text-fg-4">成员 · {accounts.length} 人</h2>
        {localAuthEnabled && <MemberInvitation />}
      </div>
      <Card className="overflow-hidden">
        <ul className="divide-y divide-line">
          {accounts.map((a) => (
            <li key={a.id}>
              <button aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)} className={cx("flex min-h-10 w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left hover:bg-hover", !a.active && "opacity-50")}>
                <Avatar id={a.id} size={6} />
                <span className="min-w-0 flex-1 truncate font-medium">{person(a.id).name}<span className="ml-2 text-xs font-normal text-fg-3">{person(a.id).title}</span></span>
                <Badge>{roleLabel(a, roleTemplates)}</Badge>
                <span className={cx("w-10 text-xs", a.active ? "text-fg-3" : "text-danger")}>{a.active ? "启用" : "停用"}</span>
                <ChevronDown className={cx("h-3.5 w-3.5 text-fg-4 transition", open === a.id && "rotate-180")} />
              </button>
              {open === a.id && <MemberEditor acc={a} roles={roleTemplates} onClose={() => setOpen(null)} />}
            </li>
          ))}
        </ul>
      </Card>

      </div>
      <div id="panel-roles" role="tabpanel" aria-labelledby="tab-roles" hidden={tab !== "roles"}>{tab === "roles" && <Roles roles={roleTemplates} />}</div>
      <div id="panel-feishu" role="tabpanel" aria-labelledby="tab-feishu" hidden={tab !== "feishu"}><FeishuSettings /></div>
      <div id="panel-repo" role="tabpanel" aria-labelledby="tab-repo" hidden={tab !== "repo"}><Repo /></div>
    </div>
  );
}

const STATUS_CLS = { applied: "bg-ok-soft text-ok", unlinked: "bg-accent-soft text-accent-fg", unbound: "bg-danger-soft text-danger", ignored: "bg-sunken text-fg-3" };
const STATUS_TEXT = { applied: "已同步", unlinked: "未关联", unbound: "仓库未绑定", ignored: "已忽略" };

const noop = () => () => {};

const repoOptions = REPO_PROVIDERS.map((value) => ({ value, label: REPO_PROVIDER_LABELS[value] }));
const webhookSetup: Record<RepoProvider, { menu: string; credential: string; events: string }> = {
  github: { menu: "Settings → Webhooks → Add webhook", credential: "Secret", events: "Pull requests、Pull request reviews、Pull request review comments、Issue comments、Statuses、Check runs" },
  gitlab: { menu: "Settings → Webhooks → Add new webhook", credential: "Signing token 或 Secret token", events: "Merge request events、Comments、Pipeline events" },
  gitee: { menu: "管理 → WebHooks", credential: "密码", events: "Pull Request、评论" },
  gitea: { menu: "设置 → Webhooks → 添加 Gitea", credential: "Secret", events: "Pull Request、Pull Request Review、Issue Comment、Commit Status" },
};

function Repo() {
  const { repoEvents, repoProviders, repoConfigured, items, linkRepoEvent, bindRepo } = useStore();
  const toast = useToast();
  const origin = useSyncExternalStore(noop, () => window.location.origin, () => "");
  const [selected, setSelected] = useState<RepoProvider>();
  const provider = selected ?? REPO_PROVIDERS.find((value) => repoProviders?.[value]) ?? (repoConfigured ? "gitea" : "github");
  const configured = repoProviders?.[provider] ?? (provider === "gitea" && repoConfigured);
  const guide = webhookSetup[provider];
  const url = `${origin}/api/webhooks/${provider}`;
  const events = repoEvents.filter((event) => repoParts(event.repo).provider === provider);
  const tasks = items.filter((x) => isLeaf(items, x.id) && x.kind === "task");
  const allProjects = childrenOf(items, null);
  const unboundRepos = [...new Set(events.filter((e) => e.status === "unbound").map((e) => e.repo))].filter((r) => !allProjects.some((p) => p.repos?.some((x) => sameRepo(x, r))));
  const bind = async (projectId: string, repo: string) => {
    const r = await bindRepo(projectId, repo);
    toast(r.ok ? "仓库已绑定" : r.reason ?? "绑定失败", r.ok ? r.reason ?? repo : undefined, r.ok ? "success" : "warn");
  };
  const copy = async (t: string) => {
    try {
      await navigator.clipboard.writeText(t);
      toast("已复制", t);
    } catch {
      toast("复制失败，请手动选择复制", t, "warn");
    }
  };

  return (
    <section className="space-y-3">
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <span className="font-medium">代码托管平台</span>
          <Select label="代码托管平台" value={provider} options={repoOptions} className="w-36"
            onValueChange={(value) => { if (isRepoProvider(value)) setSelected(value); }} />
          <span className={cx("rounded-md px-2 py-0.5 text-xs", configured ? "bg-ok-soft text-ok" : "bg-sunken text-fg-3")}>
            {configured ? "已配置凭证" : "未配置凭证"}
          </span>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-2 text-[13px]">
          <span className="text-fg-3">Webhook 地址</span>
          <code className="max-w-full break-all rounded-md bg-sunken px-2 py-1 text-xs text-fg">{url}</code>
          <button type="button" onClick={() => void copy(url)} className={cx(btn2, sm)}><Copy className="h-3.5 w-3.5" />复制</button>
        </div>
        <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-[13px] text-fg-2">
          <li>在 {REPO_PROVIDER_LABELS[provider]} 打开「{guide.menu}」，填写接收地址。支持选项时将内容类型设为 application/json。</li>
          <li>把 {guide.credential} 填入 Arbor 环境变量 <code className="rounded bg-sunken px-1 text-xs">{provider.toUpperCase()}_WEBHOOK_SECRET</code>。</li>
          <li>勾选 {guide.events}，然后测试投递。</li>
          <li>在项目中绑定仓库。分支名、标题或描述带 <code className="rounded bg-sunken px-1 text-xs">AR-任务编号</code> 时可自动关联。</li>
        </ol>
        <p className="mt-3 text-xs text-fg-3">成员资料中的平台用户名用于匹配提交人和评审人。接收地址须能被代码托管平台通过 HTTPS 访问。</p>
      </Card>

      <h3 className="mb-2 mt-5 text-xs font-medium text-fg-4">仓库与项目</h3>
      <Card className="overflow-hidden">
        <ul className="divide-y divide-line text-[13px]">
          {allProjects.map((p) => {
            const repositories = p.repos?.filter((repo) => repoParts(repo).provider === provider) ?? [];
            return <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <Link href={`/item/${p.id}`} className="w-40 shrink-0 truncate font-medium hover:underline">{p.title}</Link>
              <span className="flex flex-1 flex-wrap gap-1.5">
                {repositories.length ? repositories.map((r) => <code key={r} className="rounded bg-sunken px-1.5 py-0.5 text-xs text-fg-2">{repoParts(r).path}</code>) : <span className="text-xs text-fg-4">未绑定</span>}
              </span>
              <Link href={`/item/${p.id}`} className="text-xs text-fg-3 hover:text-fg">在项目里管理</Link>
            </li>;
          })}
          {unboundRepos.map((r) => (
            <li key={r} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <code className="rounded bg-surface px-1.5 py-0.5 text-xs text-fg ring-1 ring-danger/40">{repoParts(r).path}</code>
              <span className="flex-1 text-xs text-danger">收到过事件，但还没绑定项目，事件已暂存</span>
              <Select value="" placeholder="绑定到项目…" onValueChange={(value) => bind(value, r)} className="w-48! py-1 text-xs"
                options={allProjects.map((p) => ({ value: p.id, label: p.title }))} />
            </li>
          ))}
        </ul>
      </Card>
      <p className="mt-2 text-xs text-fg-4">匹配规则：仓库未绑定 → 暂存不处理，绑定后自动补处理；任务编号属于其他项目 → 照常同步并记警告；没有任务编号 → 进入该项目的「未关联 PR」。</p>

      <h3 className="mb-2 mt-5 text-xs font-medium text-fg-4">最近收到的事件 · {events.length}</h3>
      <Card className="overflow-hidden">
        {events.length ? (
          <ul className="divide-y divide-line">
            {events.slice(0, 30).map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-[13px]">
                <span className={cx("rounded-md px-1.5 py-0.5 text-xs", STATUS_CLS[e.status])}>{STATUS_TEXT[e.status]}</span>
                <span className="text-xs text-fg-3">{provider === "gitlab" ? KIND_LABEL[e.kind].replace("PR", "MR") : KIND_LABEL[e.kind]}</span>
                <span className="min-w-0 flex-1 truncate">
                  {e.number ? `#${e.number} ` : ""}{e.title ?? repoParts(e.repo).path}
                  <span className="ml-2 text-xs text-fg-4">{repoParts(e.repo).path} · {e.result}{!e.verified && " · 未校验签名"}</span>
                  {e.warning && <span className="block text-xs text-danger">{e.warning}</span>}
                </span>
                {e.itemId && <Link href={`/item/${e.itemId}`} className="text-xs text-fg-2 underline-offset-2 hover:underline">查看任务</Link>}
                {e.status === "unlinked" && (
                  <Select value="" placeholder="关联到任务…" onValueChange={(value) => linkRepoEvent(e.id, value)} className="w-48! py-1 text-xs"
                    options={tasks.map((t) => ({ value: t.id, label: t.title }))} />
                )}
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 py-8 text-center text-[13px] text-fg-4">还没有收到 {REPO_PROVIDER_LABELS[provider]} 事件。</div>
        )}
      </Card>
    </section>
  );
}

function MemberEditor({ acc, roles, onClose }: { acc: Account; roles: RoleTemplate[]; onClose: () => void }) {
  const { setMember, setMe, me, demoMode } = useStore();
  const toast = useToast();
  const currentRole = accountRoleId(acc);
  const [selectedRole, setSelectedRole] = useState<string>();
  const [active, setActive] = useState(acc.active);
  const [logins, setLogins] = useState<Partial<Record<RepoProvider, string>>>(() => ({ ...acc.repoLogins, gitea: acc.gitee }));
  const [saving, setSaving] = useState(false);
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      const { gitea, github, gitlab, gitee } = logins;
      const result = await setMember(acc.id, {
        active, gitee: gitea ?? "", roleId: selectedRole === currentRole ? undefined : selectedRole,
        repoLogins: { github: github?.trim() || undefined, gitlab: gitlab?.trim() || undefined, gitee: gitee?.trim() || undefined },
      });
      if (!result.ok) return toast(result.reason ?? "保存失败", undefined, "warn");
      await acknowledge();
      toast("成员信息已保存", person(acc.id).name);
      onClose();
    } finally {
      clearFeedback();
      setSaving(false);
    }
  };

  return (
    <div className="divide-y divide-line border-t border-line bg-canvas px-4">
      <Field label="角色">
        <Select label="成员角色" value={selectedRole ?? currentRole} onValueChange={(value) => setSelectedRole(value === currentRole ? undefined : value)} className="w-full max-w-xs"
          options={[
            ...Object.entries(ROLES).map(([value, preset]) => ({ value, label: preset.label })),
            ...roles.map(({ id, name }) => ({ value: id, label: name })),
            ...(currentRole === "custom" ? [{ value: "custom", label: "独立权限" }] : []),
          ]} />
      </Field>

      <Field label="代码平台用户名" hint="用于识别提交人和评审人，按实际使用的平台填写。">
        <div className="grid max-w-lg gap-2 sm:grid-cols-2">
          {REPO_PROVIDERS.map((provider) => (
            <label key={provider} className="space-y-1 text-xs text-fg-3">
              <span className="block">{REPO_PROVIDER_LABELS[provider]}</span>
              <input aria-label={`${REPO_PROVIDER_LABELS[provider]} 用户名`} value={logins[provider] ?? ""}
                onChange={(event) => setLogins({ ...logins, [provider]: event.target.value })}
                className={cx(field, "w-full")} maxLength={100} />
            </label>
          ))}
        </div>
      </Field>

      <Field label="账号状态">
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)}
            className="h-4 w-4 accent-[var(--color-accent)]" />
          启用
          <span className="text-xs text-fg-4">停用后无法登录</span>
        </label>
      </Field>

      <div className="flex flex-wrap items-center gap-2 border-t border-line py-4">
        <button data-action-feedback="local" onClick={save} disabled={saving} aria-busy={saving && !confirmed} className={cx(btn, sm, "liquid-button min-w-20")}><LiquidButtonFace><Check className="h-4 w-4" />保存</LiquidButtonFace>{confirmed && <ActionFeedback message="已保存" />}</button>
        <button onClick={() => { setSelectedRole(undefined); setActive(acc.active); setLogins({ ...acc.repoLogins, gitea: acc.gitee }); }} className={cx(btn2, sm)}><RotateCcw className="h-4 w-4" />还原</button>
        {demoMode && acc.id !== me && (
          <button onClick={() => void setMe(acc.id)} className={cx(btnGhost, sm, "ml-auto")}>
            <Eye className="h-4 w-4" />用 TA 的视角预览
          </button>
        )}
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-3 py-5 md:grid-cols-[220px_minmax(0,1fr)] md:gap-8">
      <div><div className="text-[13px] font-medium text-fg">{label}</div>{hint && <p className="mt-1 text-xs text-fg-3">{hint}</p>}</div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
