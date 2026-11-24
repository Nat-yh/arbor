"use client";

import { ListTree, Play } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { dateOffset, fmt, today, type WorkItem } from "@/lib/model";
import type { QueueReason } from "@/lib/queue";
import { useStore } from "@/lib/store";
import { StartActionButton, UpdateActionButton } from "./ActionFeedback";
import { Modal, ModalFooter } from "./kit";
import { usePeek } from "./Peek";
import { openCreate } from "./QuickCreate";
import { useToast } from "./Toast";
import { Badge, btn, btn2, btnGhost, cx, field, ItemTypeBadge, sm } from "./ui";

type Action = "block" | "defer" | "direct";
const ACTIONS = {
  block: "标记阻塞",
  defer: "暂无变化",
  direct: "确认直接交付",
} as const;

export function WorkAttentionRow({ item, reason, risk, onUpdate, onAction }: {
  item: WorkItem; reason: QueueReason; risk?: string; onUpdate: () => void; onAction: (action: Action) => void;
}) {
  const { items, setStatus } = useStore();
  const peek = usePeek();
  const toast = useToast();
  return (
    <li className="dashboard-attention-row flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 transition-colors hover:bg-hover">
      <div className="min-w-0 flex-[1_1_15rem]">
        <div className="flex min-w-0 items-center gap-2">
          <ItemTypeBadge items={items} item={item} />
          <Link href={`/item/${item.id}`} onClick={peek.onLinkClick(item.id)} className="min-w-0 truncate font-medium hover:underline" title={item.title}>{item.title}</Link>
          {risk && <Badge className="bg-danger-soft text-danger">{risk}</Badge>}
        </div>
        <p className="mt-0.5 wrap-anywhere text-xs text-fg-3">{reason.detail} · 截止 {fmt(item.due)}</p>
      </div>
      <div className="dashboard-attention-actions ml-auto flex shrink-0 flex-wrap items-center justify-end gap-1">
        {reason.attention === "stale" && <>
          <UpdateActionButton className={cx(btn2, sm)} onActivate={onUpdate}>更新进展</UpdateActionButton>
          <button type="button" className={cx(btnGhost, sm)} onClick={() => onAction("block")}>标记阻塞</button>
          <button type="button" className={cx(btnGhost, sm)} onClick={() => onAction("defer")}>暂无变化</button>
        </>}
        {reason.attention === "split_needed" && <>
          <button type="button" className={cx(btn2, sm)} onClick={() => openCreate(item.id)}><ListTree />拆分任务</button>
          <button type="button" className={cx(btnGhost, sm)} onClick={() => onAction("direct")}>直接交付</button>
        </>}
        {reason.attention === "start_late" && (
          <StartActionButton onStart={async (feedback) => { if ((await setStatus(item.id, "doing", undefined, feedback)).ok) toast("已开始", item.title); }}
            className={cx(btn, sm)}><Play />开始</StartActionButton>
        )}
      </div>
    </li>
  );
}

export function WorkAttentionDialog({ item, action, onClose }: { item: WorkItem; action: Action; onClose: () => void }) {
  const { setStatus, deferProgress, confirmDirectDelivery } = useStore();
  const toast = useToast();
  const tomorrow = dateOffset(today(), 1);
  const [until, setUntil] = useState(tomorrow);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const valid = action === "block" ? !!reason.trim() : action !== "defer" || until >= tomorrow;
  const description = action === "direct" ? "确认这项需求可按当前排期直接交付，之后仍可拆分子任务。"
    : action === "defer" ? "到约定日期再提醒更新进展。到期和逾期提醒照常生效。" : "写明目前遇到的阻塞，方便负责人协调。";
  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const result = action === "block" ? await setStatus(item.id, "blocked", reason.trim())
        : action === "defer" ? await deferProgress(item.id, until) : await confirmDirectDelivery(item.id);
      if (!result.ok) return;
      toast(action === "block" ? "已标记阻塞" : action === "defer" ? `下次更新已约在 ${fmt(until)}` : "已确认可直接交付", item.title);
      onClose();
    } finally { setBusy(false); }
  }
  return (
    <Modal open onOpenChange={(open) => { if (!open && !busy) onClose(); }} title={ACTIONS[action]} desc={description}>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="space-y-3 px-5 py-4">
          <p className="wrap-anywhere text-[13px] font-medium text-fg">{item.title}</p>
          {action === "defer" && <label className="block text-xs text-fg-3">下次更新时间
            <input type="date" value={until} min={tomorrow} required onChange={(event) => setUntil(event.target.value)} disabled={busy} className={cx(field, "mt-1")} />
          </label>}
          {action === "block" && <label className="block text-xs text-fg-3">阻塞原因
            <textarea rows={3} required value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} className={cx(field, "mt-1")} />
          </label>}
        </div>
        <ModalFooter>
          <button type="button" className={btnGhost} disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className={btn} disabled={busy || !valid}>{action === "direct" ? "确认" : "保存"}</button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
