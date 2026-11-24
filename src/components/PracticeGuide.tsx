"use client";

import { BookOpen, Check, ChevronDown, Crosshair, RotateCcw, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { PRACTICE, practiceTracks, type PracticeSession, type PracticeTrack } from "@/lib/practice";
import { useOptionalStore, useStore } from "@/lib/store";
import { btn, btn2, btnGhost, cx } from "./ui";

type Step = { title: string; instruction: string; why: string; target: string; done: boolean; actor?: string };
const controls = (...names: string[]) => names.map((name) => `[data-guide="${name}"]`).join(",");

function visibleTarget(selector: string) {
  const find = (root: ParentNode) => selector.split(",").flatMap((part) => Array.from(root.querySelectorAll<HTMLElement>(part))).find((el) => {
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && getComputedStyle(el).visibility === "visible" && !el.closest("[inert], [aria-hidden=true]");
  });
  const layers = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]'));
  const front = layers.findLast((el) => el.getClientRects().length > 0);
  return front ? find(front) : find(document);
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

function placeCoach(panel: HTMLElement, spotlight: HTMLElement, target: HTMLElement | undefined) {
  const viewport = window.visualViewport;
  const left = (viewport?.offsetLeft ?? 0) + 12;
  const right = (viewport ? viewport.offsetLeft + viewport.width : document.documentElement.clientWidth) - 12;
  const bottom = (viewport ? viewport.offsetTop + viewport.height : window.innerHeight) - 12;
  const banner = document.querySelector(".practice-banner")?.getBoundingClientRect();
  const top = Math.max((viewport?.offsetTop ?? 0) + 12, (banner?.bottom ?? 0) + 8);
  const width = Math.min(286, right - left);
  panel.style.width = `${width}px`;
  const bounds = target?.getBoundingClientRect();
  const visible = bounds && bounds.bottom > top && bounds.top < bottom && bounds.right > left - 12 && bounds.left < right + 12;
  spotlight.hidden = !visible;
  panel.style.visibility = "";
  panel.dataset.anchored = String(!!visible);
  if (!visible) {
    panel.style.left = `${right - width}px`;
    panel.style.top = `${top}px`;
    panel.style.maxHeight = `${Math.max(80, bottom - top)}px`;
    return;
  }

  const x1 = Math.max(bounds.left, left - 8);
  const x2 = Math.min(bounds.right, right + 8);
  const y1 = Math.max(bounds.top, top);
  const y2 = Math.min(bounds.bottom, bottom);
  Object.assign(spotlight.style, { left: `${x1 - 3}px`, top: `${y1 - 3}px`, width: `${x2 - x1 + 6}px`, height: `${y2 - y1 + 6}px` });
  const region = target?.closest("[data-guide-form]")?.getBoundingClientRect();
  const avoidLeft = Math.min(x1, region?.left ?? x1);
  const avoidRight = Math.max(x2, region?.right ?? x2);
  const avoidTop = Math.min(y1, region?.top ?? y1);
  const avoidBottom = Math.max(y2, region?.bottom ?? y2);
  const gap = 12;
  const centerX = (x1 + x2) / 2;
  const centerY = (y1 + y2) / 2;
  const footer = target?.closest(".item-next-step") ? undefined : document.querySelector(".item-peek .item-next-step.has-actions, main .item-next-step.has-actions");
  const footerTop = footer && getComputedStyle(footer).position === "fixed" ? footer.getBoundingClientRect().top : bottom;
  const usableBottom = footerTop > y2 + gap ? Math.min(bottom, footerTop - 4) : bottom;
  const candidates = [
    { side: "right", room: right - avoidRight - gap, maxHeight: usableBottom - top, x: avoidRight + gap },
    { side: "left", room: avoidLeft - left - gap, maxHeight: usableBottom - top, x: avoidLeft - gap - width },
    { side: "below", room: right - left, maxHeight: usableBottom - avoidBottom - gap, x: clamp(centerX - width / 2, left, right - width) },
    { side: "above", room: right - left, maxHeight: avoidTop - top - gap, x: clamp(centerX - width / 2, left, right - width) },
  ].filter((entry) => entry.room >= width - 1);
  const desired = Math.min(panel.scrollHeight + 2, Math.max(100, usableBottom - top));
  const placement = candidates.find((entry) => entry.maxHeight >= desired) ?? candidates.reduce((best, entry) => entry.maxHeight > best.maxHeight ? entry : best);
  const height = Math.max(0, placement.maxHeight);
  if (height < 72) {
    panel.style.visibility = "hidden";
    return;
  }
  panel.style.visibility = "";
  panel.style.maxHeight = `${height}px`;
  panel.style.left = `${placement.x}px`;
  const actualHeight = Math.min(desired, height);
  const y = placement.side === "below" ? avoidBottom + gap : placement.side === "above" ? avoidTop - gap - actualHeight : clamp(centerY - actualHeight / 2, top, usableBottom - actualHeight);
  panel.style.top = `${y}px`;
}

export function PracticeBanner() {
  const store = useOptionalStore();
  const router = useRouter();
  if (!store?.practice) return null;
  const exit = () => { const path = store.practice!.returnTo; store.endPractice(); router.replace(path); };
  return <div className="practice-banner sticky top-0 z-[45] flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 border-b border-accent/20 bg-accent-soft px-4 py-2 text-xs text-accent-fg">
    <span className="flex items-center gap-1.5 font-medium"><BookOpen size={14} />指南练习</span>
    <span className="flex-1">练习身份：{store.me === PRACTICE.learner ? "执行人 · 小夏" : "验证人 · 林悦"}<span className="hidden sm:inline"> · 操作不保存、不通知同事</span></span>
    <button onClick={exit} className="flex items-center gap-1 rounded px-1 py-0.5 hover:bg-accent/10">退出练习<X size={13} /></button>
  </div>;
}

export default function PracticeGuide() {
  const store = useOptionalStore();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const initialLocationChecked = useRef(false);
  useEffect(() => {
    if (!store || initialLocationChecked.current) return;
    initialLocationChecked.current = true;
    if (store.practice) return;
    if (path.startsWith("/item/practice-")) router.replace("/");
    else if (params.get("peek")?.startsWith("practice-")) {
      const next = new URLSearchParams(params.toString());
      next.delete("peek"); next.delete("submit"); next.delete("review");
      router.replace(`${path}${next.size ? `?${next}` : ""}`);
    }
  }, [store, path, params, router]);
  if (!store?.practice) return null;
  return <Coach key={store.practice.id} session={store.practice} />;
}

function Coach({ session }: { session: PracticeSession }) {
  const store = useStore();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [index, setIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [nextActor, setNextActor] = useState<string>();
  const [nextTrack, setNextTrack] = useState<PracticeTrack>();
  const coach = useRef<HTMLElement>(null);
  const spotlight = useRef<HTMLDivElement>(null);
  const switchActor = store.switchPracticeActor;
  const startPractice = store.startPractice;
  useEffect(() => {
    if (nextTrack && path === "/" && !params.get("peek")) {
      startPractice(nextTrack, session.returnTo, session.fullGuide);
    }
  }, [nextTrack, path, params, startPractice, session]);
  useEffect(() => {
    if (nextActor && path === "/" && !params.get("peek")) {
      switchActor(nextActor);
      setNextActor(undefined); // eslint-disable-line react-hooks/set-state-in-effect -- Switch identities only after returning to the queue.
    }
  }, [nextActor, path, params, switchActor]);
  const task = store.get(PRACTICE.task);
  const opened = (id?: string) => !!id && (path === `/item/${id}` || params.get("peek") === id);
  const taskLink = `[data-guide-item="${PRACTICE.task}"]`;
  const addFields = ["add-kind", "add-name", "add-confirm"];
  const submitFields = controls("deliverable", "verifier", "submit-confirm", "submit");
  const reviewTurn = (actor: string, instruction: string): Step => ({
    title: actor === PRACTICE.reviewer ? "换到验证人视角" : "看看执行人收到什么", instruction,
    why: "这里切换的是练习身份，不会切换你的登录账号。", target: store.me === actor ? taskLink : "", done: store.me === actor && opened(PRACTICE.task),
    actor: store.me === actor ? undefined : actor,
  });
  const created = store.items.find((x) => x.parentId === PRACTICE.project && x.kind === "task");
  const steps: Step[] = session.track === "create" ? [
    { title: "打开练习项目", instruction: "点「官网改版（练习）」，进入项目。", why: "任务要放在对应的项目或需求下面。", target: `[data-guide-project="${PRACTICE.project}"],main [href="/item/${PRACTICE.project}"]`, done: opened(PRACTICE.project) },
    { title: "创建一项任务", instruction: "点「添加第一项」，选择「任务」，填写名称并添加。", why: "检查执行人和截止日期，也可以自己修改。", target: controls(...addFields, "add-first", "add-under"), done: !!created },
    { title: "打开刚建的任务", instruction: "点击你刚填写的任务名称。", why: "这里会显示任务的负责人、执行人、截止日期和下一步。", target: created ? `[href="/item/${created.id}"]` : "", done: opened(created?.id) },
    { title: "拆成更小的工作", instruction: "点「拆成子任务」，填写一个子任务并添加。", why: "拆分后，上级进度会根据子任务的工作量自动汇总。", target: controls(...addFields, "split", "add-under"), done: !!created && store.items.some((x) => x.parentId === created.id) },
  ] : session.track === "review" ? [
    { title: "打开待验收任务", instruction: "在「等我验收」中，点「测试登录流程」。", why: "先看交付物是否满足任务里的验收要求。", target: taskLink, done: opened(PRACTICE.task) },
    { title: "写清需要修改的地方", instruction: "点「打回修改」，填写原因，再点「打回」。", why: "例如：错误密码的提示不够清楚，请补充具体说明。", target: controls("reject-reason", "reject-confirm", "reject"), done: !!task?.checks.some((c) => c.result === "不通过") },
    reviewTurn(PRACTICE.learner, store.me === PRACTICE.learner ? "打开被打回的「测试登录流程」，查看修改意见。" : "切换到执行人，看看任务如何返回给他。"),
    { title: "修改后重新提交", instruction: "点「提交验收」，补充修改说明并提交。", why: "原交付物会自动带入；有新的链接时可以替换。", target: controls("deliverable", "verifier", "revision-note", "submit-confirm", "submit"), done: !!task && task.status === "review" && (task.rework ?? 0) > 0 },
    reviewTurn(PRACTICE.reviewer, store.me === PRACTICE.reviewer ? "从「等我验收」重新打开这项任务。" : "切换到验证人，检查修改后的结果。"),
    { title: "确认结果并通过", instruction: "检查交付说明后，点「验收通过」。", why: "通过后任务显示「已完成」，验收记录保留在动态中。", target: controls("accept"), done: task?.status === "done" },
  ] : [
    { title: "找到分给你的任务", instruction: "在工作台点「测试登录流程」。", why: "工作台汇总需要你处理的事项，点击任务就能查看要求。", target: taskLink, done: opened(PRACTICE.task) },
    { title: "开始工作", instruction: "读完任务要求后，点「开始」。", why: "执行人负责推进工作；验证人负责检查交付结果。", target: controls("start"), done: !!task && task.status !== "todo" },
    { title: "发布一次进展", instruction: "点「更新进展」，写一句说明，选择 50% 后发布。", why: "例如：已测完正确密码登录，接下来检查错误密码提示。", target: controls("progress-note", "progress-preset", "publish-progress", "open-progress"), done: !!task?.updates.some((u) => u.progress !== undefined && u.progress > 0 && !u.text.startsWith("提交验收：")) },
    { title: "提交给验证人", instruction: "点「提交验收」，填交付说明或链接，确认林悦验收，再提交。", why: "提交后显示「待验收」。本次练习不会发送飞书通知。", target: submitFields, done: task?.status === "review" || task?.status === "done" },
    reviewTurn(PRACTICE.reviewer, store.me === PRACTICE.reviewer ? "在「等我验收」中打开刚提交的任务。" : "切换到验证人，看看他在哪里收到待办。"),
    { title: "完成验收", instruction: "检查交付结果后，点「验收通过」。", why: "进度 100% 代表执行进展；验收通过后才结束这次交付。", target: controls("accept"), done: task?.status === "done" },
  ];
  const step = steps[index];
  const done = !step;
  const chapter = practiceTracks.indexOf(session.track);
  const following = session.fullGuide ? practiceTracks[chapter + 1] : undefined;
  const nextTitle = following === "create" ? "创建并拆分任务" : "验收与打回";
  const complete = step?.done ?? false;
  const target = step?.target;

  useEffect(() => {
    if (complete) setIndex(index + 1); // eslint-disable-line react-hooks/set-state-in-effect -- Idempotent when React replays an effect after navigation.
  }, [complete, index]);

  useEffect(() => {
    document.documentElement.dataset.guidePractice = "true";
    return () => { delete document.documentElement.dataset.guidePractice; };
  }, []);

  useLayoutEffect(() => {
    const panel = coach.current;
    const ring = spotlight.current;
    if (!panel || !ring) return;
    let frame = 0;
    let anchor: HTMLElement | undefined;
    const resize = new ResizeObserver(schedule);
    resize.observe(panel);
    function update() {
      frame = 0;
      const current = target ? visibleTarget(target) : undefined;
      if (current !== anchor) {
        if (anchor) {
          resize.unobserve(anchor);
          anchor.removeAttribute("data-guide-highlight");
        }
        anchor = current;
        if (anchor) {
          resize.observe(anchor);
          anchor.setAttribute("data-guide-highlight", "true");
          const rect = anchor.getBoundingClientRect();
          const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          if (!hit || (!anchor.contains(hit) && !hit.closest(".practice-coach"))) anchor.scrollIntoView({ block: "center", inline: "nearest" });
        }
      }
      placeCoach(panel!, ring!, anchor);
      // Transforms move the target without triggering ResizeObserver.
      for (let node = anchor; node; node = node.parentElement ?? undefined) {
        if (node.getAnimations().some((animation) => animation.playState === "running" && animation.effect?.getComputedTiming().endTime !== Infinity)) {
          schedule();
          break;
        }
      }
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }
    update();
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-guide", "class", "aria-hidden"] });
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    document.addEventListener("animationstart", schedule, true);
    document.addEventListener("animationend", schedule, true);
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    return () => {
      cancelAnimationFrame(frame);
      anchor?.removeAttribute("data-guide-highlight");
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("animationstart", schedule, true);
      document.removeEventListener("animationend", schedule, true);
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, [target, index, path, params]);

  const exit = () => { store.endPractice(); router.replace(session.returnTo); };
  const goToTrack = (track: PracticeTrack) => { setNextTrack(track); router.replace("/"); };
  const restart = () => goToTrack(done && session.fullGuide ? "work" : session.track);
  const locate = () => {
    const el = target && visibleTarget(target);
    if (el) { el.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
    if (session.track === "create") router.replace(`/item/${index >= 2 && created ? created.id : PRACTICE.project}`);
    else router.replace(index === 0 || step?.actor ? "/" : `/item/${PRACTICE.task}`);
  };

  if (typeof document === "undefined") return null;
  return createPortal(<>
    <div ref={spotlight} hidden className="practice-spotlight" aria-hidden="true" />
    <aside ref={coach} aria-label="操作指南" className="practice-coach pointer-events-auto fixed z-[60] overflow-y-auto rounded-xl border border-accent/35 bg-surface shadow-pop">
    <div className="flex items-center gap-2 px-3 pb-2 pt-3 text-xs text-fg-3">
      <span className="flex-1">{session.fullGuide && `第 ${chapter + 1}/${practiceTracks.length} 段 · `}{done ? following ? "本段完成" : "练习完成" : `${index + 1} / ${steps.length}`}</span>
      <button onClick={restart} aria-label="重新练习" className="rounded p-1 hover:bg-hover"><RotateCcw size={13} /></button>
      <button onClick={() => setCollapsed((v) => !v)} aria-label={collapsed ? "展开指南" : "收起指南"} aria-expanded={!collapsed} className="rounded p-1 hover:bg-hover"><ChevronDown size={14} className={collapsed ? "rotate-180" : ""} /></button>
      <button onClick={exit} aria-label="退出练习" className="rounded p-1 hover:bg-hover"><X size={14} /></button>
    </div>
    <div className="px-3 pb-3">
      <div aria-live="polite" aria-atomic="true">
        <h2 className="text-[13px] font-semibold">{done ? <span className="flex items-center gap-1.5"><Check size={15} className="text-accent-fg" />{following ? "本段已完成" : session.fullGuide ? "完整指南已学完" : "这条流程已经练完"}</span> : step.title}</h2>
        {!collapsed && <p className="mt-2 text-[13px] leading-5 text-fg-2">{done ? following ? `接下来练习「${nextTitle}」。` : "退出后回到原来的工作区，本次练习记录会全部清除。" : step.instruction}</p>}
      </div>
      {!collapsed && <>
        {!done && <p className="mt-2 text-xs leading-5 text-fg-3">{step.why}</p>}
        {step?.actor && <button className={cx(btn, "mt-3 w-full")} onClick={() => { setNextActor(step.actor); router.replace("/"); }}>切换为{step.actor === PRACTICE.reviewer ? "验证人" : "执行人"}</button>}
        {done && following ? <button onClick={() => goToTrack(following)} className={cx(btn, "mt-3 w-full")}>继续：{nextTitle}</button> : done ? <button onClick={exit} className={cx(btn, "mt-3 w-full")}>结束练习</button> : !step.actor && <button onClick={locate} className={cx(btnGhost, "mt-2 -ml-1 text-xs")}><Crosshair size={13} />找到操作位置</button>}
        {done && !following && <button onClick={restart} className={cx(btn2, "mt-2 w-full")}>再练一次</button>}
        <p className="mt-2 border-t border-line pt-2 text-[11px] text-fg-4">仅供练习 · 刷新或退出即清除</p>
      </>}
    </div>
    </aside>
  </>, document.body);
}
