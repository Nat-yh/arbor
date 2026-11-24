import { Check, Eye, RotateCcw, Send, Undo2 } from "lucide-react";
import { useState } from "react";
import { canVerifyDelivery } from "@/lib/access";
import { assigneeNames, isAssignee, person, type WorkItem } from "@/lib/model";
import { useStore } from "@/lib/store";
import { statusOf, verifiersOf } from "@/lib/tree";
import { useToast } from "./Toast";
import { btn, btn2, btnGhost, cx, field } from "./ui";

type Action = "publish" | "failed" | "rollback" | "reject";

export function ProductionStep({ item }: { item: WorkItem }) {
  const { items, me, acc, productionAction } = useStore();
  const toast = useToast();
  const [form, setForm] = useState<Action | null>(null);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const stage = statusOf(items, item);
  const awaitingRelease = stage === "release";
  const awaitingAcceptance = stage === "production-review";
  const canPublish = isAssignee(item, me);
  const canAccept = canVerifyDelivery(items, item, acc);
  const publication = item.publication;
  const version = publication?.version;
  const cycle = item.releaseCycle?.id;
  const Icon = awaitingRelease ? Send : awaitingAcceptance ? Eye : Check;
  const title = awaitingRelease ? "待发布到生产" : awaitingAcceptance ? "待线上验收" : "线上验收已通过";
  const awaiting = awaitingRelease ? assigneeNames(item) : verifiersOf(items, item).map((id) => person(id).name).join("、");
  const inputLabel = form === "publish" ? "生产版本或发布链接" : form === "reject" ? "线上验收打回原因" : form === "rollback" ? "回滚原因" : "发布失败原因";

  const open = (action: Action) => {
    setValue("");
    setForm(action);
  };
  const save = async (action: Action | "accept") => {
    if (busy || !cycle || (action !== "accept" && !value.trim())) return;
    setBusy(true);
    try {
      const id = item.id;
      const note = value.trim();
      const publicationId = publication?.id;
      const result = action === "publish" ? await productionAction({ type: "publish", id, cycle, version: note })
        : action === "accept" || action === "reject" ? publicationId && await productionAction({ type: "verifyProduction", id, publicationId, pass: action === "accept", note: action === "accept" ? "" : note })
        : await productionAction({ type: "recordReleaseIssue", id, cycle, publicationId: publicationId ?? null, note });
      if (!result || !result.ok) return;
      setForm(null);
      setValue("");
      const titles = { publish: "已记录生产发布", failed: "已记录发布失败", rollback: "已记录回滚", reject: "已打回修改", accept: "线上验收已通过" };
      toast(titles[action], item.title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div id="next-step" className={cx("item-next-step mt-4 rounded-lg border px-4 py-3", stage === "done" ? "border-st-done/25 bg-ok-soft" : "border-accent/25 bg-accent-soft/60")}>
      <div className="flex flex-wrap items-center gap-3">
        <span className={cx("flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white", stage === "done" ? "bg-st-done" : "bg-accent")}><Icon size={15} /></span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-fg">{title}</div>
          <div className="mt-0.5 break-words text-xs text-fg-3">
            {stage !== "done" && awaiting && <span>{awaitingRelease ? "执行人" : "验收人"} {awaiting}</span>}
            {version && <span className={cx(stage !== "done" && awaiting && "ml-2")}>生产版本 {/^https?:\/\//.test(version) ? <a href={version} target="_blank" rel="noreferrer" className="break-all text-accent-fg hover:underline">{version}</a> : version}</span>}
          </div>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          {awaitingRelease && canPublish && <>
            <button type="button" className={btn2} disabled={busy} onClick={() => open("failed")}>记录发布失败</button>
            <button type="button" className={btn} disabled={busy} onClick={() => open("publish")}><Send />记录已发布</button>
          </>}
          {awaitingAcceptance && canAccept && <>
            <button type="button" className={btn2} disabled={busy} onClick={() => open("reject")}><Undo2 />打回修改</button>
            <button type="button" className={btn} disabled={busy} onClick={() => void save("accept")}><Check />线上验收通过</button>
          </>}
          {version && canPublish && <button type="button" className={btn2} disabled={busy} onClick={() => open("rollback")}><RotateCcw />记录回滚</button>}
        </div>
      </div>
      {form && (
        <form className="mt-3 flex flex-wrap items-end gap-2 border-t border-line pt-3" onSubmit={(event) => { event.preventDefault(); void save(form); }}>
          <label className="min-w-48 flex-1 text-xs text-fg-3">
            {inputLabel}
            <input autoFocus required maxLength={2000} value={value} onChange={(event) => setValue(event.target.value)} className={cx(field, "mt-1")} />
          </label>
          <button type="button" className={btnGhost} disabled={busy} onClick={() => setForm(null)}>取消</button>
          <button type="submit" className={btn} disabled={busy || !value.trim()}>{form === "publish" ? "确认已发布" : form === "reject" ? "确认打回" : form === "rollback" ? "确认已回滚" : "确认发布失败"}</button>
        </form>
      )}
    </div>
  );
}
