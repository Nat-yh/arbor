"use client";

import StateBoundary from "@/components/StateBoundary";

import { useState } from "react";
import { Card, NoAccess, PageHeader, People, cx } from "@/components/ui";
import { useStore } from "@/lib/store";
import { performanceRows, type PerfRow } from "@/lib/performance";
import { EvidenceDialog } from "@/components/EvidenceDialog";
import { performanceEvidence, type PerfMetric } from "@/lib/evidence";
import { person, today } from "@/lib/model";

type Col = { key: PerfMetric; label: string; unit?: string; good: "high" | "low"; group: string; tip: string };

const COLS: Col[] = [
  { key: "delivered", label: "已交付", good: "high", group: "交付效率", tip: "近 90 天作为负责人完成、具有完成日期的需求数" },
  { key: "cycleDays", label: "交付周期", unit: "天", good: "low", group: "交付效率", tip: "开始 → 完成天数中位数" },
  { key: "onTime", label: "按期率", unit: "%", good: "high", group: "交付效率", tip: "截止日期前（含当天）完成的需求占比" },
  { key: "firstPass", label: "一次通过", unit: "%", good: "high", group: "质量", tip: "已交付且有独立评审/验收记录的需求中，首次记录通过的占比" },
  { key: "escape", label: "缺陷逃逸", unit: "%", good: "low", group: "质量", tip: "上线后发现的缺陷占比" },
  { key: "rework", label: "返工率", unit: "%", good: "low", group: "质量", tip: "有独立评审/验收记录的已交付需求中，被打回或重开的占比" },
  { key: "riskReports", label: "主动报风险", good: "high", group: "主动性", tip: "近90天、截止前由本人标记阻塞的结构化记录数；旧记录不猜测" },
  { key: "verifierCount", label: "担任验证者", good: "high", group: "主动性", tip: "为他人评审 / 验收次数" },
  { key: "badCases", label: "Bad Case 贡献", good: "high", group: "主动性", tip: "近90天有登记日期的 Bad Case 数；旧记录缺日期时样本不足" },
];

export default function Performance() {
  return <StateBoundary><PerformanceContent /></StateBoundary>;
}

function PerformanceContent() {
  const { can, acc, me, items, people } = useStore();
  const [evidence, setEvidence] = useState<{ person: string; key: PerfMetric; label: string } | null>(null);
  const data = performanceRows(items, people, today());
  const [sortKey, setSortKey] = useState<keyof PerfRow>("delivered");
  const rows = data.filter((r) => acc.perf === "all" || r.person === me).sort((a, b) => {
    const c = COLS.find((x) => x.key === sortKey)!;
    if (a[sortKey] === null) return b[sortKey] === null ? 0 : 1;
    if (b[sortKey] === null) return -1;
    const d = (b[sortKey] as number) - (a[sortKey] as number);
    return c.good === "high" ? d : -d;
  });

  const best = (c: Col) => {
    const vals = rows.map((r) => r[c.key]).filter((v): v is number => typeof v === "number");
    return c.good === "high" ? Math.max(...vals) : Math.min(...vals);
  };

  if (!can("performance")) return <NoAccess text="你的账号没有开通「绩效看板」，请联系管理员。" />;

  return (
    <div className="mx-auto max-w-[1180px]">
      <PageHeader title="绩效看板" desc={acc.perf === "self" ? "近 90 天 · 你只能看到自己的数据" : "近 90 天 · 所有指标从流程数据自动计算，作为绩效面谈的客观依据，而非自动打分"} />

      {evidence && <EvidenceDialog title={`${person(evidence.person).name} · ${evidence.label}`} rows={performanceEvidence(items, evidence.person, evidence.key, today())} onClose={() => setEvidence(null)} />}
      <Card className="overflow-x-auto">
        <table className="w-full min-w-[940px] text-[13px]">
          <thead className="bg-canvas text-xs text-fg-4">
            <tr className="border-b border-line">
              <th rowSpan={2} className="px-4 py-2 text-left font-normal">成员</th>
              {["交付效率", "质量", "主动性"].map((g) => (
                <th key={g} colSpan={3} className="border-l border-line px-4 pt-2 text-center font-medium text-fg-2">{g}</th>
              ))}
            </tr>
            <tr className="border-b border-line">
              {COLS.map((c, i) => (
                <th key={c.key} className={cx("px-3 py-2 text-right font-normal", i % 3 === 0 && "border-l border-line")}>
                  <button title={c.tip} onClick={() => setSortKey(c.key)} className={cx("whitespace-nowrap hover:text-fg", sortKey === c.key && "font-medium text-fg")}>
                    {c.label}{sortKey === c.key && " ↓"}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.person} className="hover:bg-hover">
                <td className="whitespace-nowrap px-3 py-2">
                  <People ids={[r.person]} />
                  <div className="pl-7 text-xs text-fg-4">{person(r.person).title}</div>
                </td>
                {COLS.map((c, i) => {
                  const v = r[c.key];
                  return (
                    <td key={c.key} className={cx("px-3 py-2 text-right tabular-nums", i % 3 === 0 && "border-l border-line", v !== null && v === best(c) && "font-medium text-ok")}>
                      {v === null ? <span title="样本不足" aria-label="样本不足" className="text-fg-4">—</span> : <button className="rounded px-1 underline decoration-dotted underline-offset-4 hover:bg-active" aria-label={`${person(r.person).name}的${c.label}明细`} onClick={() => setEvidence({ person: r.person, key: c.key, label: c.label })}>{v}{c.unit === "%" ? "%" : ""}</button>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <div className="mt-3 flex flex-wrap gap-4 text-xs text-fg-4">
        <span>绿色为该列最佳 · 点击列名排序，悬停查看口径</span>
      </div>

      <details className="mt-5 border-t border-line pt-3 text-xs text-fg-4">
        <summary className="cursor-pointer hover:text-fg-2">口径说明与使用约定</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>指标是面谈依据，不直接换算成分数；任务难度不同，需结合具体项目看。</li>
          <li>不统计代码行数、AI 生成占比、Token 用量作为个人绩效。</li>
          <li>交付指标以近90天完成的需求为样本；质量指标仅在有对应记录时计算。没有有效样本时显示「—」（样本不足），不会显示成 0。</li>
          <li>数据来自当前可见项目的工作项、验证和缺陷记录，每次刷新重新计算。取消项及其下级不计入，归档保留历史。</li>
        </ul>
      </details>
    </div>
  );
}
