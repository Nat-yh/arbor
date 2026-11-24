"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { canManage, canRemoveWorkItem } from "@/lib/access";
import { deleteBlockReason, canRestore } from "@/lib/lifecycle";
import { today, type WorkItem } from "@/lib/model";
import { useStore } from "@/lib/store";
import { isInactive } from "@/lib/tree";
import { Modal, ModalFooter } from "./kit";
import { ActionFeedback, LiquidButtonFace, useActionFeedback } from "./ActionFeedback";
import { btn, btnGhost, cx, field } from "./ui";
import { useToast } from "./Toast";

export type LifecycleAction = "cancel" | "archive" | "delete" | "restore" | "unarchive";

const LABELS: Record<LifecycleAction, string> = { cancel: "取消工作项", archive: "归档项目", delete: "删除", restore: "恢复工作项", unarchive: "解除归档" };
const RESULT_LABELS: Record<LifecycleAction, string> = {
  cancel: "已取消", archive: "已归档", delete: "已删除", restore: "已恢复", unarchive: "已解除归档",
};
const DESC: Record<LifecycleAction, string> = {
  restore: "恢复本项及因它连带取消的下级，重新计入进度、绩效、待办和提醒。单独取消的下级保持取消。",
  unarchive: "解除归档后可以继续更新项目，待办和提醒恢复。已取消的项保持取消。",
  cancel: "本项及下级会标为已取消：保留全部历史，不再计入进度、绩效和提醒。",
  archive: "归档后项目只读，停止待办和提醒，保留历史统计。",
  delete: "仅用于今天误建、还没有任何动态的项。删除后无法恢复，删除原因会保留在动态里。",
};

/** 当前账号对这一项能做哪些生命周期操作 */
export function useLifecycle(item: WorkItem) {
  const store = useStore();
  const { items, acc } = store;
  const manager = canManage(items, item, acc);
  const canCancel = canRemoveWorkItem(items, item, acc, "cancel");
  const canDelete = canRemoveWorkItem(items, item, acc, "delete");
  return {
    canCancel,
    canDelete,
    deleteHint: canDelete ? deleteBlockReason(store, item, today()) : undefined,
    canArchive: manager && item.kind === "project" && !isInactive(items, item),
    canRestore: manager && canRestore(items, item),
    canUnarchive: manager && item.kind === "project" && !!item.archivedAt,
  };
}

export function LifecycleDialog({ item, action, onClose }: { item: WorkItem; action: LifecycleAction | null; onClose: () => void }) {
  const store = useStore();
  const router = useRouter();
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const destructive = action === "cancel" || action === "delete";
  const restoring = action === "restore" || action === "unarchive";
  const effect = destructive ? "danger" : restoring ? "complete" : "ripple";
  const close = () => {
    setReason("");
    onClose();
  };
  const run = async () => {
    if (!action || !reason.trim() || busy) return;
    setBusy(true);
    try {
      const command = action === "delete" ? store.deleteItem : store[action];
      const result = await command(item.id, reason, () => acknowledge(effect));
      if (!result.ok) return;
      toast(RESULT_LABELS[action], "原因已记入动态");
      close();
      if (action === "delete") {
        // 在侧边抽屉里删除：抽屉切到上级，留在当前页面；整页删除才跳到上级页面
        const q = new URLSearchParams(window.location.search);
        if (q.get("peek") === item.id) {
          q.delete("review");
          if (item.parentId) q.set("peek", item.parentId); else q.delete("peek");
          router.replace(`${window.location.pathname}${q.size ? `?${q}` : ""}`, { scroll: false });
        } else router.push(item.parentId ? `/item/${item.parentId}` : "/projects");
      }
    } finally { clearFeedback(); setBusy(false); }
  };
  const description = action === "delete" && item.kind !== "project"
    ? "删除后无法恢复。进展、验收和缺陷记录会一并删除，项目统计会重新计算。删除原因会保留在动态里。"
    : action ? DESC[action] : undefined;
  return (
    <Modal open={!!action} onOpenChange={(v) => { if (!v && !busy) close(); }} title={action ? `${LABELS[action]}：${item.title}` : ""} desc={description}>
      <div className="px-5 pb-4 pt-3">
        <textarea autoFocus aria-label="操作原因" readOnly={busy} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} rows={3} placeholder={action === "restore" || action === "unarchive" ? "原因（必填），例如：需求重新启动 / 误取消" : "原因（必填），例如：需求方取消 / 重复创建"} className={field} />
      </div>
      <ModalFooter left="原因会写入动态，所有人可见">
        <button className={btnGhost} disabled={busy} onClick={close}>返回</button>
        <button
          className={cx(btn, "liquid-button", destructive && "liquid-danger", restoring && "liquid-success")}
          disabled={busy || !reason.trim()}
          aria-busy={busy && !confirmed}
          onClick={run}
        >
          <LiquidButtonFace>{action ? `确认${LABELS[action]}` : ""}</LiquidButtonFace>
          {confirmed && action && <ActionFeedback variant={effect} message={RESULT_LABELS[action]} />}
        </button>
      </ModalFooter>
    </Modal>
  );
}
