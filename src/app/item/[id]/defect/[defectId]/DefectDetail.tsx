"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Check, ChevronRight, Pencil, RotateCcw } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AttachmentList } from "@/components/Attachments";
import { DefectDialog } from "@/components/DefectDialog";
import { useToast } from "@/components/Toast";
import { Badge, Card, Empty, People, btn, btn2, btnGhost, cx, sm } from "@/components/ui";
import { canMaintainDefect } from "@/lib/access";
import { fmt } from "@/lib/model";
import { useStore } from "@/lib/store";
import { projectOf } from "@/lib/tree";

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-start gap-2">
    <dt className="text-fg-3">{label}</dt><dd className="min-w-0 wrap-anywhere">{children}</dd>
  </div>;
}

export default function DefectDetail() {
  const { id: itemId, defectId } = useParams<{ id: string; defectId: string }>();
  const { items, get, acc, can, fixDefect, reopenDefect } = useStore();
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const item = get(itemId);
  const defect = item?.defects.find(({ id }) => id === defectId);
  const taskUrl = `/item/${encodeURIComponent(itemId)}?tab=quality`;
  if (!item || !defect) return <Card className="mx-auto max-w-3xl">
    <Empty>
      <p>缺陷不存在或你没有权限查看。</p>
      <Link href={item ? taskUrl : can("quality") ? "/quality" : "/projects"} className="mt-2 inline-block text-accent hover:underline">
        {item ? "返回工作项" : can("quality") ? "返回质量中心" : "返回项目"}
      </Link>
    </Empty>
  </Card>;

  const project = projectOf(items, item);
  const open = defect.status === "open";
  const allowed = canMaintainDefect(items, item, defect, acc);

  async function changeStatus() {
    if (busy || !allowed) return;
    setBusy(true);
    try {
      const result = await (open ? fixDefect : reopenDefect)(itemId, defectId);
      if (result.ok) toast(open ? "已标记修复" : "缺陷已重新打开");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1060px]">
      <nav aria-label="缺陷导航" className="mb-4 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-fg-3">
        {can("quality") && <>
          <Link href="/quality" className={cx(btnGhost, sm)}><ArrowLeft />质量中心</Link>
          <ChevronRight className="size-3.5 text-fg-4" aria-hidden />
        </>}
        <Link href={taskUrl} className="min-w-0 max-w-full truncate rounded px-1.5 py-1 hover:bg-hover hover:text-fg" title={item.title}>{item.title}</Link>
        <ChevronRight className="size-3.5 text-fg-4" aria-hidden />
        <span aria-current="page" className="px-1.5 text-fg">缺陷详情</span>
      </nav>

      <header className="mb-5 flex flex-wrap items-start justify-between gap-x-5 gap-y-3">
        <div className="min-w-0 flex-[1_1_22rem]">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Badge className={defect.severity <= "P1" ? "bg-danger-soft text-danger" : defect.severity === "P2" ? "bg-warn-soft text-warn" : undefined}>{defect.severity}</Badge>
            <Badge className={open ? "bg-warn-soft text-warn" : "bg-ok-soft text-ok"}>{open ? "未关闭" : "已修复"}</Badge>
          </div>
          <h1 className="whitespace-pre-wrap wrap-anywhere text-xl font-semibold leading-snug tracking-tight text-fg sm:text-2xl">{defect.title}</h1>
        </div>
        {allowed && <div className="flex flex-wrap items-center gap-2">
          <button type="button" className={btn2} disabled={busy} onClick={() => setEditing(true)}><Pencil />编辑缺陷</button>
          <button type="button" className={open ? btn : btn2} disabled={busy} onClick={() => void changeStatus()}>
            {open ? <Check /> : <RotateCcw />}{busy ? "处理中…" : open ? "标记已修复" : "重新打开"}
          </button>
        </div>}
      </header>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card>
          <section aria-labelledby="defect-description" className="px-4 py-4 sm:px-5">
            <h2 id="defect-description" className="mb-3 text-sm font-semibold">问题说明</h2>
            {defect.description
              ? <p className="whitespace-pre-wrap wrap-anywhere text-sm leading-6 text-fg-2">{defect.description}</p>
              : <p className="text-[13px] text-fg-3">暂无问题说明</p>}
          </section>
          <section aria-labelledby="defect-attachments" className="border-t border-line px-4 py-4 sm:px-5">
            <h2 id="defect-attachments" className="text-sm font-semibold">附件</h2>
            {defect.attachmentIds?.length ? <AttachmentList ids={defect.attachmentIds} />
              : <p className="mt-2 text-[13px] text-fg-3">暂无附件</p>}
          </section>
        </Card>
        <Card className="space-y-3 px-4 py-4 sm:px-5">
          <h2 className="text-sm font-semibold">缺陷信息</h2>
          <dl className="space-y-3 text-[13px]">
            <Fact label="负责人"><People ids={[defect.owner]} /></Fact>
            <Fact label="发现环节">{defect.foundAt}</Fact>
            {defect.by && <Fact label="登记人"><People ids={[defect.by]} /></Fact>}
            <Fact label="登记日期">{fmt(defect.date)}</Fact>
            <Fact label="关联工作项"><Link href={taskUrl} className="text-accent hover:underline">{item.title}</Link></Fact>
            {project.id !== item.id && <Fact label="所属项目">{project.title}</Fact>}
          </dl>
        </Card>
      </div>
      {editing && allowed && <DefectDialog item={item} defect={defect} onClose={() => setEditing(false)} />}
    </div>
  );
}
