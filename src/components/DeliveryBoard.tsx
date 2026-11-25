import Link from "next/link";
import { Clock3, Ellipsis, GripVertical, LoaderCircle } from "lucide-react";
import { Fragment, useEffect, useRef, useState, type DragEvent } from "react";
import { verifierAllowed } from "@/lib/access";
import { deliveryColumns, deliveryCommand, deliveryMoves, type DeliveryMove } from "@/lib/delivery-board";
import { assigneeNames, fmt, hasAcceptanceCriteria, person, requiresProduction, STATUS, statusLabel, usesAcceptanceCriteria, type Status, type WorkItem } from "@/lib/model";
import { useStore } from "@/lib/store";
import { dueStateOf, hasBlocked, statusOf, verifiersOf } from "@/lib/tree";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Modal, ModalFooter } from "./kit";
import { usePeek } from "./Peek";
import { PersonPicker } from "./pickers";
import { useToast } from "./Toast";
import { btn, btn2, btnGhost, cx, field, iconBtn, ItemTypeBadge, StatusIcon } from "./ui";
import "./delivery-board.css";

type CardMove = { item: WorkItem; from: Status; move: DeliveryMove; height?: number };
type CardDrag = { id: string; from: Status; height?: number };
type MoveInput = { value?: string; verifiers?: string[]; note?: string };

function moveTitle({ item, from, move }: CardMove) {
  switch (move.action) {
    case "status":
      if (move.to === "blocked") return "标记阻塞";
      if (move.to === "done") return "直接完成任务";
      if (from === "review") return "撤回验收";
      if (from === "done") return "重新打开";
      return `移至「${STATUS[move.to].label}」`;
    case "submit": return requiresProduction(item) ? "提交测试验收" : "提交验收";
    case "accept": return requiresProduction(item) ? "测试验收通过" : "验收通过";
    case "reject":
    case "rejectOnline": return "打回修改";
    case "publish": return "记录已发布";
    case "acceptOnline": return "线上验收通过";
    case "rollback": return "记录回滚";
  }
}

export default function DeliveryBoard({ cards }: { cards: WorkItem[] }) {
  const { items, acc, moveDeliveryCard } = useStore();
  const toast = useToast();
  const peek = usePeek();
  const [drag, setDrag] = useState<CardDrag | null>(null);
  const [hovered, setHovered] = useState<Status | null>(null);
  const [pending, setPending] = useState<CardMove | null>(null);
  const [saving, setSaving] = useState<CardMove | null>(null);
  const [arrival, setArrival] = useState<CardMove | null>(null);
  const savingRef = useRef(false);
  const groups = new Map<Status, WorkItem[]>();
  for (const item of cards) {
    const status = statusOf(items, item);
    const group = groups.get(status);
    if (group) group.push(item);
    else groups.set(status, [item]);
  }
  const dragged = drag && cards.find((item) => item.id === drag.id);
  const targets = drag && dragged && statusOf(items, dragged) === drag.from
    ? deliveryMoves(items, dragged, acc, drag.from) : [];
  const inFlight = saving ?? pending;
  const movingItem = dragged ?? inFlight?.item;
  const ranks = movingItem && new Map(cards.map((item, index) => [item.id, index]));
  const movingRank = movingItem ? ranks?.get(movingItem.id) : undefined;
  const landing = saving ?? arrival;

  useEffect(() => {
    if (!arrival) return;
    const timeout = window.setTimeout(() => setArrival(null), 300);
    return () => window.clearTimeout(timeout);
  }, [arrival]);

  function stopDrag() {
    setDrag(null);
    setHovered(null);
  }

  async function save(change: CardMove, input: MoveInput = {}) {
    const { item, from, move } = change;
    const command = deliveryCommand(item, from, move, input.value, input.verifiers, input.note);
    if (!command || savingRef.current) return { ok: false, reason: "状态已变化，请刷新后重试" };
    savingRef.current = true;
    setArrival(null);
    setSaving(change);
    try {
      const result = await moveDeliveryCard(command);
      if (result.ok) {
        setArrival(change);
        toast(`已移至「${statusLabel(move.to, item)}」`, item.title);
        setPending(null);
      }
      return result;
    } finally {
      savingRef.current = false;
      setSaving(null);
    }
  }

  function requestMove(change: CardMove) {
    if (savingRef.current) return;
    const { from, move } = change;
    const needsForm = move.action !== "status" || move.to === "blocked" || move.to === "done" || from === "review" || from === "done";
    if (needsForm) setPending(change);
    else void save(change);
  }

  function startDrag(event: DragEvent, item: WorkItem, from: Status) {
    if (savingRef.current) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.id);
    const card = event.currentTarget.closest("article");
    const bounds = card?.getBoundingClientRect();
    if (card && bounds) event.dataTransfer.setDragImage(card, event.clientX - bounds.left, event.clientY - bounds.top);
    setDrag({ id: item.id, from, height: bounds?.height });
  }

  return (
    <div className="min-w-0">
      <div aria-label="交付看板" className="grid grid-flow-col auto-cols-[minmax(9.75rem,1fr)] items-stretch gap-2 overflow-x-auto p-2.5 max-sm:auto-cols-[minmax(11rem,68%)]"
        onDragLeave={(event) => {
          if (!hovered) return;
          if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
          const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
          if (event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom) setHovered(null);
        }}
        onDragOver={(event) => {
          if (event.target === event.currentTarget && hovered) setHovered(null);
        }}>
        {deliveryColumns.filter((status) => status !== "cancelled" || groups.has(status)).map((status) => {
          const column = groups.get(status) ?? [];
          const move = targets.find((target) => target.to === status);
          const active = !!move && hovered === status;
          const containsMovingItem = movingItem && column.some((item) => item.id === movingItem.id);
          const reserved = inFlight?.move.to === status && !containsMovingItem;
          const showSlot = active || reserved;
          const slotBefore = ranks && movingRank !== undefined
            ? column.find((item) => (ranks.get(item.id) ?? Infinity) > movingRank)?.id : undefined;
          const dropSlot = movingItem && !containsMovingItem && (
            <div key="drop-slot" className="delivery-board-slot" data-visible={showSlot} aria-hidden="true">
              <div className="min-h-0 overflow-hidden">
                <div className="delivery-board-placeholder" style={{ minHeight: drag?.height ?? inFlight?.height }}>
                  <span className="line-clamp-2 wrap-anywhere font-medium">{movingItem.title}</span>
                  <span className="text-[11px]">{reserved ? (saving ? "正在保存…" : "待确认") : "松开移到此列"}</span>
                </div>
              </div>
            </div>
          );
          return (
            <section key={status} data-delivery-column={status} aria-label={STATUS[status].label}
              onDragOver={(event) => {
                if (!move) { if (hovered) setHovered(null); return; }
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (hovered !== status) setHovered(status);
              }}
              onDrop={(event) => {
                if (!drag || !dragged || !move || event.dataTransfer.getData("text/plain") !== dragged.id) return;
                event.preventDefault();
                stopDrag();
                requestMove({ item: dragged, from: drag.from, move, height: drag.height });
              }}
              className="delivery-board-column min-h-42 rounded-lg border border-transparent bg-canvas p-1.5"
              data-drop-state={showSlot ? "active" : move ? "available" : undefined}>
              <h3 className="mb-1.5 flex items-center gap-1.5 whitespace-nowrap px-1 py-1 text-xs font-medium text-fg">
                <StatusIcon s={status} />
                {STATUS[status].label}
                <span className="ml-auto tabular-nums text-fg-4">{column.length}</span>
              </h3>
              <div className="relative">
                {column.map((item) => {
                  const moves = deliveryMoves(items, item, acc, status);
                  const verifying = status === "review" || status === "production-review";
                  const names = verifying ? verifiersOf(items, item).map((id) => person(id).name).join("、") : assigneeNames(item);
                  const overdue = dueStateOf(items, item) === "overdue";
                  const blocked = status === "blocked" || (status === "doing" && hasBlocked(items, item));
                  const entering = landing?.item.id === item.id && landing.move.to === status;
                  return (
                    <Fragment key={item.id}>
                      {slotBefore === item.id && dropSlot}
                      <article data-delivery-card={item.id} className={cx(
                        "delivery-board-card group mb-1.5 rounded-md border border-line bg-surface px-2 py-1.5",
                        peek.id === item.id && "border-accent/60",
                      )} data-lifted={drag?.id === item.id || undefined}
                        data-arrival={entering ? (deliveryColumns.indexOf(landing.from) < deliveryColumns.indexOf(status) ? "forward" : "backward") : undefined}>
                        <div className="flex min-h-6 items-center justify-between gap-1">
                          <ItemTypeBadge items={items} item={item} />
                          {saving?.item.id === item.id ? <LoaderCircle aria-label="正在保存状态" className="size-3.5 motion-safe:animate-spin text-accent" /> : moves.length > 0 && (
                            <div className="flex shrink-0 items-center gap-0.5">
                              <span draggable aria-hidden="true" title="拖动修改状态" data-delivery-drag
                                onDragStart={(event) => startDrag(event, item, status)} onDragEnd={stopDrag}
                                className="flex size-5 cursor-grab items-center justify-center rounded text-fg-4 hover:bg-hover hover:text-fg active:cursor-grabbing [@media(pointer:coarse)]:hidden">
                                <GripVertical size={14} />
                              </span>
                              <Menu>
                                <MenuTrigger aria-label={`移动 ${item.title}`} className={cx(iconBtn, "size-6 shrink-0 [@media(pointer:coarse)]:size-9")}><Ellipsis /></MenuTrigger>
                                <MenuContent align="end">
                                  <MenuLabel>移动到</MenuLabel>
                                  {moves.map((target) => (
                                    <MenuItem key={target.to} icon={<StatusIcon s={target.to} />}
                                      onSelect={() => requestMove({ item, from: status, move: target })}>
                                      {statusLabel(target.to, item)}
                                    </MenuItem>
                                  ))}
                                </MenuContent>
                              </Menu>
                            </div>
                          )}
                        </div>
                        <Link href={`/item/${item.id}`} draggable={false} onClick={peek.onLinkClick(item.id)}
                          title={item.title} className="mt-0.5 line-clamp-2 wrap-anywhere rounded-sm text-[13px] font-medium leading-5 text-fg hover:text-accent-fg">
                          {item.title}
                        </Link>
                        <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[11px] leading-4 text-fg-3">
                          <span className="max-w-full truncate" title={names}>{verifying ? "验收人" : "执行人"} {names || "待指派"}</span>
                          <span className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums"><Clock3 aria-hidden size={11} />{fmt(item.due)}</span>
                        </div>
                        {(blocked || overdue || (status === "review" && requiresProduction(item))) && (
                          <div className="mt-1 flex flex-wrap gap-1 text-[11px] leading-4">
                            {blocked && <span className="rounded bg-danger-soft px-1 text-danger" title={item.blockedReason}>{status === "blocked" ? "阻塞" : "子任务阻塞"}</span>}
                            {overdue && <span className="rounded bg-warn-soft px-1 text-warn">逾期</span>}
                            {status === "review" && requiresProduction(item) && <span className="rounded bg-accent-soft px-1 text-accent-fg">待测试验收</span>}
                          </div>
                        )}
                      </article>
                    </Fragment>
                  );
                })}
                {!slotBefore && dropSlot}
                {column.length === 0 && <p className="delivery-board-empty absolute inset-x-0 top-0 py-3 text-center text-xs text-fg-4"
                  data-hidden={showSlot}>暂无工作项</p>}
              </div>
            </section>
          );
        })}
      </div>
      {pending && <DeliveryMoveDialog key={`${pending.item.id}-${pending.move.to}`} change={pending} busy={!!saving}
        onClose={() => setPending(null)} onSave={(input) => save(pending, input)} />}
    </div>
  );
}

function DeliveryMoveDialog({ change, busy, onClose, onSave }: {
  change: CardMove; busy: boolean; onClose: () => void;
  onSave: (input: MoveInput) => Promise<{ ok: boolean; reason?: string }>;
}) {
  const { items } = useStore();
  const { item, move } = change;
  const submitting = move.action === "submit";
  const inherited = verifiersOf(items, item).filter((id) => verifierAllowed(item, id));
  const [value, setValue] = useState(submitting ? item.deliverable ?? "" : "");
  const [note, setNote] = useState("");
  const [verifier, setVerifier] = useState("");
  const [error, setError] = useState("");
  const title = moveTitle(change);
  const missingCriteria = submitting && usesAcceptanceCriteria(item) && !hasAcceptanceCriteria(item);
  const label = submitting ? (requiresProduction(item) ? "测试环境链接或验收说明" : "交付物链接或说明")
    : move.action === "publish" ? "生产版本或发布链接"
    : move.action === "reject" || move.action === "rejectOnline" ? "打回原因"
    : move.action === "rollback" ? "回滚原因" : move.to === "blocked" ? "阻塞原因" : undefined;
  const confirmText = move.action === "publish" ? "确认已发布" : move.action === "rollback" ? "确认已回滚" : title;
  const canSubmit = !busy && !missingCriteria && (!label || !!value.trim()) && (!submitting || inherited.length > 0 || !!verifier);

  return (
    <Modal open title={title} desc={item.title} hideClose={busy} onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        setError("");
        void onSave({ value: value.trim(), verifiers: submitting && !inherited.length ? [verifier] : undefined, note: note.trim() })
          .then((result) => { if (!result.ok) setError(result.reason ?? "状态未保存，请重试"); });
      }}>
        <div className="space-y-3 px-5 pb-4 pt-3 text-[13px]">
          {label ? (
            <label className="block text-fg-3">{label}
              <input className={cx(field, "mt-1")} value={value} required maxLength={2000} disabled={busy} onChange={(event) => setValue(event.target.value)} />
            </label>
          ) : <p className="text-fg-3">确认后，工作项将移到「{statusLabel(move.to, item)}」。</p>}
          {submitting && (
            <>
              <label className="block text-fg-3">补充说明（选填）
                <textarea className={cx(field, "mt-1")} value={note} rows={2} maxLength={20000} disabled={busy} onChange={(event) => setNote(event.target.value)} />
              </label>
              {inherited.length > 0 ? <p className="text-fg-3">验收人 {inherited.map((id) => person(id).name).join("、")}</p> : (
                <PersonPicker title="选择验收人" value={verifier} onPick={setVerifier} requireProjectAccess>
                  <button type="button" className={btn2} disabled={busy}>{verifier ? person(verifier).name : "选择验收人"}</button>
                </PersonPicker>
              )}
              {missingCriteria && <p role="alert" className="text-danger">请先在需求详情填写验收标准。</p>}
            </>
          )}
          {error && <p role="alert" className="text-danger">{error}</p>}
        </div>
        <ModalFooter>
          <button type="button" className={btnGhost} disabled={busy} onClick={onClose}>取消</button>
          <button type="submit" className={btn} disabled={!canSubmit}>{busy ? "正在保存…" : confirmText}</button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
