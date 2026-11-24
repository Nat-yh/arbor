"use client";

import { ChevronDown, Search } from "lucide-react";
import { useRef, useState } from "react";
import { DEFECT_SEVERITIES, DEFECT_STAGES, type Defect, type DefectInput, type WorkItem } from "@/lib/model";
import { canSee, canMaintainDefect } from "@/lib/access";
import { useStore } from "@/lib/store";
import { isInactive, projectOf, statusOf } from "@/lib/tree";
import { ActionFeedback, LiquidButtonFace, useActionFeedback } from "./ActionFeedback";
import { AttachmentComposer } from "./Attachments";
import { Modal, ModalFooter, Pop, PopContent, PopTrigger, Select } from "./kit";
import { PersonSelect } from "./pickers";
import { useToast } from "./Toast";
import { btn, btnGhost, cx, Empty, field, StatusIcon } from "./ui";

export function DefectDialog({ item, defect, onClose, onSaved }: {
  item?: WorkItem;
  defect?: Defect;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { acc, accounts, items, people, me, defectOwnerCandidates, addDefect, editDefect } = useStore();
  const toast = useToast();
  const [itemId, setItemId] = useState(item?.id ?? "");
  const [draft, setDraft] = useState<DefectInput>(() => defect ? {
    title: defect.title, description: defect.description, owner: defect.owner,
    severity: defect.severity, foundAt: defect.foundAt, attachmentIds: defect.attachmentIds,
  } : { title: "", severity: "P2", foundAt: "测试", owner: item?.assignee ?? me });
  const [expected] = useState(defect?.revision ?? 0);
  const requestId = useRef<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const selected = items.find((entry) => entry.id === itemId);
  const project = selected && projectOf(items, selected);
  const allowedIds = project && defectOwnerCandidates?.[project.id];
  const eligible = !selected ? [] : people.filter(({ id }) => allowedIds
    ? allowedIds.includes(id)
    : accounts.some((account) => account.id === id && canSee(items, selected, account)));
  const owner = eligible.some(({ id }) => id === draft.owner) || defect?.owner === draft.owner
    ? draft.owner : eligible.some(({ id }) => id === me) ? me : "";
  const candidates = item || !picking ? [] : items.filter((entry) => !isInactive(items, entry) &&
    `${entry.title} ${entry.id} ${projectOf(items, entry).title}`.toLowerCase().includes(query.trim().toLowerCase()));
  const permitted = selected && (defect
    ? canMaintainDefect(items, selected, defect, acc)
    : acc.menus.includes("quality") && !isInactive(items, selected));
  const ready = permitted && owner && draft.title.trim() && !busy && !uploading;
  const action = defect ? "保存修改" : "登记缺陷";

  async function save() {
    if (!ready || !selected) return;
    setBusy(true);
    setError("");
    const input = { ...draft, owner, attachmentIds: draft.attachmentIds ?? [] };
    try {
      const result = defect
        ? await editDefect(selected.id, defect.id, input, expected)
        : await addDefect(selected.id, input, requestId.current ??= crypto.randomUUID());
      if (!result.ok) { setError(result.reason || "保存失败，请重试"); return; }
      await acknowledge();
      toast(defect ? "缺陷已更新" : "缺陷已登记", undefined, "info");
      onSaved?.();
      onClose();
    } catch {
      setError("保存失败，请重试");
    } finally {
      clearFeedback();
      setBusy(false);
    }
  }

  return (
    <Modal open onOpenChange={(open) => { if (!open && !busy && !uploading) onClose(); }}
      title={defect ? "编辑缺陷" : "登记缺陷"} desc={item?.title ?? "选择发现问题的工作项。"}>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <fieldset disabled={busy} className="min-w-0 px-5 pb-3 pt-4">
          <AttachmentComposer key={itemId} itemId={itemId} ids={draft.attachmentIds ?? []}
            onChange={(attachmentIds) => setDraft((prev) => ({ ...prev, attachmentIds }))} onBusyChange={setUploading}>
            <div className="space-y-3 pb-2 text-[13px]">
              {!item && <div className="space-y-1.5">
                <div className="text-xs text-fg-3">关联工作项</div>
                <Pop open={picking} onOpenChange={setPicking}>
                  <PopTrigger asChild>
                    <button type="button" aria-label="关联工作项" className={cx(field, "flex items-center gap-2 text-left")}>
                      {selected ? <><StatusIcon s={statusOf(items, selected)} /><span className="flex-1 truncate">{selected.title}</span></>
                        : <span className="flex-1 text-fg-4">选择工作项</span>}
                      <ChevronDown className="size-3.5 shrink-0 text-fg-4" />
                    </button>
                  </PopTrigger>
                  <PopContent className="w-[min(420px,calc(100vw-48px))]">
                    <div className="flex items-center gap-2 border-b border-line px-2 py-1">
                      <Search className="size-3.5 text-fg-4" />
                      <input aria-label="搜索关联工作项" autoFocus value={query} onChange={(event) => setQuery(event.target.value)}
                        placeholder="搜索标题、编号或项目" className="h-8 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-4" />
                    </div>
                    <div className="max-h-56 overflow-y-auto py-1">
                      {candidates.map((entry) => <button type="button" key={entry.id} disabled={uploading} onClick={() => {
                        if (entry.id !== itemId) {
                          setItemId(entry.id);
                          requestId.current = null;
                          setDraft((prev) => ({ ...prev, attachmentIds: [] }));
                        }
                        setPicking(false);
                      }} className={cx("flex min-h-9 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] hover:bg-hover", itemId === entry.id && "bg-active")}>
                        <StatusIcon s={statusOf(items, entry)} /><span className="min-w-0 flex-1 truncate">{entry.title}</span>
                        <span className="max-w-32 truncate text-xs text-fg-4">{projectOf(items, entry).title}</span>
                      </button>)}
                      {!candidates.length && <Empty>没有符合条件的工作项</Empty>}
                    </div>
                  </PopContent>
                </Pop>
              </div>}
              <label className="block space-y-1.5">
                <span className="text-xs text-fg-3">缺陷标题</span>
                <textarea required rows={2} maxLength={300} value={draft.title}
                  onChange={(event) => setDraft({ ...draft, title: event.target.value })}
                  className={cx(field, "min-h-14 resize-y")} placeholder="简要说明问题" />
              </label>
              <label className="block space-y-1.5">
                <span className="text-xs text-fg-3">问题说明</span>
                <textarea rows={3} maxLength={20000} value={draft.description ?? ""}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                  className={cx(field, "min-h-20 resize-y")} placeholder="可填写复现步骤、预期结果和实际结果" />
              </label>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5"><div className="text-xs text-fg-3">严重程度</div>
                  <Select label="严重程度" value={draft.severity} onValueChange={(value) => setDraft({ ...draft, severity: value as Defect["severity"] })}
                    options={DEFECT_SEVERITIES.map((value) => ({ value, label: value }))} />
                </div>
                <div className="space-y-1.5"><div className="text-xs text-fg-3">发现环节</div>
                  <Select label="发现环节" value={draft.foundAt} onValueChange={(value) => setDraft({ ...draft, foundAt: value as Defect["foundAt"] })}
                    options={DEFECT_STAGES.map((value) => ({ value, label: value }))} />
                </div>
              </div>
              <div className="space-y-1.5"><div className="text-xs text-fg-3">负责人</div>
                <PersonSelect label="负责人" value={owner} disabled={!selected || busy} people={eligible} onPick={(value) => setDraft({ ...draft, owner: value })} />
              </div>
              {draft.severity <= "P1" && <p className="text-xs text-fg-3">P0 / P1 缺陷未关闭时会阻止关联需求通过验收。</p>}
            </div>
          </AttachmentComposer>
          {error && <p role="alert" className="mt-2 text-xs text-danger">{error}</p>}
        </fieldset>
        <ModalFooter>
          <button type="button" disabled={busy || uploading} className={btnGhost} onClick={onClose}>取消</button>
          <button type="submit" data-action-feedback="local" disabled={!ready} aria-busy={busy && !confirmed} className={cx(btn, "liquid-button")}>
            <LiquidButtonFace>{action}</LiquidButtonFace>
            {confirmed && <ActionFeedback message={defect ? "已保存" : "已登记"} />}
          </button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
