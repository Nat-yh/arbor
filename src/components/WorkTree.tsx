"use client";

import Link from "next/link";
import * as Popover from "@radix-ui/react-popover";
import { ArrowDown, ArrowUp, CalendarRange, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Columns3, GanttChart, GripVertical, List, ListFilter, Pencil, Plus, ShieldCheck, UserRound } from "lucide-react";
import { Fragment, useEffect, useEffectEvent, useMemo, useRef, useState, type PointerEvent } from "react";
import { SelectionMotion } from "./SelectionMotion";
import { ActionFeedback, LiquidButtonFace, useActionFeedback } from "./ActionFeedback";
import { DraftScreenshots, useScreenshotDraft } from "./DraftScreenshots";
import DeliveryBoard from "./DeliveryBoard";
import WorkItemForm from "./WorkItemForm";
import { useToast } from "./Toast";
import { canAddChild, canEditPlan, canManage } from "@/lib/access";
import { isAssignee, dateOffset, daysBetween, fmt, person, STATUS, statusLabel, today, type WorkItem } from "@/lib/model";
import { useStore } from "@/lib/store";
import { canReparentTask, verifiersOf, isInactive, needsSubmission, childrenOf, currentIteration, currentWorkGroup, dueStateOf, isCheckDone, hasBlocked, iterationIdOf, levelLabel, plannedProgress, progressOf, projectOf, statusOf, visibleChecks, type CurrentWorkGroup, type Items } from "@/lib/tree";
import { IterationCell } from "./Iterations";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger, Modal, ModalFooter, Tip } from "./kit";
import { usePeek } from "./Peek";
import { AssigneeAvatars, DatePicker, DueCell, PersonCell, PersonPicker, StatusCell } from "./pickers";
import { AiBadge, Avatar, Badge, btn, btnGhost, cx, Empty, iconBtn, ItemTypeBadge, Progress, relDue, sm, StatusIcon } from "./ui";

interface Row {
  item: WorkItem;
  depth: number;
  hasKids: boolean;
}

type Placement = "before" | "after" | "inside";
type DropSpot = { targetId: string; placement: Placement; toParentId?: string };
type DragSource = { id: string; fromParentId: string };
type Move = DragSource & DropSpot;
type DragGesture = DragSource & {
  pointerId: number;
  scroller: Element;
  startX: number;
  startY: number;
  x: number;
  y: number;
  dirty: boolean;
  layout: DragLayout | null;
  preview: {
    element: HTMLDivElement;
    width: number;
    height: number;
    grabX: number;
    grabY: number;
  } | null;
  spot: DropSpot | null;
};
type DragRow = { id: string; element: HTMLElement; top: number; height: number };
type DragLayout = {
  rows: Row[];
  byId: Map<string, DragRow>;
  gaps: number[];
  hits: DragRow[];
  branch: Set<string>;
  offsets: Map<DragRow, number>;
  transfer: HTMLElement | null;
};
const rowSelector = ":scope > [data-work-item-row]";

type Filter = "all" | "open" | "overdue" | "blocked" | "review" | "release";
type TreeFilters = { filter: Filter; mineOnly: boolean; iter: string };
const defaultFilters: TreeFilters = { filter: "all", mineOnly: false, iter: "all" };
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "open", label: "未完成" },
  { key: "overdue", label: "已逾期" },
  { key: "blocked", label: "阻塞" },
  { key: "review", label: "待验收" },
  { key: "release", label: "待发布" },
];
const CURRENT_WORK_GROUPS: Record<CurrentWorkGroup, string> = {
  ongoing: "进行中的迭代",
  unplanned: "未排迭代",
  followUp: "待跟进",
  planned: "未开始的迭代",
};

function flatten(items: Items, parentId: string, depth: number): Row[] {
  return childrenOf(items, parentId).flatMap((item) => {
    const hasKids = childrenOf(items, item.id).length > 0;
    const row = { item, depth, hasKids };
    return hasKids ? [row, ...flatten(items, item.id, depth + 1)] : [row];
  });
}

function branchEnd(rows: Row[], start: number) {
  let end = start + 1;
  while (end < rows.length && rows[end].depth > rows[start].depth) end++;
  return end;
}

function groupCurrentRows(rows: Row[], scope: Map<string, CurrentWorkGroup>) {
  const groups: Record<CurrentWorkGroup, Row[]> = { ongoing: [], unplanned: [], followUp: [], planned: [] };
  const groupByRow = new Map<string, CurrentWorkGroup>();

  for (let start = 0; start < rows.length;) {
    const end = branchEnd(rows, start);
    const branch = rows.slice(start, end);
    // 跨迭代的子任务保留原上级，仅按整棵分支分组。
    const group = branch.map(({ item }) => scope.get(item.id)).find((value) => value !== undefined);
    if (group) {
      for (const row of branch) {
        groups[group].push(row);
        groupByRow.set(row.item.id, group);
      }
    }
    start = end;
  }

  return { rows: Object.values(groups).flat(), groupByRow };
}

function orderAtDrop(rows: Row[], sourceId: string | null, spot: DropSpot | null) {
  if (!sourceId || !spot || spot.placement === "inside") return undefined;
  const start = rows.findIndex(({ item }) => item.id === sourceId);
  const target = rows.findIndex(({ item }) => item.id === spot.targetId);
  if (start < 0 || target < 0 || (spot.toParentId ?? rows[start].item.parentId) !== rows[target].item.parentId) return undefined;
  const end = branchEnd(rows, start);
  const insertAt = spot.placement === "before" ? target : branchEnd(rows, target);
  const ordered = rows.slice();
  const branch = ordered.splice(start, end - start);
  ordered.splice(insertAt > start ? insertAt - branch.length : insertAt, 0, ...branch);
  return ordered;
}

function measureDragLayout(grid: HTMLElement, rows: Row[], sourceId: string): DragLayout {
  const hits = Array.from(grid.querySelectorAll<HTMLElement>(rowSelector), (element) => ({
    id: element.dataset.workItemRow!,
    element,
    top: element.offsetTop,
    height: element.offsetHeight,
  }));
  const byId = new Map(hits.map((row) => [row.id, row]));
  const gaps = hits.map((row, index) => index === 0 ? row.top : row.top - (hits[index - 1].top + hits[index - 1].height));
  const start = rows.findIndex(({ item }) => item.id === sourceId);
  const branch = new Set(start < 0 ? [] : rows.slice(start, branchEnd(rows, start)).map(({ item }) => item.id));
  for (const id of branch) byId.get(id)?.element.setAttribute("data-drag-placeholder", "");
  return { rows, byId, gaps, hits, branch, offsets: new Map(), transfer: null };
}

function showDropSpot(drag: DragGesture, spot: DropSpot | null, previewOrder: boolean) {
  const layout = drag.layout;
  if (!layout) return;
  const destinationId = spot?.placement === "inside" ? spot.targetId : spot?.toParentId;
  const transfer = destinationId ? layout.byId.get(destinationId)?.element ?? null : null;
  if (layout.transfer !== transfer) {
    layout.transfer?.removeAttribute("data-transfer-target");
    transfer?.setAttribute("data-transfer-target", "");
    layout.transfer = transfer;
  }

  const order = previewOrder ? orderAtDrop(layout.rows, drag.id, spot) : undefined;
  const offsets = new Map<DragRow, number>();
  let top = 0;
  layout.hits = (order ?? layout.rows).flatMap(({ item }, index) => {
    const row = layout.byId.get(item.id);
    if (!row) return [];
    top += layout.gaps[index];
    const projectedTop = order ? top : row.top;
    const offset = projectedTop - row.top;
    if (offset) offsets.set(row, offset);
    top += row.height;
    return [{ ...row, top: projectedTop }];
  });
  for (const [row, offset] of layout.offsets) {
    if (offsets.get(row) === offset) continue;
    row.element.style.setProperty("--drag-offset", `${offsets.get(row) ?? 0}px`);
  }
  for (const [row, offset] of offsets) {
    if (layout.offsets.has(row)) continue;
    row.element.setAttribute("data-drag-shift", "");
    row.element.style.setProperty("--drag-offset", `${offset}px`);
  }
  // Keep zero offsets so a row can finish sliding back before the drag ends.
  for (const row of layout.offsets.keys()) if (!offsets.has(row)) offsets.set(row, 0);
  layout.offsets = offsets;
}

function clearDragPreview(drag: DragGesture | null) {
  drag?.preview?.element.remove();
  const layout = drag?.layout;
  if (!layout) return;
  layout.transfer?.removeAttribute("data-transfer-target");
  for (const id of layout.branch) layout.byId.get(id)?.element.removeAttribute("data-drag-placeholder");
  for (const row of layout.offsets.keys()) {
    row.element.removeAttribute("data-drag-shift");
    row.element.style.removeProperty("--drag-offset");
  }
}

function scrollContainer(node: HTMLElement) {
  for (let parent = node.parentElement; parent; parent = parent.parentElement) {
    if (parent.scrollHeight > parent.clientHeight && /auto|scroll/.test(getComputedStyle(parent).overflowY)) return parent;
  }
  return document.scrollingElement ?? document.documentElement;
}

function positionDragPreview(drag: DragGesture) {
  const preview = drag.preview;
  if (!preview) return;
  const x = Math.max(0, Math.min(drag.x - preview.grabX, window.innerWidth - preview.width));
  const y = Math.max(0, Math.min(drag.y - preview.grabY, window.innerHeight - preview.height));
  preview.element.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

function liftRow(row: HTMLElement, drag: DragGesture) {
  const rect = row.getBoundingClientRect();
  // Copy the rendered row so the floating preview uses the same columns and layout.
  const copy = row.cloneNode(true) as HTMLElement;
  copy.removeAttribute("data-work-item-row");
  copy.removeAttribute("id");
  copy.style.removeProperty("order");
  for (const element of copy.querySelectorAll("[id]")) element.removeAttribute("id");

  const element = document.createElement("div");
  element.className = "@container pointer-events-none fixed left-0 top-0 z-[70] overflow-hidden rounded-lg bg-surface shadow-pop ring-1 ring-line-strong will-change-transform [&_.work-tree-sort-handle]:opacity-100";
  element.dataset.dragPreview = "";
  element.setAttribute("aria-hidden", "true");
  element.inert = true;
  element.style.width = `${rect.width}px`;
  element.append(copy);
  drag.preview = {
    element,
    width: rect.width,
    height: rect.height,
    grabX: drag.startX - rect.left,
    grabY: drag.startY - rect.top,
  };
  positionDragPreview(drag);
  document.body.append(element);
}

const COLS = "work-tree-columns grid items-center gap-x-3";
const WORK_VIEWS = [
  { id: "list", label: "列表", icon: List },
  { id: "timeline", label: "时间线", icon: GanttChart },
  { id: "board", label: "交付看板", icon: Columns3 },
] as const;

export default function WorkTree({ rootId, startAdding = false }: { rootId: string; startAdding?: boolean }) {
  const { items, me, acc, practice, moveItem } = useStore();
  const toast = useToast();
  const dragGesture = useRef<DragGesture | null>(null);
  const suppressSortClick = useRef(false);
  const treeGrid = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [pendingSort, setPendingSort] = useState<Move | null>(null);
  const [confirmation, setConfirmation] = useState<Move | null>(null);
  const [moveError, setMoveError] = useState("");
  const [moving, setMoving] = useState(false);
  const peek = usePeek();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [view, setView] = useState<(typeof WORK_VIEWS)[number]["id"]>("list");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(startAdding ? rootId : null);
  const [filterCollapsed, setFilterCollapsed] = useState<Set<string>>(new Set());
  const root = items.find((i) => i.id === rootId)!;
  const project = projectOf(items, root);
  const all = useMemo(() => flatten(items, rootId, 0), [items, rootId]);
  const iterations = [...(project.iterations ?? [])].sort((a, b) => a.start.localeCompare(b.start));
  const canShowCurrentWork = root.kind === "project" && iterations.length > 0 && !isInactive(items, root);
  const defaultIter = canShowCurrentWork ? "current" : "all";
  const isMine = (item: WorkItem) => item.owner === me || isAssignee(item, me);
  const [{ filter, mineOnly, iter }, setFilters] = useState<TreeFilters>(() => ({
    ...defaultFilters,
    iter: defaultIter,
    mineOnly: !practice && root.kind === "project" && !canManage(items, root, acc) &&
      (isAssignee(root, me) || all.some(({ item }) => isMine(item))),
  }));
  const currentWork = canShowCurrentWork && iter === "current";
  const specificIteration = iter !== "all" && iter !== "current";
  const selectedIteration = iterations.find((i) => i.id === iter);
  const addToIteration = selectedIteration?.closedAt ? undefined : selectedIteration?.id;
  const iterLabel = currentWork ? "当前工作" : iter === "none" ? "待规划" : selectedIteration?.name;
  const asOf = today();
  const current = currentIteration(project, asOf);
  const iterationChoices = [
    ...iterations.filter((i) => !i.closedAt && i.id !== current?.id),
    ...iterations.filter((i) => i.closedAt).reverse(),
  ];
  const currentScope = new Map<string, CurrentWorkGroup>();
  if (currentWork) {
    for (const { item } of all) {
      const group = currentWorkGroup(items, item, asOf);
      if (group) currentScope.set(item.id, group);
    }
  }

  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items]);
  const match = (i: WorkItem) => {
    if (mineOnly && !isMine(i)) return false;
    if (currentWork && !currentScope.has(i.id)) return false;
    if (specificIteration && (iterationIdOf(items, i) ?? "none") !== iter) return false;
    if (filter === "all") return true;
    const st = statusOf(items, i);
    if (filter === "open") return st !== "done" && st !== "cancelled";
    if (filter === "overdue") return dueStateOf(items, i) === "overdue";
    if (filter === "blocked") return st === "blocked";
    if (filter === "release") return st === "release";
    if (filter === "review") return st === "review" || st === "production-review";
    return true;
  };
  const filtering = mineOnly || filter !== "all" || specificIteration;
  const canReset = filtering || iter !== defaultIter;
  const changeFilters = (patch: Partial<TreeFilters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setFilterCollapsed(new Set());
  };
  // 从末级向上保留命中项的整条路径，筛选期间单独记录展开状态。
  let candidates = all;
  if (currentWork || filtering) {
    const keep = new Set<string>();
    for (const { item } of all.toReversed()) {
      if (!keep.has(item.id) && !match(item)) continue;
      keep.add(item.id);
      if (item.parentId) keep.add(item.parentId);
    }
    candidates = all.filter(({ item }) => keep.has(item.id));
  }
  const grouped = currentWork ? groupCurrentRows(candidates, currentScope) : undefined;
  if (grouped) candidates = grouped.rows;
  const expandable = new Set(candidates.flatMap(({ item }) => item.parentId && item.parentId !== rootId ? [item.parentId] : []));
  const folded = filtering ? filterCollapsed : collapsed;
  const setFolded = filtering ? setFilterCollapsed : setCollapsed;
  const shown = new Set([rootId]);
  const rows = candidates.filter(({ item }) => {
    if (!item.parentId || !shown.has(item.parentId) || folded.has(item.parentId)) return false;
    shown.add(item.id);
    return true;
  });
  const sameGroup = (a: string, b: string) => grouped?.groupByRow.get(a) === grouped?.groupByRow.get(b);
  const emptyMessage = filtering ? "没有符合筛选条件的项" : currentWork && all.length ? "暂无当前工作" : "还没有拆分内容";

  const toggle = (id: string) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const editing = editingId ? items.find((item) => item.id === editingId) : undefined;
  const showChecks = rows.some(({ item }) => visibleChecks(items, item).length > 0);
  // 与服务端 addItem 的 doer 规则一致：上级的执行人或可管理者才能在其下添加
  const canAddUnder = (x: WorkItem) => levelLabel(items, x) !== "子任务" && !isInactive(items, x) && canAddChild(items, x, acc);

  const orderEnabled = !practice && canManage(items, project, acc) && !isInactive(items, root);
  const columns = cx(COLS, iterations.length > 0 && "with-iteration", "px-3", orderEnabled && "pl-10");
  const sorting = orderEnabled && !filtering && !adding && !editing && !moving && !confirmation;
  const pendingOrder = pendingSort ? orderAtDrop(rows, pendingSort.id, pendingSort) : undefined;
  const orderPreview = pendingOrder && new Map(pendingOrder.map(({ item }, index) => [item.id, index + 1]));

  useEffect(() => () => clearDragPreview(dragGesture.current), []);

  const stopDrag = () => {
    clearDragPreview(dragGesture.current);
    dragGesture.current = null;
    setDragging(null);
  };

  const spotAt = (drag: DragGesture, gridBounds: DOMRect, clip: DOMRect | null): DropSpot | null => {
    const layout = drag.layout;
    if (!sorting || !layout) return null;

    // The cached layout bounds stay stable while rows animate.
    const { left, right, top } = gridBounds;
    if (drag.x < left || drag.x >= right || drag.y < Math.max(0, clip?.top ?? 0) ||
        drag.y >= Math.min(window.innerHeight, clip?.bottom ?? window.innerHeight)) return null;
    const y = drag.y - top;
    const hit = layout.hits.find(({ top, height }) => y >= top && y < top + height);
    const target = hit && itemById.get(hit.id);
    if (!hit || !target) return null;
    // The placeholder keeps the last insertion point while it is under the pointer.
    if (layout.branch.has(target.id)) {
      return drag.spot?.placement === "inside" ? null : drag.spot;
    }
    const item = itemById.get(drag.id);
    if (!item || item.parentId !== drag.fromParentId || isInactive(items, target)) return null;
    const ratio = (y - hit.top) / hit.height;
    if (ratio >= 0.28 && ratio <= 0.72 && canReparentTask(items, item, target)) {
      return { targetId: target.id, placement: "inside" };
    }
    const placement = ratio < 0.5 ? "before" : "after";
    if (target.parentId === drag.fromParentId) return sameGroup(drag.id, target.id) ? { targetId: target.id, placement } : null;

    const destination = target.parentId ? itemById.get(target.parentId) : undefined;
    return destination && canReparentTask(items, item, destination)
      ? { targetId: target.id, placement, toParentId: destination.id }
      : null;
  };

  const updateDropSpot = useEffectEvent((drag: DragGesture, gridBounds: DOMRect, clip: DOMRect | null) => {
    const spot = spotAt(drag, gridBounds, clip);
    if (drag.spot?.targetId === spot?.targetId && drag.spot?.placement === spot?.placement &&
        drag.spot?.toParentId === spot?.toParentId) return;
    drag.spot = spot;
    showDropSpot(drag, spot, spot !== null && sameGroup(drag.id, spot.targetId));
  });

  useEffect(() => {
    const grid = treeGrid.current;
    const scroller = dragGesture.current?.scroller;
    if (!dragging || !grid || !scroller) return;
    const pageScroll = scroller === document.scrollingElement;
    const edge = 54;
    let frame = 0;

    const updateFrame = () => {
      const drag = dragGesture.current;
      if (!drag) return;
      frame = window.requestAnimationFrame(updateFrame);

      const clip = pageScroll ? null : scroller.getBoundingClientRect();
      const top = Math.max(0, clip?.top ?? 0);
      const bottom = Math.min(window.innerHeight, clip?.bottom ?? window.innerHeight);
      const distance = drag.y < top + edge ? drag.y - top - edge : Math.max(0, drag.y - bottom + edge);
      if (!drag.dirty && !distance) return;

      let gridBounds = grid.getBoundingClientRect();
      if (distance && drag.x >= gridBounds.left && drag.x < gridBounds.right) {
        const previous = scroller.scrollTop;
        scroller.scrollTop += Math.sign(distance) * Math.min(16, Math.ceil(Math.abs(distance) / 4));
        if (scroller.scrollTop !== previous) {
          gridBounds = grid.getBoundingClientRect();
          drag.dirty = true;
        }
      }
      if (!drag.dirty) return;
      drag.dirty = false;
      updateDropSpot(drag, gridBounds, clip);
    };

    function onScroll() {
      const drag = dragGesture.current;
      if (drag) drag.dirty = true;
    }

    function onEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      stopDrag();
    }

    frame = window.requestAnimationFrame(updateFrame);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("keydown", onEscape, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("keydown", onEscape, true);
    };
  }, [dragging]);

  const startPointer = (event: PointerEvent<HTMLButtonElement>, source: DragSource) => {
    suppressSortClick.current = false;
    const grid = treeGrid.current;
    if (!grid || event.button !== 0 || event.pointerType === "touch" || !event.isPrimary) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragGesture.current = {
      ...source, pointerId: event.pointerId, scroller: scrollContainer(grid), startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, dirty: false, layout: null, preview: null, spot: null,
    };
  };

  const movePointer = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragGesture.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (!drag.preview) {
      if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 4) return;
      const row = event.currentTarget.closest<HTMLElement>("[data-work-item-row]");
      const grid = treeGrid.current;
      if (!row || !grid) return;
      liftRow(row, drag);
      drag.layout = measureDragLayout(grid, rows, drag.id);
      suppressSortClick.current = true;
      setDragging(drag.id);
    }
    positionDragPreview(drag);
    drag.dirty = true;
  };

  const endPointer = (event: PointerEvent<HTMLButtonElement>) => {
    const drag = dragGesture.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const grid = treeGrid.current;
    let spot = drag.preview ? drag.spot : null;
    if (drag.preview && grid && (drag.dirty || drag.x !== event.clientX || drag.y !== event.clientY)) {
      drag.x = event.clientX;
      drag.y = event.clientY;
      const clip = drag.scroller === document.scrollingElement ? null : drag.scroller.getBoundingClientRect();
      spot = spotAt(drag, grid.getBoundingClientRect(), clip);
    }
    stopDrag();
    if (!spot) return;
    const move = { id: drag.id, fromParentId: drag.fromParentId, ...spot };
    if (spot.placement === "inside" || spot.toParentId) { setMoveError(""); setConfirmation(move); }
    else void saveMove(move);
  };

  const cancelPointer = (event: PointerEvent<HTMLButtonElement>) => {
    if (dragGesture.current?.pointerId === event.pointerId) stopDrag();
  };

  const saveMove = async (move: Move) => {
    setMoving(true);
    setMoveError("");
    const confirmed = move.placement === "inside" || Boolean(move.toParentId);
    if (!confirmed) setPendingSort(move);
    try {
      const result = await moveItem(confirmed ? { ...move, confirmed: true } : move);
      if (!result.ok) {
        if (confirmed) setMoveError(result.reason ?? "任务未能转移，请重试。");
        return;
      }
      if (confirmed) {
        setCollapsed((previous) => {
          const next = new Set(previous);
          next.delete(move.toParentId ?? move.targetId);
          return next;
        });
        setConfirmation(null);
      }
      toast(confirmed ? "任务已转移" : "顺序已保存");
    } finally {
      setPendingSort(null);
      setMoving(false);
    }
  };
  const movingItem = confirmation && items.find((i) => i.id === confirmation.id);
  const oldParent = confirmation && items.find((i) => i.id === confirmation.fromParentId);
  const newParent = confirmation && itemById.get(confirmation.toParentId ?? confirmation.targetId);
  const destinationStatus = newParent ? statusOf(items, newParent) : undefined;
  const transferAnchor = confirmation?.toParentId ? itemById.get(confirmation.targetId) : undefined;

  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <SelectionMotion value={view} className="selection-segment flex rounded-md bg-sunken p-0.5" role="group" aria-label="任务视图">
          {WORK_VIEWS.map(({ id: v, label, icon: Icon }) => {
            return (
              <button key={v} aria-pressed={view === v} data-selection-value={v} onClick={() => setView(v)} className={cx("flex h-6 items-center gap-1 rounded px-2 text-xs transition-colors", view === v ? "text-fg" : "text-fg-3 hover:text-fg")}>
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            );
          })}
        </SelectionMotion>
        <Menu>
          <MenuTrigger className={cx(btnGhost, sm, filter !== "all" && "bg-accent-soft text-accent-fg hover:bg-accent-soft")}>
            <ListFilter />{filter === "all" ? "筛选" : FILTERS.find((f) => f.key === filter)!.label}
          </MenuTrigger>
          <MenuContent>
            <MenuLabel>按状态</MenuLabel>
            {FILTERS.map((f) => <MenuItem key={f.key} checked={filter === f.key} onSelect={() => changeFilters({ filter: f.key })}>{f.label}</MenuItem>)}
            <MenuSeparator />
            <MenuItem checked={mineOnly} onSelect={() => changeFilters({ mineOnly: !mineOnly })} icon={<UserRound />}>只看与我相关</MenuItem>
          </MenuContent>
        </Menu>
        {iterations.length > 0 && (
          <Menu>
            <MenuTrigger className={cx(btnGhost, sm, iter !== "all" && "bg-accent-soft text-accent-fg hover:bg-accent-soft")}>
              <CalendarRange />{iterLabel ?? (canShowCurrentWork ? "全部任务" : "迭代")}
            </MenuTrigger>
            <MenuContent>
              {canShowCurrentWork && <MenuItem checked={currentWork} onSelect={() => changeFilters({ iter: "current" })}>当前工作</MenuItem>}
              <MenuItem checked={iter === "all"} onSelect={() => changeFilters({ iter: "all" })}>全部任务</MenuItem>
              <MenuItem checked={iter === "none"} onSelect={() => changeFilters({ iter: "none" })}>待规划</MenuItem>
              <MenuSeparator />
              <MenuLabel>按迭代</MenuLabel>
              {current && <MenuItem checked={iter === current.id} hint={current.start <= asOf ? "当前" : "未开始"} onSelect={() => changeFilters({ iter: current.id })}>{current.name}</MenuItem>}
              {iterationChoices.map((i) => <MenuItem key={i.id} checked={iter === i.id} hint={i.closedAt ? "已结束" : undefined} onSelect={() => changeFilters({ iter: i.id })}>{i.name}</MenuItem>)}
            </MenuContent>
          </Menu>
        )}
        <button type="button" aria-pressed={mineOnly} onClick={() => changeFilters({ mineOnly: !mineOnly })} className={cx(btnGhost, sm, mineOnly && "bg-accent-soft text-accent-fg hover:bg-accent-soft")}>
          <Avatar id={me} size={4} />我的
        </button>
        {canReset && <button type="button" onClick={() => changeFilters({ ...defaultFilters, iter: defaultIter })} className={cx(btnGhost, sm)}>清除筛选</button>}
        {view !== "board" && expandable.size > 0 && (
          <>
            <Tip content="全部展开"><button aria-label="全部展开" className={iconBtn} onClick={() => setFolded(new Set())}><ChevronsUpDown /></button></Tip>
            <Tip content="全部收起"><button aria-label="全部收起" className={iconBtn} onClick={() => setFolded(new Set(expandable))}><ChevronsDownUp /></button></Tip>
          </>
        )}
        {canAddUnder(root) && (
          <button data-guide="add-under" onClick={() => { setView("list"); setAdding(rootId); }} className={cx(btn, sm, "ml-auto")}>
            <Plus />添加{root.kind === "project" ? "需求 / 任务" : "子任务"}
          </button>
        )}
      </div>

      {view === "list" && orderEnabled && rows.length > 0 && (
        <p className="mb-2 text-xs text-fg-3" aria-live="polite">
          {moving ? "正在保存变更…" : filtering ? "清除筛选后可调整顺序" : "拖动左侧手柄排序。拖到另一组子任务旁可转移并指定位置。"}
        </p>
      )}
      {confirmation && (
        <Modal open title="转移任务" desc={movingItem?.title ?? "当前任务"} hideClose={moving}
          onOpenChange={(open) => { if (!open && !moving) setConfirmation(null); }}>
          <div className="space-y-3 px-5 pb-4 pt-3 text-sm">
            <dl className="grid grid-cols-[4rem_minmax(0,1fr)] gap-2">
              <dt className="text-fg-3">原归属</dt><dd className="break-words text-fg">{oldParent?.title ?? "已不存在"}</dd>
              <dt className="text-fg-3">新归属</dt><dd className="break-words font-medium text-fg">{newParent?.title ?? "已不存在"}</dd>
              {confirmation.toParentId && (
                <>
                  <dt className="text-fg-3">位置</dt>
                  <dd className="break-words text-fg">{transferAnchor ? `排在「${transferAnchor.title}」${confirmation.placement === "before" ? "前" : "后"}` : "目标任务已不存在"}</dd>
                </>
              )}
            </dl>
            {(destinationStatus === "review" || destinationStatus === "done") && (
              <p className="text-xs text-fg-3">新归属当前{STATUS[destinationStatus].label}，转移后状态会重新汇总。</p>
            )}
            {moveError && <p role="alert" className="text-xs text-danger">{moveError}</p>}
          </div>
          <ModalFooter>
            <button type="button" className={btnGhost} disabled={moving} onClick={() => setConfirmation(null)}>取消</button>
            <button type="button" className={btn} disabled={moving || !movingItem || !newParent || (!!confirmation.toParentId && !transferAnchor)} onClick={() => void saveMove(confirmation)}>{moving ? "正在保存…" : "确认转移"}</button>
          </ModalFooter>
        </Modal>
      )}
      {editing && <WorkItemForm key={editing.id} item={editing} onDone={() => setEditingId(null)} />}
      <div className="overflow-hidden rounded-lg border border-line">
        {view === "board" ? (
          <DeliveryBoard cards={all.map(({ item }) => item).filter(match)} />
        ) : view === "list" ? (
          <div ref={treeGrid} role="treegrid" aria-label="工作项" className="@container relative flex flex-col text-[13px]">
            <div className={cx(columns, "relative h-8 border-b border-line bg-canvas text-xs text-fg-4")}>
              {orderEnabled && <span className="absolute inset-y-0 left-2 flex w-7 items-center justify-center text-[11px]" title="拖动每行左侧手柄调整顺序">排序</span>}
              <span className="pl-6">名称 · {rows.length} 项</span>
              {iterations.length > 0 && <span className="pl-1.5">迭代</span>}
              <span className="hidden @3xl:block">执行人</span>
              <span className="hidden @3xl:block">截止</span>
              <span className="hidden @3xl:block">进度</span>
              <span className="hidden @3xl:block">{showChecks && "检查"}</span>
              <span />
            </div>
            {adding === rootId && <AddRow columns={columns} hasIteration={iterations.length > 0} parentId={rootId} depth={0} iteration={addToIteration} onClose={() => setAdding(null)} />}
            {rows.length === 0 && adding !== rootId && (
              <div className="px-4 py-12 text-center">
                <div className="text-[13px] text-fg-3">{emptyMessage}</div>
                {!filtering && all.length === 0 && canAddUnder(root) && (
                  <button data-guide="add-first" onClick={() => setAdding(rootId)} className={cx(btn, "mt-3")}><Plus />添加第一项</button>
                )}
              </div>
            )}
            {rows.map(({ item, depth, hasKids }, rowIndex) => {
              const st = statusOf(items, item);
              const cl = visibleChecks(items, item);
              const overdue = dueStateOf(items, item) === "overdue";
              const active = peek.id === item.id;
              const canToggle = expandable.has(item.id);
              const source = sorting && item.parentId && !isInactive(items, item) ? { id: item.id, fromParentId: item.parentId } : null;
              const siblings = source ? childrenOf(items, source.fromParentId) : [];
              const index = siblings.findIndex((i) => i.id === item.id);
              const canMoveBeside = (sibling: WorkItem) => shown.has(sibling.id) && sameGroup(item.id, sibling.id) && !isInactive(items, sibling);
              const previous = index > 0 ? siblings.slice(0, index).findLast(canMoveBeside) : undefined;
              const next = index >= 0 ? siblings.slice(index + 1).find(canMoveBeside) : undefined;
              const group = grouped?.groupByRow.get(item.id);
              return (
                <Fragment key={item.id}>
                  {group && (rowIndex === 0 || grouped?.groupByRow.get(rows[rowIndex - 1].item.id) !== group) && (
                    <div role="row" style={orderPreview ? { order: rowIndex + 1 } : undefined}
                      className="border-b border-line bg-canvas px-3 py-1.5 text-xs font-medium text-fg-3">
                      <span role="gridcell">{CURRENT_WORK_GROUPS[group]}</span>
                    </div>
                  )}
                  <div
                    role="row"
                    aria-selected={active}
                    onClick={() => peek.open(item.id)}
                    style={orderPreview ? { order: orderPreview.get(item.id) } : undefined}
                    data-work-item-row={item.id}
                    className={cx(columns, "work-tree-row group relative min-h-10 cursor-pointer border-b border-line py-1.5 transition-colors",
                      !orderPreview && "last:border-b-0",
                      active ? "bg-accent-soft/70" : "hover:bg-hover")}
                  >
                    {source && (
                      <div className="absolute left-2 top-1.5 flex w-7 justify-center max-md:top-3">
                        <Popover.Root>
                          <Popover.Trigger asChild>
                            <button type="button" aria-label={`调整「${item.title}」顺序`} title="拖动排序，点击可上下移"
                              className={cx(iconBtn, "work-tree-sort-handle size-7 cursor-grab select-none transition-opacity active:cursor-grabbing")}
                              onClick={(event) => {
                                event.stopPropagation();
                                if (suppressSortClick.current && event.detail !== 0) event.preventDefault();
                                suppressSortClick.current = false;
                              }}
                              onPointerDown={(event) => startPointer(event, source)}
                              onPointerMove={movePointer}
                              onPointerUp={endPointer}
                              onPointerCancel={cancelPointer}
                              onLostPointerCapture={cancelPointer}>
                              <GripVertical />
                            </button>
                          </Popover.Trigger>
                          <Popover.Portal>
                            <Popover.Content align="start" sideOffset={4} className="z-50 grid min-w-28 gap-0.5 rounded-lg border border-line bg-surface p-1 shadow-pop"
                              onClick={(event) => event.stopPropagation()}>
                              {([["before", previous, ArrowUp, "上移"], ["after", next, ArrowDown, "下移"]] as const).map(([placement, sibling, Icon, label]) => (
                                <Popover.Close asChild key={placement}>
                                  <button type="button" disabled={!sibling} className={cx(btnGhost, sm, "justify-start")}
                                    onClick={() => { if (sibling) void saveMove({ ...source, targetId: sibling.id, placement }); }}>
                                    <Icon />{label}
                                  </button>
                                </Popover.Close>
                              ))}
                            </Popover.Content>
                          </Popover.Portal>
                        </Popover.Root>
                      </div>
                    )}
                    <div className="work-tree-main flex min-w-0 items-center gap-1.5" style={{ paddingLeft: depth * 22, "--tree-indent": `${depth * 10}px` } as React.CSSProperties}>
                      <button
                        aria-label={folded.has(item.id) ? "展开" : "收起"}
                        aria-expanded={canToggle ? !folded.has(item.id) : undefined}
                        onClick={(e) => { e.stopPropagation(); if (canToggle) toggle(item.id); }}
                        className={cx("flex h-5 w-5 shrink-0 items-center justify-center rounded text-fg-4 transition-colors", canToggle ? "hover:bg-active hover:text-fg" : "invisible")}
                      >
                        {folded.has(item.id) ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </button>
                      <span className="hidden sm:inline-flex"><StatusCell item={item} label={false} /></span>
                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
                          <div className="flex min-w-[min(100%,11rem)] max-w-full items-start gap-1.5">
                            <ItemTypeBadge items={items} item={item} />
                            <Link href={`/item/${item.id}`} title={item.title} onClick={(e) => { e.stopPropagation(); peek.onLinkClick(item.id)(e); }} className={cx("line-clamp-2 min-w-0 wrap-anywhere leading-5", hasKids ? "font-medium text-fg" : "text-fg", st === "done" && !hasKids && "text-fg-3", st === "cancelled" && "text-fg-4 line-through")}>
                              {item.title}
                            </Link>
                          </div>
                          {item.ai && item.kind !== "project" && <AiBadge />}
                          {hasKids && hasBlocked(items, item) && <Badge className="bg-danger-soft text-danger">含阻塞</Badge>}
                          {st === "review" && !hasKids && <Badge className="bg-accent-soft text-accent-fg">{statusLabel(st, item)}</Badge>}
                          {needsSubmission(items, item) && <Badge className="bg-warn-soft text-warn">100% 未提交</Badge>}
                        </div>
                        {item.status === "blocked" && <div className="mt-0.5 truncate text-xs text-danger">{item.blockedReason}</div>}
                      </div>
                      <span className="mt-1.5 flex w-full flex-wrap items-center gap-2 pl-7 sm:ml-auto sm:mt-0 sm:w-auto sm:pl-2 @3xl:hidden">
                        <span className="inline-flex items-center gap-2 sm:hidden"><StatusCell item={item} /><PersonCell item={item} /></span><span className="hidden sm:inline-flex"><PersonCell item={item} compact /></span>
                        <span className={cx("text-xs", overdue ? "text-danger" : "text-fg-3")}>{st === "done" ? "" : relDue(item.due)}</span>
                      </span>
                    </div>
                    {iterations.length > 0 && <div className="work-tree-iteration min-w-0"><IterationCell item={item} compact showUnplanned={currentWork && group !== "unplanned"} /></div>}
                    <div className="hidden min-w-0 @3xl:block"><PersonCell item={item} /></div>
                    <div className="hidden @3xl:block"><DueCell item={item} /></div>
                    <div className="hidden @3xl:block"><Progress value={progressOf(items, item)} plan={hasKids ? plannedProgress(item) : undefined} width="w-12" /></div>
                    <div className="hidden text-xs tabular-nums text-fg-3 @3xl:block">{showChecks && cl.length ? `${cl.filter((c) => isCheckDone(items, item, c)).length}/${cl.length}` : ""}</div>
                    <div className="work-tree-actions grid w-max grid-cols-[1.5rem_1.75rem] items-center gap-0.5 justify-self-end max-md:ml-auto">
                      {canAddUnder(item) && (
                        <Tip content="在这一项下拆分子任务">
                          <button aria-label="拆分子任务" onClick={(e) => { e.stopPropagation(); setAdding(item.id); setFolded((s) => { const n = new Set(s); n.delete(item.id); return n; }); }} className={cx(iconBtn, "col-start-1 row-start-1 h-6 w-6 opacity-0 group-hover:opacity-100 focus-visible:opacity-100")}>
                            <Plus />
                          </button>
                        </Tip>
                      )}
                      {!isInactive(items, item) && canEditPlan(items, item, acc) && (
                        <button type="button" aria-label={`编辑 ${item.title}`} title="编辑" className={cx(iconBtn, "row-edit col-start-2 row-start-1")} onClick={(event) => { event.stopPropagation(); setEditingId(item.id); }}><Pencil /></button>
                      )}
                    </div>
                  </div>
                  {adding === item.id && <AddRow columns={columns} hasIteration={iterations.length > 0} parentId={item.id} depth={depth + 1} iteration={addToIteration} onClose={() => setAdding(null)} />}
                </Fragment>
              );
            })}
          </div>
        ) : (
          rows.length > 0 ? (
            <Timeline items={items} root={root} candidates={candidates} rows={rows}
              collapsed={folded} expandable={expandable} toggle={toggle} onOpen={peek.open} />
          ) : <Empty>{emptyMessage}</Empty>
        )}
      </div>
    </div>
  );
}

const chip = "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-fg-2 ring-1 ring-line-strong bg-surface transition-colors hover:bg-hover data-[state=open]:bg-active [&_svg]:h-3.5 [&_svg]:w-3.5";

/** 行内快速添加：标题 + 回车，执行人和截止用胶囊选，连续添加 */
function AddRow({ parentId, depth, iteration, columns, hasIteration, onClose }: {
  parentId: string;
  depth: number;
  iteration?: string;
  columns: string;
  hasIteration: boolean;
  onClose: () => void;
}) {
  const { addItem, items, me, acc, practice } = useStore();
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const parent = items.find((i) => i.id === parentId)!;
  const underProject = parent.kind === "project";
  const [title, setTitle] = useState("");
  // 拆子任务时默认交给上级的执行人；直接挂在项目下时默认自己
  const [assigned, setAssigned] = useState([!underProject && parent.assignee ? parent.assignee : me]);
  const assignee = assigned[0] ?? me;
  const [due, setDue] = useState(parent.due < today() ? today() : parent.due);
  const [kind, setKind] = useState<"feature" | "task">(underProject ? "feature" : "task");
  const owner = kind === "feature" ? assignee : me;
  const [selectedVerifiers, setSelectedVerifiers] = useState<string[]>();
  const [detailed, setDetailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const screenshots = useScreenshotDraft();
  const input = useRef<HTMLInputElement>(null);
  // 需求的验证人：优先沿用上级（项目）设置的验证人；没有可用的再退回项目负责人
  const inherited = verifiersOf(items, parent);
  const verifiers = selectedVerifiers ?? (kind === "feature" && !inherited.length ? [parent.owner] : undefined);
  const verifierIds = verifiers ?? inherited;
  const ownIteration = iteration && iterationIdOf(items, parent) !== iteration ? iteration : undefined;
  const missingAssignee = !assigned.length;
  const submit = async () => {
    if (!title.trim() || busy || missingAssignee) return;
    setBusy(true);
    try {
      // 在某个迭代的筛选下添加：直接归入该迭代（上级已属于该迭代时沿用即可）
      const id = await addItem({
        parentId, kind, title: title.trim(), owner,
        assignees: assigned, due, ...(verifiers ? { verifiers } : {}), ...(ownIteration ? { iteration: ownIteration } : {}),
      }, practice ? [] : screenshots.files);
      if (!id) return;
      await acknowledge();
      setTitle("");
      screenshots.clear();
      setSelectedVerifiers(undefined);
      input.current?.focus();
    } finally { clearFeedback(); setBusy(false); }
  };
  if (!canAddChild(items, parent, acc, kind)) return null;
  const names = assigned.map((id) => person(id).name).join("、");
  const personChip = <button type="button" disabled={busy} className={cx(chip, "min-w-0 max-w-full")} aria-label={`执行人：${names || "未分配"}`}>
    <AssigneeAvatars ids={assigned} /><span className="truncate" title={names}>{names || "选择执行人"}</span>
  </button>;
  return (
    <div className={cx(columns, "work-tree-add animate-fade-in border-b border-line bg-accent-soft/40 py-2")}
      onClick={(e) => e.stopPropagation()} onPaste={!practice && !busy ? screenshots.onPaste : undefined}>
      {detailed && (
        <WorkItemForm draft={{
          parentId, kind, title, assignee, assignees: assigned, owner,
          start: today(), due, verifiers: verifiers ?? [], iteration: ownIteration, screenshots: screenshots.files,
        }} onDone={(saved) => { if (saved) onClose(); else setDetailed(false); }} />
      )}
      <div className="work-tree-add-name flex min-w-0 flex-wrap items-center gap-2" style={{ "--add-indent": `${Math.min(depth, 4) * 22 + 24}px` } as React.CSSProperties}>
        <input
          ref={input}
          data-guide={title.trim() ? undefined : "add-name"}
          autoFocus
          aria-label={kind === "feature" ? "需求名称" : underProject ? "任务名称" : "子任务名称"}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void submit(); if (e.key === "Escape" && !busy) { e.stopPropagation(); onClose(); } }}
          placeholder={underProject ? (kind === "feature" ? "需求名称，回车添加" : "任务名称，回车添加") : "子任务名称，回车添加"}
          className="h-7 min-w-0 flex-[1_1_8rem] rounded-md border border-line-strong bg-surface px-2 text-[13px] outline-none placeholder:text-fg-4 focus-visible:border-focus"
        />
        {underProject && (
          <SelectionMotion value={kind} className="selection-segment flex shrink-0 bg-sunken p-0.5" role="group" aria-label="添加工作项类型">
            {(["feature", "task"] as const).map((k) => (
              <Tip key={k} content={k === "feature" ? "要验收的一块功能，下面再拆任务" : "一件具体的活，比如「UAT 测试」"}>
                <button type="button" data-selection-value={k} data-guide={k === "task" && kind !== k ? "add-kind" : undefined} aria-pressed={kind === k} disabled={busy} onClick={() => setKind(k)} className={cx("h-6 px-2 text-xs transition-[color]", kind === k ? "font-medium text-fg" : "font-medium text-fg-3 hover:text-fg")}>
                  {k === "feature" ? "需求" : "任务"}
                </button>
              </Tip>
            ))}
          </SelectionMotion>
        )}
      </div>
      {hasIteration && <span className="hidden @3xl:block" aria-hidden="true" />}
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-xs text-fg-3 @3xl:hidden">执行人</span>
        <PersonPicker multiple keepOpen requireProjectAccess value={assigned} onPick={setAssigned} title="指派执行人">{personChip}</PersonPicker>
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="shrink-0 text-xs text-fg-3 @3xl:hidden">截止</span>
        <DatePicker value={due} onPick={setDue}>
          <button type="button" disabled={busy} aria-label={`截止日期：${due}`} title={`截止 ${due}`} className={cx(chip, "whitespace-nowrap", due > parent.due && "text-warn ring-warn/40")}>{relDue(due)}</button>
        </DatePicker>
      </div>
      <div className="col-span-full flex w-full flex-wrap items-center gap-x-3 gap-y-1 border-t border-line pt-2">
        <div className="flex min-w-0 max-w-full items-center gap-1.5">
          <span className="shrink-0 text-xs text-fg-3">验证人</span>
          <PersonPicker multiple keepOpen minSelected={kind === "feature" || inherited.length ? 1 : 0}
            value={verifierIds} onPick={setSelectedVerifiers} title="选择验证人">
            <button type="button" disabled={busy} aria-label={verifierIds.length ? `验证人：${verifierIds.map((v) => person(v).name).join("、")}` : "选择验证人"} className={cx(chip, "min-w-0 max-w-44", !verifierIds.length && kind === "feature" && "text-warn ring-warn/40")}>
              <ShieldCheck className="shrink-0" aria-hidden="true" />
              <span className="truncate">{verifierIds.length ? verifierIds.map((v) => person(v).name).join("、") : "选择验证人"}</span>
            </button>
          </PersonPicker>
        </div>
        {!practice && <DraftScreenshots draft={screenshots} busy={busy} compact />}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          <button type="button" disabled={busy} onClick={onClose} className={cx(btnGhost, sm)}>取消</button>
          <button type="button" disabled={busy} onClick={() => setDetailed(true)} className={cx(btnGhost, sm)}>详细创建</button>
          <button type="button" data-action-feedback="local" data-guide="add-confirm" disabled={!title.trim() || busy || missingAssignee} onClick={() => void submit()} className={cx(btn, sm, "liquid-button min-w-18", confirmed && "disabled:opacity-100")} aria-busy={busy && !confirmed}><LiquidButtonFace>添加</LiquidButtonFace>{confirmed && <ActionFeedback message="已添加" />}</button>
        </div>
      </div>
      {missingAssignee && <div role="alert" className="col-span-full w-full text-xs text-danger">请至少选择一位执行人</div>}
      {due > parent.due && <div className="col-span-full w-full text-xs text-warn">截止晚于上级（{fmt(parent.due)}），会提醒负责人调整计划</div>}
    </div>
  );
}

function Timeline({ items, root, candidates, rows, collapsed, expandable, toggle, onOpen }: {
  items: Items; root: WorkItem; candidates: Row[]; rows: Row[]; collapsed: Set<string>; expandable: Set<string>;
  toggle: (id: string) => void; onOpen: (id: string) => void;
}) {
  // 折叠分组时保持刻度，筛选后按当前范围重算。
  const datesFrom = [...(root.kind === "project" ? [root] : []), ...candidates.map(({ item }) => item)];
  const start = datesFrom.map((item) => item.start).sort()[0];
  const end = datesFrom.map((item) => item.due).sort().at(-1)!;
  const span = Math.max(1, daysBetween(start, end) + 1);
  const pos = (date: string) => (daysBetween(start, date) / span) * 100;
  const middle = Math.floor(span / 2);
  const quarters = span >= 8 ? [Math.round(span / 4), Math.round(3 * span / 4)] : [];
  const ticks = [
    ...(span >= 3 ? [{ offset: middle, minor: false }] : []),
    ...quarters.map((offset) => ({ offset, minor: true })),
  ];
  const date = today();
  const showToday = date >= start && date <= end;
  const todayPosition = pos(date);
  const crossesYear = start.slice(0, 4) !== end.slice(0, 4);
  const axisLabel = (value: string) => crossesYear ? value.replaceAll("-", "/") : fmt(value);

  return (
    <>
      <div className="work-timeline @container text-[13px]">
        <div className={cx("flex border-b border-line bg-canvas text-xs text-fg-3", showToday ? "h-12" : "h-8")}>
          <div className="work-timeline-name flex items-center px-3">名称</div>
          <div className="relative min-w-0 flex-1 tabular-nums" role="group" aria-label="排期日期">
            <time dateTime={start} title={start} className="absolute top-2 left-0 whitespace-nowrap pl-1.5">{axisLabel(start)}</time>
            {span > 1 && <time dateTime={end} title={end} className="absolute top-2 right-0 whitespace-nowrap pr-1.5">{axisLabel(end)}</time>}
            {ticks.map(({ offset, minor }) => {
              const tick = dateOffset(start, offset);
              return (
                <time key={offset} dateTime={tick} title={tick} style={{ left: `${offset / span * 100}%` }}
                  className={cx("absolute top-2 -translate-x-1/2 whitespace-nowrap",
                    minor ? "hidden @2xl:block" : crossesYear && "hidden @lg:block")}>
                  {axisLabel(tick)}
                </time>
              );
            })}
            {showToday && (
              <span className="absolute bottom-1 -translate-x-1/2 whitespace-nowrap rounded bg-accent-soft px-1.5 text-[11px] font-medium text-accent-fg"
                style={{ left: `clamp(1.25rem, ${todayPosition}%, calc(100% - 1.25rem))` }} title={fmt(date)}>今天</span>
            )}
          </div>
        </div>
        <div className="relative">
          <div className="pointer-events-none absolute inset-y-0 right-0 left-(--timeline-name-width)" aria-hidden="true">
            {ticks.map(({ offset, minor }) => (
              <div key={offset} className={cx("absolute inset-y-0 w-px bg-line", minor ? "hidden @2xl:block" : crossesYear && "hidden @lg:block")}
                style={{ left: `${offset / span * 100}%` }} />
            ))}
            {showToday && <div className="absolute inset-y-0 z-10 w-px bg-accent/65" style={{ left: `${todayPosition}%` }} />}
          </div>
          {rows.map(({ item, depth, hasKids }) => {
            const st = statusOf(items, item);
            const p = progressOf(items, item);
            const overdue = dueStateOf(items, item) === "overdue";
            const left = pos(item.start);
            const width = Math.min(100 - left, Math.max(1.2, (daysBetween(item.start, item.due) + 1) / span * 100));
            return (
              <div key={item.id} onClick={() => onOpen(item.id)} className="work-timeline-row flex cursor-pointer items-center border-b border-line last:border-b-0 hover:bg-hover">
                <div className="work-timeline-name flex items-center gap-1 bg-surface py-1.5 pr-2 @sm:gap-1.5"
                  style={{ paddingInlineStart: `calc(.625rem + ${depth} * clamp(.4375rem, 1.5cqw, 1rem))` }}>
                  <button aria-label={collapsed.has(item.id) ? "展开" : "收起"} aria-expanded={expandable.has(item.id) ? !collapsed.has(item.id) : undefined} onClick={(e) => { e.stopPropagation(); if (expandable.has(item.id)) toggle(item.id); }} className={cx("w-4 shrink-0 text-fg-4", !expandable.has(item.id) && "invisible")}>{collapsed.has(item.id) ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}</button>
                  <StatusIcon s={st} />
                  <span className="sr-only shrink-0 @sm:not-sr-only"><ItemTypeBadge items={items} item={item} /></span>
                  <span title={item.title} className={cx("line-clamp-2 wrap-anywhere", hasKids && "font-medium")}>{item.title}</span>
                </div>
                <div className="relative h-8 min-w-0 flex-1">
                  <div
                    title={`${item.start} 至 ${item.due} · ${statusLabel(st, item)} · ${p}%`}
                    className={cx("absolute top-2 h-4 overflow-hidden rounded", hasKids ? "bg-line-strong" : "bg-sunken ring-1 ring-inset ring-line",
                      overdue && "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-2 after:ring-inset after:ring-danger/60")}
                    style={{ left: `${left}%`, width: `${width}%` }}
                  >
                    <div className={cx("h-full", STATUS[st].bar, hasKids && "opacity-80")} style={{ width: `${p}%` }} />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-2 border-t border-line px-4 py-2 text-xs text-fg-3">
        {(["doing", "review", "done", "blocked"] as const).map((s) => (
          <span key={s} className="flex items-center gap-1.5"><i className={cx("h-2 w-3 rounded-sm", STATUS[s].bar)} />{STATUS[s].label}</span>
        ))}
        <span className="flex items-center gap-1.5"><i className="h-2 w-3 rounded-sm ring-2 ring-inset ring-danger/60" />逾期</span>
        <span className="text-fg-4">条形填充 = 完成进度</span>
      </div>
    </>
  );
}
