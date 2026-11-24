"use client";
import Link from "next/link";
import type { Evidence } from "@/lib/evidence";
import { Modal } from "./kit";
import { Empty } from "./ui";

export function EvidenceDialog({ title, rows, onClose }: { title: string; rows: Evidence[]; onClose: () => void }) {
  return <Modal open onOpenChange={(v) => { if (!v) onClose(); }} title={title} desc={`共 ${rows.length} 条样本；比例指标展示完整分母及每条记录的结果。`}>
    {rows.length ? <ul className="my-3 divide-y divide-line px-5">{rows.map((r) => <li key={r.id} className="py-3 text-[13px]"><Link href={r.defectId ? `/item/${r.itemId}/defect/${r.defectId}` : `/item/${r.itemId}`} className="font-medium text-accent-fg hover:underline" onClick={onClose}>{r.title}</Link>{r.date && <span className="ml-2 text-xs text-fg-4">{r.date}</span>}<p className="mt-1 whitespace-pre-wrap break-words text-xs text-fg-3">{r.detail}</p></li>)}</ul> : <Empty>当前范围没有样本</Empty>}
  </Modal>;
}
