"use client";

import { DefectDialog } from "@/components/DefectDialog";
import { SelectionMotion } from "@/components/SelectionMotion";
import { AttachmentList } from "@/components/Attachments";
import { EvidenceDialog } from "@/components/EvidenceDialog";
import { canMaintainDefect } from "@/lib/access";
import { qualitySummary } from "@/lib/evidence";
import StateBoundary from "@/components/StateBoundary";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { Badge, Card, Empty, NoAccess, PageHeader, People, btn, btnGhost, sm, cx } from "@/components/ui";
import { Tip, TipProvider } from "@/components/kit";
import { usePeek } from "@/components/Peek";
import { useToast } from "@/components/Toast";
import { fmt } from "@/lib/model";
import { useStore } from "@/lib/store";
import { projectOf } from "@/lib/tree";

function DefectTitle({ title, href }: { title: string; href: string }) {
  const [element, setElement] = useState<HTMLAnchorElement | null>(null);
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    if (!element) return;
    const observer = new ResizeObserver(() => setClipped(element.scrollHeight > element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, title]);

  return (
    <TipProvider delayDuration={0} skipDelayDuration={0} disableHoverableContent>
      <Tip widthClass="max-w-[min(26rem,var(--radix-tooltip-content-available-width))]" content={clipped && (
        <span className="block whitespace-pre-wrap wrap-anywhere leading-5">{title}</span>
      )}>
        <Link ref={setElement} href={href} className="block wrap-anywhere font-medium leading-5 text-accent hover:underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-focus pointer-fine:line-clamp-2">{title}</Link>
      </Tip>
    </TipProvider>
  );
}

export default function Quality() {
  return <StateBoundary><QualityContent /></StateBoundary>;
}

function QualityContent() {
  const { items, visible, can, acc, fixDefect } = useStore();
  const peek = usePeek();
  const toast = useToast();
  const [filter, setFilter] = useState<"open" | "fixed" | "all">("open");
  const [showAll, setShowAll] = useState(false);
  const [open, setOpen] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  const summary = qualitySummary(visible);
  const { defects, checks } = summary;
  const openCount = summary.open;
  const [evidence, setEvidence] = useState<keyof typeof summary.evidence | null>(null);
  const list = defects.filter((d) => filter === "all" || d.status === filter).sort((a, b) => a.severity.localeCompare(b.severity));
  const recentChecks = [...checks].sort((a, b) => b.date.localeCompare(a.date));

  const fix = async (id: string, defectId: string) => {
    if (fixing) return;
    setFixing(defectId);
    try { if ((await fixDefect(id, defectId)).ok) toast("已标记修复"); }
    catch { toast("标记修复失败，请重试", undefined, "warn"); }
    finally { setFixing(null); }
  };

  if (!can("quality")) return <NoAccess text="你的账号没有开通「质量中心」菜单，请联系管理员。" />;

  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader title="质量中心" desc={`测试、评审、验收、缺陷、返工的全部记录，可追溯到具体任务 · ${acc.scope === "all" ? "全部项目" : "你有权限的项目"}`} action={<button className={btn} onClick={() => setOpen(true)}><Plus />登记缺陷</button>} />
      {evidence && <EvidenceDialog title="质量统计明细" rows={summary.evidence[evidence]} onClose={() => setEvidence(null)} />}
      <Card className="mb-5 overflow-x-auto">
        <div className="grid min-w-[560px] grid-cols-4 divide-x divide-line">
          {[
            { key: "open" as const, label: "未关闭缺陷", value: summary.open, hint: "待处理" },
            { key: "escape" as const, label: "缺陷逃逸率", value: summary.escape === null ? "—" : summary.escape + "%", hint: "线上缺陷 / 全部缺陷" },
            { key: "firstPass" as const, label: "一次通过率", value: summary.firstPass === null ? "—" : summary.firstPass + "%", hint: "首次独立验收通过 / 有独立验收的工作项" },
            { key: "failed" as const, label: "打回次数", value: summary.failed, hint: "评审 / 验收不通过" },
          ].map((s) => <button key={s.key} onClick={() => setEvidence(s.key)} className="px-4 py-3 text-left hover:bg-hover"><div className="text-xs text-fg-3">{s.label}</div><div className="mt-1 text-xl font-semibold tabular-nums underline decoration-dotted underline-offset-4">{s.value}</div><div className="text-[11px] text-fg-4">{s.hint}</div></button>)}

        </div>
      </Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-[13px] font-medium">缺陷</h2>
        <SelectionMotion value={filter} className="selection-segment flex rounded-md bg-sunken p-0.5" role="group" aria-label="缺陷状态">
          {([{ key: "open", label: "未关闭", count: openCount }, { key: "fixed", label: "已修复", count: defects.length - openCount }, { key: "all", label: "全部", count: defects.length }] as const).map((f) => <button key={f.key} data-selection-value={f.key} aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} className={cx("h-6 rounded px-2 text-xs", filter === f.key ? "text-fg" : "text-fg-3 hover:text-fg")}>{f.label}<span className="ml-1 tabular-nums text-fg-4">{f.count}</span></button>)}
        </SelectionMotion>
      </div>
      <Card className="mb-5 overflow-x-auto">
        {list.length ? <table className="w-full min-w-[900px] text-left text-[13px]">
          <thead className="h-8 bg-canvas text-xs text-fg-4"><tr>{["级别", "缺陷", "所属任务 / 项目", "发现环节", "负责人", "状态", ""].map((h, i) => <th key={i} className="px-3 font-normal">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">{list.map((d) => <tr key={`${d.x.id}-${d.id}`} className="hover:bg-hover">
            <td className="px-3 py-2"><Badge className={d.severity <= "P1" ? "bg-danger-soft text-danger" : d.severity === "P2" ? "bg-warn-soft text-warn" : undefined}>{d.severity}</Badge></td>
            <td className="max-w-64 px-3 py-2"><AttachmentList ids={d.attachmentIds} inlineWith={<DefectTitle title={d.title} href={`/item/${d.x.id}/defect/${d.id}`} />} /></td>
            <td className="max-w-56 px-3 py-2"><Link href={`/item/${d.x.id}`} onClick={peek.onLinkClick(d.x.id)} className="block truncate hover:underline">{d.x.title}</Link><span className="block truncate text-xs text-fg-4">{projectOf(items, d.x).title}</span></td>
            <td className="whitespace-nowrap px-3 py-2 text-xs text-fg-3">{d.foundAt}{d.foundAt === "线上" && <span className="ml-1"><Badge className="bg-danger-soft text-danger">逃逸</Badge></span>}</td>
            <td className="px-3 py-2"><People ids={[d.owner]} /></td>
            <td className={cx("whitespace-nowrap px-3 py-2 text-xs", d.status === "open" ? "text-fg-2" : "text-fg-4")}>{d.status === "open" ? "未关闭" : "已修复"}</td>
            <td className="px-3 py-2 text-right">{d.status === "open" && canMaintainDefect(items, d.x, d, acc) && <button disabled={fixing !== null} onClick={() => void fix(d.x.id, d.id)} className={cx(btnGhost, sm, "text-ok")}>{fixing === d.id ? "处理中…" : "标记已修复"}</button>}</td>
          </tr>)}</tbody>
        </table> : <Empty>暂无{filter === "open" ? "未关闭" : filter === "fixed" ? "已修复" : ""}缺陷</Empty>}
      </Card>
      <Card>
        <div className="flex h-9 items-center justify-between border-b border-line px-3"><h2 className="text-[13px] font-medium">验证记录 <span className="ml-1 text-xs font-normal text-fg-4">{checks.length} 条</span></h2>{checks.length > 20 && <button onClick={() => setShowAll(!showAll)} className={cx(btnGhost, sm)}>{showAll ? "收起" : "显示全部"}</button>}</div>
        {checks.length ? <ul className="divide-y divide-line">{(showAll ? recentChecks : recentChecks.slice(0, 20)).map((c) => <li key={c.x.id + c.id} className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-[13px] hover:bg-hover">
          <span className="text-xs tabular-nums text-fg-4">{fmt(c.date)}</span><span>{c.type}</span><span className={cx("text-xs", c.result === "通过" ? "text-ok" : "text-danger")}>{c.result}</span>
          <Link href={`/item/${c.x.id}`} onClick={peek.onLinkClick(c.x.id)} className="max-w-72 truncate hover:underline">{c.x.title}</Link><span className="min-w-0 text-xs text-fg-3">{c.note}</span>
        </li>)}</ul> : <Empty>暂无验证记录</Empty>}
      </Card>
      {open && <DefectDialog onClose={() => setOpen(false)} onSaved={() => setFilter("open")} />}
    </div>
  );
}
