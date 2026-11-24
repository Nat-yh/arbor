"use client";

import { SelectionMotion } from "@/components/SelectionMotion";
import { ChevronRight, Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import StateBoundary from "@/components/StateBoundary";
import { Pop, PopContent, PopTrigger } from "@/components/kit";
import { usePeek } from "@/components/Peek";
import { openCreate } from "@/components/QuickCreate";
import { Avatar, AvatarStack, Badge, DueText, Empty, LEVEL_CLS, NoAccess, PageHeader, ProjectWorkCounts, StatusBadge, btn, cx } from "@/components/ui";
import { assigneeIds, fmt, person, today } from "@/lib/model";
import { useStore } from "@/lib/store";
import { isCancelled, descendants, hasBlocked, isLeaf, statusOf } from "@/lib/tree";

type View = "active" | "archived" | "all";
const COLS = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 md:min-w-[1040px] md:grid-cols-[minmax(180px,1fr)_128px_136px_48px_88px_72px_80px_128px]";

export default function Projects() {
  return <StateBoundary><ProjectsContent /></StateBoundary>;
}

function ProjectsContent() {
  const { items, alerts, projects, can, acc, activities } = useStore();
  const router = useRouter();
  const peek = usePeek();
  const [view, setView] = useState<View>("active");
  const [riskProject, setRiskProject] = useState<string | null>(null);
  if (!can("projects")) return <NoAccess text="你的账号没有开通「项目」菜单，请联系管理员。" />;
  const active = projects.filter((p) => !p.archivedAt);
  const archived = projects.filter((p) => !!p.archivedAt);
  const shown = view === "active" ? active : view === "archived" ? archived : projects;
  const tabs: { key: View; label: string; count: number }[] = [
    { key: "active", label: "进行中", count: active.length },
    { key: "archived", label: "已归档", count: archived.length },
    { key: "all", label: "全部", count: projects.length },
  ];
  const create = acc.canCreate ? <button onClick={() => openCreate(null)} className={btn}><Plus />新建项目</button> : undefined;

  return (
    <div className="mx-auto max-w-[1180px] text-[13px]">
      <PageHeader title="项目" desc={acc.scope === "all" ? "你可以看到全部项目" : "这里只显示你有权限的项目；需要看其他项目请联系负责人或管理员"} action={create} />
      <SelectionMotion value={view} className="selection-segment mb-4 flex w-fit rounded-md bg-sunken p-0.5" role="group" aria-label="项目范围">
        {tabs.map(({ key, label, count }) => (
          <button key={key} data-selection-value={key} aria-pressed={view === key} onClick={() => setView(key)} className={cx("flex h-7 items-center gap-1.5 rounded px-2.5 text-xs transition-colors", view === key ? "text-fg" : "text-fg-3 hover:text-fg")}>
            {label}<span className="tabular-nums text-fg-4">{count}</span>
          </button>
        ))}
      </SelectionMotion>
      <div className="overflow-hidden rounded-lg border border-line bg-surface">
        {shown.length ? (
          <div className="md:overflow-x-auto">
            <div className={cx(COLS, "hidden h-8 border-b border-line bg-canvas px-3 text-xs text-fg-4 md:grid")}>
              <span>名称</span><span>状态</span><span>需求与任务</span><span>风险</span><span>负责人</span><span>成员</span><span>截止</span><span>下个里程碑</span>
            </div>
            <ul>
              {shown.map((p) => {
                const all = descendants(items, p.id);
                const leaves = all.filter((x) => !isCancelled(items, x) && isLeaf(items, x.id));
                const ids = new Set([p.id, ...all.map((x) => x.id)]);
                const pa = alerts.filter((a) => ids.has(a.itemId) && a.level !== "info");
                const next = p.milestones?.filter((milestone) => !milestone.done).sort((a, b) => a.date.localeCompare(b.date))[0];
                const members = [...new Set(leaves.flatMap(assigneeIds))];
                return (
                  <li key={p.id} onClick={() => router.push(`/item/${p.id}`)} className={cx(COLS, "cursor-pointer border-b border-line px-3 py-2 transition-colors last:border-b-0 hover:bg-hover")}>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Link href={`/item/${p.id}`} onClick={(e) => e.stopPropagation()} className="truncate font-semibold hover:underline">{p.title}</Link>
                        {p.archivedAt && <span className="shrink-0 text-xs text-fg-4">已归档</span>}
                      </div>
                      {p.desc && <p className="mt-0.5 truncate text-xs text-fg-3" title={p.desc}>{p.desc}</p>}
                    </div>
                    <div><StatusBadge s={statusOf(items, p)} blocked={hasBlocked(items, p)} /></div>
                    <div className="mt-2 md:mt-0"><ProjectWorkCounts items={items} projectId={p.id} /></div>
                    <div className="hidden md:block" onClick={(e) => e.stopPropagation()}>
                      {pa.length ? (
                        <Pop open={riskProject === p.id} onOpenChange={(open) => setRiskProject(open ? p.id : null)}>
                          <PopTrigger asChild><button aria-label={`${p.title}：${pa.length} 条风险`} className="rounded outline-none"><Badge className={pa.some((a) => a.level === "urgent") ? "bg-danger-soft text-danger" : "bg-warn-soft text-warn"}>{pa.length}</Badge></button></PopTrigger>
                          <PopContent className="w-80 max-w-[calc(100vw-32px)]" onClick={(e) => e.stopPropagation()}>
                            <div className="border-b border-line px-2 py-2 text-xs font-medium text-fg-3">{p.title} · {pa.length} 条风险</div>
                            <ul className="max-h-72 overflow-y-auto py-1">
                              {pa.map((a) => (
                                <li key={a.id}>
                                  <Link href={`/item/${a.itemId}`} onClick={(e) => { e.stopPropagation(); setRiskProject(null); peek.onLinkClick(a.itemId)(e); }} className="flex items-start gap-2 rounded-md px-2 py-2 text-xs hover:bg-hover">
                                    <span className={cx("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", LEVEL_CLS[a.level])} />
                                    <span className="min-w-0"><span className="block font-medium text-fg">{items.find((x) => x.id === a.itemId)?.title}</span><span className="mt-0.5 block text-fg-3">{a.text}</span></span>
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          </PopContent>
                        </Pop>
                      ) : <span className="text-fg-4">—</span>}
                    </div>
                    <div className="hidden min-w-0 items-center gap-1.5 md:flex"><Avatar id={p.owner} size={5} /><span className="truncate text-xs text-fg-2">{person(p.owner).name}</span></div>
                    <div className="hidden md:block">{members.length ? <AvatarStack ids={members} max={3} /> : <span className="text-fg-4">—</span>}</div>
                    <div className="mt-2 text-right md:mt-0 md:text-left"><DueText items={items} item={p} /></div>
                    <div className="hidden min-w-0 text-xs md:block">
                      {next ? <div className={cx("space-y-0.5", next.date < today() ? "text-danger" : "text-fg-3")}><p className="truncate" title={next.name}>{next.name}</p><p className="tabular-nums">{fmt(next.date)}</p></div> : <span className="text-fg-4">—</span>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <Empty>
            <p>{projects.length === 0 ? "还没有项目" : view === "archived" ? "暂无已归档项目" : "暂无进行中的项目"}</p>
            {acc.canCreate ? <div className="mt-3">{create}</div> : <p className="mt-1 text-xs text-fg-3">请联系项目负责人将你加入项目。</p>}
          </Empty>
        )}
      </div>
      {!!activities?.length && (
        <details className="group mt-6 text-xs text-fg-4">
          <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 py-2 hover:text-fg-2"><ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />删除记录（{activities.length}）</summary>
          <ul className="mt-1 space-y-2 border-l border-line pl-5 leading-relaxed">{[...activities].sort((a, b) => b.date.localeCompare(a.date)).map((a) => <li key={a.id}>{fmt(a.date)} · {person(a.by).name} · {a.text}</li>)}</ul>
        </details>
      )}
    </div>
  );
}
