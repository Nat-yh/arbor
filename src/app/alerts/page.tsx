"use client";

import { SelectionMotion } from "@/components/SelectionMotion";
import StateBoundary from "@/components/StateBoundary";

import Link from "next/link";
import { useLayoutEffect, useRef, useState } from "react";
import MessagePreview from "@/components/MessagePreview";
import { AvatarStack, Badge, Card, Empty, LEVEL_CLS, NoAccess, PageHeader, StatusIcon, btn, btn2, btnGhost, sm, cx, field } from "@/components/ui";
import { describeQueueReason, myQueue } from "@/lib/queue";
import { computeAlerts, isScheduleId, ruleText, scheduleLabel, scheduleTime, SCHEDULE_MAX, SCHEDULE_MIN, validScheduleTime, type ScheduleId } from "@/lib/alerts";
import { ActionFeedback, LiquidButtonFace, useActionFeedback } from "@/components/ActionFeedback";
import { dateOffset, PEOPLE, today } from "@/lib/model";
import { dailyDigest, weeklyReport, type Report } from "@/lib/report";
import { handoffReport, type Handoff } from "@/lib/notifications/handoff";
import { useStore } from "@/lib/store";
import { Menu, MenuContent, MenuItem, MenuTrigger, Modal, Select } from "@/components/kit";
import { usePeek } from "@/components/Peek";
import { ChevronDown, ChevronRight, MessagesSquare } from "lucide-react";
import { projectOf, statusOf } from "@/lib/tree";

const alertTabs = ["今日提醒", "提醒规则", "飞书接入"] as const;
type Tab = (typeof alertTabs)[number];

const sampleOptions = [
  { value: "assign", label: "新指派" },
  { value: "review_requested", label: "待验收" },
  { value: "review_rejected", label: "验收打回" },
  { value: "release_requested", label: "待发布" },
  { value: "production_review_requested", label: "待线上验收" },
  { value: "escalation", label: "逾期升级" },
] as const;
type SampleKind = (typeof sampleOptions)[number]["value"];

function sampleCard(kind: SampleKind): Report {
  if (kind === "escalation") return {
    title: "逾期升级", to: "项目群", tone: "red", action: { label: "查看逾期事项" },
    sections: [{ heading: "逾期升级", variant: "handoff", lines: [{
      text: "补齐历史投放数据", context: "品牌投放看板", detail: "已逾期 2 天。请项目负责人确认交付日期或安排协助。",
    }] }],
  };
  const date = today();
  const change: Handoff = kind === "assign" ? { kind, roles: ["执行人"] } : { kind, cycle: "preview" };
  return handoffReport(change, {
    id: "preview", kind: "task", title: "核对渠道消耗口径", due: dateOffset(date, 1),
    ...(kind === "production_review_requested" ? { publication: { id: "preview", version: "v2.3.0", by: "preview", at: date } } : {}),
    checks: [{ id: "preview", type: "验收", by: "preview", result: "不通过", date, note: "两条退款记录仍计入消耗，请扣除后重新提交。" }],
  }, "品牌投放看板", kind === "review_requested" ? "周航" : "林悦", date, kind === "release_requested" ? "执行人（私聊）" : kind === "review_requested" || kind === "production_review_requested" ? "验收人（私聊）" : "当前执行人（私聊）");
}

export default function Alerts() {
  return <StateBoundary><AlertsContent /></StateBoundary>;
}

function AlertsContent() {
  const store = useStore();
  const peek = usePeek();
  const { items, alerts, rules, setRule, me, admin, projects, can } = store;
  const queue = myQueue(store, me);
  const [tab, setTab] = useState<Tab>("今日提醒");
  const [who, setWho] = useState("all");
  const [rule, setRuleF] = useState("all");
  const list = alerts.filter((a) => (who === "all" || a.to.includes(who)) && (rule === "all" || a.ruleId === rule));

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewKind, setPreviewKind] = useState<"digest" | "weekly" | "handoff">("digest");
  const [sample, setSample] = useState<SampleKind>("assign");
  const [reportOf, setReportOf] = useState(projects[0]?.id);
  const reportProject = projects.find((p) => p.id === reportOf) ?? projects[0];
  const daily = rules.find((rule) => rule.id === "daily");
  const weekly = rules.find((rule) => rule.id === "weekly");

  if (!can("alerts")) return <NoAccess text="你的账号没有开通「自动提醒」菜单，请联系管理员。" />;

  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader title="自动提醒" />
      <SelectionMotion value={tab} role="tablist" aria-label="自动提醒分类" className="selection-segment mb-5 flex w-fit bg-sunken p-0.5">
        {(admin ? alertTabs : alertTabs.filter((key) => key !== "飞书接入")).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} data-selection-value={key} onClick={() => setTab(key)}
            className={cx("flex h-7 shrink-0 items-center whitespace-nowrap px-2.5 text-xs transition-colors", tab === key ? "text-fg" : "text-fg-3 hover:text-fg")}>
            {key}
          </button>
        ))}
      </SelectionMotion>

      {tab === "今日提醒" && (
        <div className="space-y-4">
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
              <h2 className="text-sm font-semibold">待我处理 <span className="ml-1 text-xs font-normal tabular-nums text-fg-3">{queue.length}</span></h2>
              <button type="button" className={cx(btn2, sm)} onClick={() => setPreviewOpen(true)}><MessagesSquare aria-hidden="true" />预览飞书消息</button>
            </div>
            {queue.length ? (
              <ul className="divide-y divide-line">
                {queue.map(({ x, r, reasons }) => {
                  const hasPersonalBlock = reasons.some((reason) => reason.text === "阻塞中");
                  const hasPersonalOverdue = reasons.some((reason) => reason.text.startsWith("逾期 "));
                  const secondary = reasons.filter((reason) => reason !== r
                    && !(hasPersonalBlock && reason.text === "项目阻塞")
                    && !(hasPersonalOverdue && reason.text === "项目逾期"));
                  return (
                    <li key={x.id}>
                      <Link href={`/item/${x.id}`} onClick={peek.onLinkClick(x.id)} className="flex min-h-14 items-center gap-2.5 px-4 py-2.5 text-[13px] hover:bg-hover">
                        <StatusIcon s={statusOf(items, x)} />
                        <div className="min-w-0 flex-1">
                          <p className="break-words font-medium">{x.title}</p>
                          <p className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-fg-3">
                            <span>{projectOf(items, x).title}</span>
                            {secondary.map((reason) => <span key={reason.text} title={describeQueueReason(reason)}>{reason.text}</span>)}
                          </p>
                        </div>
                        <Badge className={cx("shrink-0", r.tone === "red" && "bg-danger-soft text-danger", r.tone === "amber" && "bg-warn-soft text-warn")}><span title={describeQueueReason(r)}>{r.text}</span></Badge>
                        <ChevronRight size={14} className="shrink-0 text-fg-4" aria-hidden="true" />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : <Empty>当前没有待处理事项</Empty>}
          </Card>
          <details className="group rounded-lg border border-line bg-surface">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-lg px-4 text-[13px] font-medium hover:bg-hover [&::-webkit-details-marker]:hidden">
              <ChevronRight size={15} className="text-fg-3 group-open:rotate-90" aria-hidden="true" />
              规则提醒明细
              <span className="text-xs font-normal text-fg-3">{alerts.length} 条</span>
            </summary>
            <div className="border-t border-line px-3 py-3">
              <div className="mb-3 flex flex-wrap gap-2">
                <Menu>
                  <MenuTrigger className={cx(btnGhost, sm, who !== "all" && "bg-accent-soft text-accent-fg hover:bg-accent-soft")}>
                    {who === "all" ? "全部接收人" : PEOPLE.find((p) => p.id === who)?.name}<ChevronDown />
                  </MenuTrigger>
                  <MenuContent><MenuItem checked={who === "all"} onSelect={() => setWho("all")}>全部接收人</MenuItem>{PEOPLE.map((p) => <MenuItem key={p.id} checked={who === p.id} onSelect={() => setWho(p.id)}>{p.name}</MenuItem>)}</MenuContent>
                </Menu>
                <Menu>
                  <MenuTrigger className={cx(btnGhost, sm, rule !== "all" && "bg-accent-soft text-accent-fg hover:bg-accent-soft")}>
                    {rule === "all" ? "全部规则" : rules.find((r) => r.id === rule)?.name}<ChevronDown />
                  </MenuTrigger>
                  <MenuContent><MenuItem checked={rule === "all"} onSelect={() => setRuleF("all")}>全部规则</MenuItem>{rules.filter((r) => r.kind === "event").map((r) => <MenuItem key={r.id} checked={rule === r.id} onSelect={() => setRuleF(r.id)}>{r.name}</MenuItem>)}</MenuContent>
                </Menu>
              </div>
              <Card>
                {list.length ? (
                  <ul className="divide-y divide-line">
                    {list.map((a) => {
                      const it = items.find((x) => x.id === a.itemId);
                      if (!it) return null;
                      return (
                        <li key={a.id} className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-2 text-[13px] hover:bg-hover">
                          <span className={cx("h-1.5 w-1.5 shrink-0 rounded-full", LEVEL_CLS[a.level])} />
                          <span className="text-xs text-fg-3">{a.ruleName}</span>
                          <Link href={`/item/${a.itemId}`} onClick={peek.onLinkClick(a.itemId)} className="max-w-52 truncate font-medium hover:underline">{it.title}</Link>
                          <span className="min-w-32 flex-1 text-xs text-fg-3">{a.text}</span>
                          <div className="ml-auto flex shrink-0 items-center gap-2">
                            <AvatarStack ids={a.to} /><Badge>{rules.find((r) => r.id === a.ruleId)?.delivery === "digest" ? "每日摘要" : "私聊"}</Badge>{a.group && <span title={a.group}><Badge>项目群</Badge></span>}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <Empty>没有符合条件的提醒</Empty>
                )}
              </Card>
            </div>
          </details>
          <Modal open={previewOpen} onOpenChange={setPreviewOpen} title="预览飞书消息">
            <div className="space-y-3 px-5 pb-5 pt-3">
              <SelectionMotion value={previewKind} className="selection-segment inline-flex bg-sunken p-0.5" role="group" aria-label="消息预览类型">
                {([["digest", "每日摘要"], ["weekly", "项目周报"], ["handoff", "交接与升级"]] as const).map(([kind, label]) => (
                  <button key={kind} type="button" data-selection-value={kind} aria-pressed={previewKind === kind} onClick={() => setPreviewKind(kind)}
                    className={cx("h-8 whitespace-nowrap px-3 text-[13px] font-medium", previewKind === kind ? "text-fg" : "text-fg-3 hover:text-fg")}>{label}</button>
                ))}
              </SelectionMotion>
              {previewKind === "digest" ? (
                <>
                  <p className="text-xs text-fg-3">{daily?.enabled && daily.channels.includes("飞书私聊") ? `${scheduleLabel("daily", daily.scheduleTime)} · 飞书私聊` : "未启用每日摘要推送"}</p>
                  <MessagePreview report={dailyDigest(store, me)} quiet />
                  <p className="text-xs text-fg-3">发送时会跳过当天已单独提醒的事项。</p>
                </>
              ) : previewKind === "handoff" ? (
                <>
                  <label className="block text-xs text-fg-3">
                    <span className="sr-only">选择卡片样例</span>
                    <Select value={sample} onValueChange={(value) => setSample(value as SampleKind)} options={[...sampleOptions]} />
                  </label>
                  <MessagePreview report={sampleCard(sample)} sample />
                </>
              ) : reportProject ? (
                <>
                  <label className="block text-xs text-fg-3">
                    <span className="sr-only">选择周报项目</span>
                    <Select value={reportProject.id} onValueChange={setReportOf}
                      options={projects.map((p) => ({ value: p.id, label: p.title }))} />
                  </label>
                  <p className="text-xs text-fg-3">{!weekly?.enabled || !weekly.channels.includes("飞书项目群") ? "未启用项目周报推送" : reportProject.feishuChatId ? scheduleLabel("weekly", weekly.scheduleTime) : "项目尚未绑定飞书群"}</p>
                  <MessagePreview report={weeklyReport(items, reportProject, computeAlerts(items, rules))} quiet />
                </>
              ) : <Empty>当前没有可预览周报的项目</Empty>}
            </div>
          </Modal>
        </div>
      )}

      {tab === "提醒规则" && (
        <Card>
          {!admin && <div className="border-b border-line bg-canvas px-4 py-2 text-xs text-fg-3">规则对所有人公开，只有管理员可以修改</div>}
          {admin && <div className="border-b border-line bg-canvas px-4 py-2 text-xs text-fg-3">定时提醒按系统时区 {store.timezone} 发送，每 5 分钟检查一次。可设在 {SCHEDULE_MIN}–{SCHEDULE_MAX}。</div>}
          <ul className="divide-y divide-line">
            {rules.map((r) => {
              const n = alerts.filter((a) => a.ruleId === r.id).length;
              return (
                <li key={r.id} className={cx("flex flex-wrap items-center gap-3 px-3 py-2.5", !r.enabled && "opacity-50")}>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-1">
                    <div className="flex w-44 shrink-0 flex-wrap items-center gap-2 text-[13px] font-medium">
                      {r.name}
                      {r.kind === "schedule" && isScheduleId(r.id) && <Badge>{scheduleLabel(r.id, r.scheduleTime)}</Badge>}
                      {r.kind === "event" && r.enabled && <span className="text-xs font-normal text-fg-4">今日触发 {n} 条</span>}
                    </div>
                    <div className="min-w-48 flex-1 text-xs text-fg-3">{ruleText(r)}<div className="mt-0.5 text-[11px] text-fg-4">接收人：{r.to} · 渠道：{r.delivery === "digest" ? "每日摘要" : r.channels.join("、")}</div></div>
                  </div>
                  {admin && r.kind === "schedule" && isScheduleId(r.id) && (
                    <ScheduleEditor key={scheduleTime(r.id, r.scheduleTime)} id={r.id} name={r.name} saved={scheduleTime(r.id, r.scheduleTime)} />
                  )}
                  {r.n !== undefined && !admin && <span className="text-xs text-fg-3">阈值 {r.n} {r.unit}</span>}
                  {r.n !== undefined && admin && (
                    <label className="flex items-center gap-1.5 text-sm text-fg-2">
                      阈值
                      <input type="number" disabled={!admin} min={0} value={r.n} onChange={(e) => setRule(r.id, { n: Number(e.target.value) })} className={cx(field, "w-16! py-1")} />
                      {r.unit}
                    </label>
                  )}
                  {admin ? <Switch label={r.name} checked={r.enabled} onChange={(enabled) => { void setRule(r.id, { enabled }); }} /> : <Badge>{r.enabled ? "已启用" : "已停用"}</Badge>}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {tab === "飞书接入" && admin && (
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="p-4">
            <h3 className="text-sm font-semibold">项目 ↔ 飞书群</h3>
            <p className="mt-1 text-xs text-fg-3">逾期升级和项目周报发到绑定的群。任务交接和需要个人处理的事项走私聊。</p>
            <ul className="mt-3 divide-y divide-line text-sm">
              {projects.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-2">
                  <span>{p.title}</span>
                  <span className="text-fg-3">{p.feishuGroup ?? <span className="text-fg">未绑定</span>}</span>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="p-4 text-sm">
            <h3 className="font-semibold">接入方式</h3>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-fg-2">
              <li>在飞书开放平台创建企业自建应用，开通机器人能力和「发送消息」权限，并把使用者加入可用范围。</li>
              <li>成员用飞书登录 Arbor 后自动绑定，之后才能收到私聊提醒。</li>
              <li>把机器人拉进项目群，在项目设置里填写群的 chat_id（oc_ 开头）。</li>
              <li>消息卡片带链接，点开直接进入对应的工作项处理。</li>
            </ol>
            <h3 className="mt-4 font-semibold">防打扰</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-fg-2">
              <li>免打扰时段：20:00 – 次日 09:00，周末只发紧急提醒。</li>
              <li>同一事项有交接或升级时，合并卡片并从当日摘要去重。</li>
              <li>到期、无进展和计划冲突随每日待办摘要发送。</li>
            </ul>
            <p className="mt-3 text-xs text-fg-4">发送状态和记录在「系统设置 → 飞书接入」查看；未配置应用凭证时只记录、不实际发送。</p>
          </Card>
        </div>
      )}
    </div>
  );
}

function ScheduleEditor({ id, name, saved }: { id: ScheduleId; name: string; saved: string }) {
  const { setRule } = useStore();
  const [time, setTime] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const valid = validScheduleTime(time);
  async function save() {
    if (busy || !valid || time === saved) return;
    setBusy(true);
    setError("");
    try {
      const result = await setRule(id, { scheduleTime: time }, () => acknowledge());
      if (!result.ok) setError(result.reason ?? "保存失败，请重试");
    } finally {
      clearFeedback();
      setBusy(false);
    }
  }
  return (
    <form className="flex flex-wrap items-center gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <input type="time" required min={SCHEDULE_MIN} max={SCHEDULE_MAX} step={60} aria-label={`${name}发送时间`} value={time} disabled={busy}
        onChange={(event) => { setTime(event.target.value); setError(""); }} className={cx(field, "h-8 w-28! py-1 tabular-nums")} />
      <button type="submit" aria-label={`保存${name}发送时间`} className={cx(btn, sm, "liquid-button min-w-16")} disabled={!valid || busy || time === saved} aria-busy={busy && !confirmed}>
        <LiquidButtonFace>保存</LiquidButtonFace>
        {confirmed && <ActionFeedback message="已保存" />}
      </button>
      {error && <span role="alert" className="w-full text-xs text-danger">{error}</span>}
    </form>
  );
}

function Switch({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  const thumb = useRef<HTMLSpanElement>(null);
  const previous = useRef(checked);
  useLayoutEffect(() => {
    if (previous.current === checked) return;
    previous.current = checked;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = thumb.current?.animate([
      { transform: "scale(1)" },
      { transform: "scale(1.32, .88)", offset: .45 },
      { transform: "scale(1)" },
    ], { duration: 150, easing: "ease-in-out" });
    return () => animation?.cancel();
  }, [checked]);

  return (
    <button type="button" role="switch" aria-label={label} aria-checked={checked} onClick={() => onChange(!checked)}
      className={cx("relative h-5 w-9 shrink-0 rounded-full transition-colors", checked ? "bg-accent" : "bg-line-strong")}>
      <span aria-hidden="true" className={cx("absolute left-0.5 top-0.5 h-4 w-4 transition-transform duration-150 motion-reduce:transition-none", checked && "translate-x-4")}>
        <span ref={thumb} className="block size-full rounded-full bg-white" />
      </span>
    </button>
  );
}
