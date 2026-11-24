"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { WorkItem } from "@/lib/model";
import { useStore } from "@/lib/store";
import { openChecks } from "@/lib/tree";
import { Modal, ModalFooter, useModalExit } from "./kit";
import { btn, btn2, btnGhost, cx, field } from "./ui";
import { AttachmentComposer } from "./Attachments";
import { ActionFeedback, LiquidButtonFace, useActionFeedback } from "./ActionFeedback";
import { SelectionMotion } from "./SelectionMotion";
import { MentionInput, type Mentions } from "./MentionInput";

export function ProgressEditor({ value, onChange, guidePreset }: { value: number; onChange: (value: number) => void; guidePreset?: boolean }) {
  return <div className="flex flex-wrap items-center gap-1" role="group" aria-label="进度">
    <SelectionMotion value={String(value)} className="selection-segment inline-flex bg-sunken p-0.5" role="group" aria-label="进度预设">
      {[0, 25, 50, 75, 100].map((preset) => (
        <button type="button" key={preset} data-selection-value={preset} data-guide={guidePreset && preset === 50 ? "progress-preset" : undefined}
          aria-pressed={value === preset} onClick={() => onChange(preset)}
          className={cx("h-7 min-w-9 px-1.5 text-xs font-medium tabular-nums transition-[color]", value === preset ? "text-accent-fg" : "text-fg-3 hover:text-fg")}>{preset}%</button>
      ))}
    </SelectionMotion>
    <label className="ml-1 flex items-center gap-1 text-xs text-fg-3"><input required type="number" min={0} max={100} step={1} value={Number.isFinite(value) ? value : ""} onChange={(e) => onChange(e.target.value === "" ? NaN : e.target.valueAsNumber)} aria-label="自定义进度" className={cx(field, "h-8! w-16! px-2! tabular-nums")} />%</label>
  </div>;
}

export function QuickProgress({ item, onClose }: { item: WorkItem; onClose: () => void }) {
  const { open, dismiss } = useModalExit(onClose);
  const store = useStore();
  const router = useRouter();
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const [progress, setProgress] = useState(item.progress);
  const [text, setText] = useState("");
  const [mentions, setMentions] = useState<Mentions>([]);
  const [busy, setBusy] = useState(false);
  const [attachmentIds, setAttachmentIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [completion, setCompletion] = useState(false);
  const isProject = item.kind === "project";
  const valid = text.trim() && (isProject || (Number.isFinite(progress) && progress >= 0 && progress <= 100));
  const send = async () => {
    if (!valid || busy || uploading) return;
    setBusy(true);
    try {
      const result = await store.postUpdate(item.id, text.trim(), isProject ? undefined : progress, attachmentIds, mentions.map(({ id }) => id));
      if (!result.ok) return;
      await acknowledge("publish");
      if (!isProject && progress === 100) setCompletion(true); else dismiss();
    } finally { clearFeedback(); setBusy(false); }
  };
  return <Modal open={open} onOpenChange={(v) => { if (!v && !busy && !uploading) dismiss(); }} title={completion ? "进度已到 100%，下一步？" : `${isProject ? "写项目记录" : "更新进度"}：${item.title}`} desc={completion ? "提交给验证人验收，或者把不需要验收的小任务直接完成。" : isProject ? "项目进度按下级工作项自动汇总。" : "选择进度，并写一句当前进展。回车发布。"}>
    {completion ? <ModalFooter>
      <button className={btnGhost} disabled={busy} onClick={dismiss}>稍后</button>
      {item.kind === "task" && <button data-action-feedback="local" className={cx(btn2, "liquid-button liquid-success min-w-24", confirmed && "disabled:opacity-100")} disabled={busy || openChecks(store.items, item).length > 0} onClick={async () => { setBusy(true); try { if ((await store.setStatus(item.id, "done", undefined, () => acknowledge("complete"))).ok) dismiss(); } finally { clearFeedback(); setBusy(false); } }} aria-busy={busy && !confirmed}><LiquidButtonFace>直接完成</LiquidButtonFace>{confirmed && <ActionFeedback variant="complete" message="已完成" />}</button>}
      <button className={cx(btn2, "form-trigger form-trigger-accent")} disabled={busy} onClick={() => { dismiss(); router.push(`/item/${item.id}?submit=1`); }}>提交验收</button>
    </ModalFooter> : <form onKeyDown={(e) => { if (e.key === "Enter" && e.nativeEvent.isComposing) e.preventDefault(); }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
      <AttachmentComposer itemId={item.id} ids={attachmentIds} onChange={setAttachmentIds} onBusyChange={setUploading}>
        <div className="space-y-3 px-5 py-4">
          {isProject ? <p className="text-sm">项目记录</p> : <ProgressEditor value={progress} onChange={setProgress} />}
          <MentionInput item={item} autoFocus aria-required="true" value={text} onChange={setText}
            mentions={mentions} onMentions={setMentions} placeholder={isProject ? "写一条项目记录…" : "一句话说明做到哪了"}
            aria-label={isProject ? "项目记录" : "进展说明"} className={cx(field, "min-h-16 leading-6")}
            footer={(mentionButton) => <div className="-mx-5 -mb-4 mt-4">
              <ModalFooter left={mentionButton}>
                <button type="button" disabled={busy || uploading} className={btnGhost} onClick={dismiss}>取消</button>
                <button data-action-feedback="local" disabled={busy || uploading || !valid} type="submit" className={cx(btn, "liquid-button min-w-24", confirmed && "disabled:opacity-100")} aria-busy={busy && !confirmed}><LiquidButtonFace>{isProject ? "发布记录" : "发布进展"}</LiquidButtonFace>{confirmed && <ActionFeedback variant="publish" message="已发布" />}</button>
              </ModalFooter>
            </div>} />
        </div>
      </AttachmentComposer>
    </form>}
  </Modal>;
}
