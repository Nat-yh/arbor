"use client";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import StateBoundary from "@/components/StateBoundary";
import { MentionText } from "@/components/MentionText";
import { Select } from "@/components/kit";
import { Avatar, Card, DueText, Empty, NoAccess, PageHeader, StatusBadge, btn2, cx } from "@/components/ui";
import { useStore } from "@/lib/store";
import { memberLoads, recentActivity } from "@/lib/team";
import { person, today } from "@/lib/model";
import { statusLabel } from "@/lib/model";
import { statusOf } from "@/lib/tree";

const loadMetrics = [
  { key: "doing", label: "进行中" },
  { key: "todo", label: "未开始" },
  { key: "review", label: "待交付" },
  { key: "blocked", label: "阻塞" },
  { key: "overdue", label: "逾期" },
] as const;
const loadColumns = "grid grid-cols-5 items-center gap-x-2 @min-[36rem]:grid-cols-[minmax(8rem,1fr)_minmax(7rem,1fr)_repeat(5,minmax(3rem,0.5fr))]";

export default function Team() { return <StateBoundary><TeamContent /></StateBoundary>; }
function TeamContent() {
  const store = useStore();
  const [project, setProject] = useState("");
  const [actor, setActor] = useState("");
  const [limit, setLimit] = useState(30);
  if (!store.can("team")) return <NoAccess text="你的账号没有开通「团队」，请联系管理员。" />;
  const loads = memberLoads(store, store.acc, today()).sort((a, b) =>
    b.tasks.length - a.tasks.length || b.overdue - a.overdue || b.blocked - a.blocked || a.person.name.localeCompare(b.person.name, "zh-CN"));
  const maxLoad = Math.max(1, loads[0]?.tasks.length ?? 0);
  const feed = recentActivity(store, store.acc, { project, person: actor, limit });
  return <div className="mx-auto max-w-[1180px] text-[13px]">
    <PageHeader title="团队" desc="查看当前可见项目的成员负载与动态。" />
    <section aria-labelledby="member-load-heading" className="mb-7">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="member-load-heading" className="font-medium">成员负载 <span className="ml-1 text-xs font-normal text-fg-3">{loads.length} 人</span></h2>
        <p className="text-xs text-fg-3">按未完成工作项排序，只计最末级工作项。逾期可与其他状态重叠。</p>
      </div>
      <Card className="@container divide-y divide-line overflow-hidden">
        {loads.length > 0 && (
          <div aria-hidden="true" className={cx(loadColumns, "hidden bg-canvas px-4 py-2 text-xs text-fg-3 @min-[36rem]:grid")}>
            <span className="pl-5">成员</span>
            <span>未完成</span>
            {loadMetrics.map(({ key, label }) => <span key={key} className="text-center">{label}</span>)}
          </div>
        )}
        {loads.map((row) => (
          <details key={row.person.id} className="group">
            <summary className={cx(loadColumns, "cursor-pointer list-none gap-y-2 px-4 py-2.5 hover:bg-hover [&::-webkit-details-marker]:hidden")}>
              <span className="col-span-3 flex min-w-0 items-center gap-2 @min-[36rem]:col-span-1">
                <ChevronRight aria-hidden="true" className="h-3 w-3 shrink-0 text-fg-3 transition-transform group-open:rotate-90" />
                <Avatar id={row.person.id} size={6} />
                <span className="truncate font-medium">{row.person.name}</span>
              </span>
              <span className="col-span-2 flex min-w-0 items-center justify-end gap-2 tabular-nums @min-[36rem]:col-span-1 @min-[36rem]:justify-start">
                <span className="shrink-0 text-xs text-fg-3 @min-[36rem]:sr-only">未完成</span>
                <span className="shrink-0 font-semibold @min-[36rem]:w-6">{row.tasks.length}</span>
                <span aria-hidden="true" className="hidden h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-sunken @min-[36rem]:block">
                  <span className="block h-full rounded-full bg-accent/60" style={{ width: `${row.tasks.length / maxLoad * 100}%` }} />
                </span>
              </span>
              {loadMetrics.map(({ key, label }) => (
                <span key={key} className="flex min-w-0 flex-col items-center whitespace-nowrap text-xs tabular-nums">
                  <span className="text-fg-3 @min-[36rem]:sr-only">{label}</span>
                  <span className={cx("min-w-6 rounded px-1 text-center leading-5",
                    !row[key] ? "text-fg-4" : key === "blocked" || key === "overdue" ? "bg-danger-soft font-medium text-danger" : "text-fg-2")}>{row[key]}</span>
                </span>
              ))}
            </summary>
            {row.tasks.length ? (
              <ul className="divide-y divide-line border-t border-line bg-canvas">
                {row.tasks.map((x) => (
                  <li key={x.id} className="flex flex-wrap items-center gap-2 px-4 py-2 @min-[36rem]:pl-9">
                    <Link href={`/item/${x.id}`} className="min-w-0 flex-1 hover:underline">{x.title}</Link>
                    <StatusBadge s={statusOf(store.items, x)} label={statusLabel(statusOf(store.items, x), x)} />
                    <DueText items={store.items} item={x} />
                  </li>
                ))}
              </ul>
            ) : <Empty>当前没有未完成工作项</Empty>}
          </details>
        ))}
        {!loads.length && <Empty>当前可见范围没有成员负载</Empty>}
      </Card>
    </section>
    <div className="mb-3 flex flex-wrap items-center gap-2"><h2 className="mr-auto font-medium">最近动态 <span className="font-normal text-fg-4">{feed.total} 条</span></h2>
      <Select label="按项目筛选动态" value={project} onValueChange={(value) => { setProject(value); setLimit(30); }} className="w-auto! max-w-48" options={[
        { value: "", label: "全部项目" },
        ...store.projects.map((p) => ({ value: p.id, label: p.title })),
        ...[...new Set((store.activities ?? []).filter((a) => !store.projects.some((p) => p.id === a.projectId)).map((a) => a.projectId))].map((id) => ({ value: id, label: `已删除项目 ${id}` })),
      ]} />
      <Select label="按人筛选动态" value={actor} onValueChange={(value) => { setActor(value); setLimit(30); }} className="w-auto!" options={[
        { value: "", label: "全部人员" },
        ...store.people.map((p) => ({ value: p.id, label: p.name })),
      ]} />
    </div>
    <Card>{feed.entries.length ? <ol className="divide-y divide-line">{feed.entries.map((e) => <li key={e.id} className="flex gap-3 px-4 py-3"><Avatar id={e.by} size={6} /><div className="min-w-0 flex-1"><p className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="font-medium">{person(e.by).name}</span>{e.deleted ? <span className="text-fg-3">{e.title}（已删除）</span> : <Link href={`/item/${e.itemId}`} className="text-accent-fg hover:underline">{e.title}</Link>}<time className="ml-auto text-xs text-fg-4">{e.date}{e.at ? ` ${new Date(e.at).toLocaleTimeString("zh-CN", { timeZone: store.timezone, hour: "2-digit", minute: "2-digit" })}` : ""}</time></p><p className="mt-1 whitespace-pre-wrap break-words text-fg-2"><MentionText text={e.text} mentions={e.mentions} /></p></div></li>)}</ol> : <Empty>没有符合条件的动态</Empty>}</Card>
    {feed.entries.length < feed.total && <button className={`${btn2} mt-3`} onClick={() => setLimit((n) => n + 30)}>加载更多</button>}
  </div>;
}
