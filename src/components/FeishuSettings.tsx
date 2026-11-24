"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Avatar, Badge, Card, btn, btn2, cx, sm } from "./ui";
import { ActionFeedback, LiquidButtonFace, useActionFeedback } from "./ActionFeedback";
import type { NotificationStatus } from "@/lib/notifications/admin";
import { usePracticeActive } from "@/lib/store";

const statuses = { pending: "等待发送", sent: "已发送", failed: "失败", dry_run: "演练", cancelled: "已取消" };
const types = { handoff: "交接提醒", mention: "动态提及", defect: "缺陷登记", event: "事件提醒", daily: "每日摘要", weekly: "项目周报", test: "测试", deployment: "部署通知" };
export default function FeishuSettings() {
  const practice = usePracticeActive();
  const [data, setData] = useState<NotificationStatus>();
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState(false);
  const { confirmed, acknowledge, clearFeedback } = useActionFeedback();
  const refresh = useCallback(async () => {
    if (practice) return;
    try {
      const res = await fetch("/api/admin/feishu", { cache: "no-store" });
      if (!res.headers.get("content-type")?.includes("application/json")) throw new Error("服务暂时不可用，请稍后刷新");
      const body = await res.json();
      if (!res.ok) throw new Error(body.reason ?? "读取飞书接入失败");
      setData(body); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "读取失败"); }
  }, [practice]);
  useEffect(() => {
    void refresh(); // eslint-disable-line react-hooks/set-state-in-effect -- 仅在异步请求完成后更新配置状态
  }, [refresh]);
  async function test() {
    if (practice || busy) return;
    setBusy(true); setFeedback("");
    try {
      const res = await fetch("/api/admin/feishu", { method: "POST" });
      if (!res.headers.get("content-type")?.includes("application/json")) throw new Error("服务暂时不可用，请稍后刷新");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? body.reason ?? "发送失败");
      setFeedback(body.status === "dry_run" ? "已记录演练消息，未调用飞书" : "测试消息已发送，请在飞书查看");
      await acknowledge("publish");
    } catch (e) { setFeedback(e instanceof Error ? e.message : "发送失败"); }
    finally { clearFeedback(); await refresh(); setBusy(false); }
  }
  return <section className="space-y-3">
    <div className="mb-2 flex items-center justify-between"><h2 className="text-xs font-medium text-fg-4">飞书接入</h2><button onClick={refresh} className={cx(btn2, sm)}>刷新记录</button></div>
    {error && <p role="alert" className="mb-2 text-[13px] text-danger">{error}</p>}
    {!data && !error && <div role="status" aria-label="正在读取飞书配置" className="space-y-3 motion-safe:animate-pulse">{["w-48", "w-full", "w-3/4"].map((w) => <div key={w} className={cx("h-3 rounded bg-sunken", w)} />)}</div>}
    {data && <Card className="divide-y divide-line px-4">
      <Section title="连接状态" desc="飞书应用、发送模式与调度配置。">
        <div className="flex flex-wrap items-center gap-2 text-[13px]"><Badge className={data.configured ? "bg-ok-soft text-ok" : "bg-sunken text-fg-3"}>应用{data.configured ? "已配置" : "未配置"}</Badge><Badge>{data.dryRun ? "演练（不发消息）" : "正式发送"}</Badge><Badge>调度器{data.schedulerEnabled ? "已启用" : "未启用"}</Badge><span className="text-xs text-fg-3">{data.timezone}</span></div>
        {!data.baseUrlConfigured && <p className="mt-2 text-xs text-danger">尚未配置 APP_BASE_URL，消息链接无法生成。</p>}
        <div className="mt-3"><button disabled={busy} onClick={test} className={cx(btn, sm, "liquid-button")} aria-busy={busy && !confirmed}>
          <LiquidButtonFace>给我发一条测试消息</LiquidButtonFace>
          {confirmed && <ActionFeedback variant="publish" message={data.dryRun ? "已记录" : "已发送"} />}
        </button>{feedback && <p role="status" className="mt-2 text-[13px] text-fg-2">{feedback}</p>}</div>
      </Section>
      <Section title="项目群绑定" desc="在项目详情中管理飞书群。"><ul className="divide-y divide-line">{data.projects.map((p) => <li key={p.id} className="flex flex-wrap justify-between gap-2 py-2 text-[13px] hover:bg-hover"><Link className="font-medium hover:underline" href={`/item/${p.id}`}>{p.title}</Link><span className="text-fg-3">{p.group || "未填写群名"} · {p.chatId || "未绑定 chat_id"}</span></li>)}</ul>{!data.projects.length && <p className="text-[13px] text-fg-4">暂无项目</p>}</Section>
      <Section title="账号飞书身份" desc="成员通过飞书登录后完成绑定。"><ul className="divide-y divide-line">{data.people.map((p) => <li key={p.id} className="flex min-h-10 flex-wrap items-center gap-2 py-2 text-[13px] hover:bg-hover"><Avatar id={p.id} size={5} /><span className="flex-1">{p.name}{!p.active && <span className="ml-2 text-xs text-fg-4">停用</span>}</span><Badge className={p.bound ? "bg-sunken text-fg-3" : "bg-warn-soft text-warn"}>{p.bound ? "已绑定" : "未绑定，请先飞书登录"}</Badge></li>)}</ul></Section>
      <Section title="发送记录" desc="最近 50 条发送记录。"><div className="overflow-x-auto"><table className="w-full min-w-[650px] text-left text-xs"><thead className="h-8 bg-canvas text-fg-4"><tr><th className="py-2">时间</th><th>类型 / 消息</th><th>接收人</th><th>状态</th><th>错误 / 尝试次数</th></tr></thead><tbody className="divide-y divide-line">{data.logs.map((r) => <tr key={r.id} className="hover:bg-hover"><td className="whitespace-nowrap py-2 pr-3">{new Date(r.createdAt).toLocaleString("zh-CN", { timeZone: data.timezone })}</td><td className="max-w-48 break-words pr-3" title={r.objectId}>{types[r.type]} · {r.title || r.objectId}</td><td className="max-w-48 break-all pr-3">{r.recipient.startsWith("account:") ? data.people.find((p) => p.id === r.recipient.slice(8))?.name ?? r.recipient : r.recipient}</td><td className="whitespace-nowrap pr-3">{statuses[r.status]}{r.mode === "dry_run" && r.status !== "dry_run" ? "（演练）" : ""}</td><td className="max-w-64 break-words">{r.error || "无错误"} · {r.attempts} 次</td></tr>)}</tbody></table>{!data.logs.length && <p className="py-3 text-[13px] text-fg-4">暂无发送记录</p>}</div></Section>
    </Card>}
  </section>;
}

function Section({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return <div className="grid gap-3 py-5 md:grid-cols-[220px_minmax(0,1fr)] md:gap-8"><div><h3 className="text-[13px] font-medium">{title}</h3><p className="mt-1 text-xs text-fg-3">{desc}</p></div><div className="min-w-0">{children}</div></div>;
}
