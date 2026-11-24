import type { WorkItem } from "./model";
import { dateOffset, daysBetween } from "./model";
import { independentCheck, type PerfRow } from "./performance";
import { isCancelled, statusOf } from "./tree";

export interface Evidence { id: string; itemId: string; defectId?: string; title: string; detail: string; date?: string }
export type PerfMetric = Exclude<keyof PerfRow, "person">;

/** 与绩效表相同的90天样本；比例列同时展示分母及每条样本是否计入分子。 */
export function performanceEvidence(items: WorkItem[], person: string, metric: PerfMetric, asOf: string): Evidence[] {
  const from = dateOffset(asOf, -89);
  const within = (date?: string) => !!date && date >= from && date <= asOf;
  const eligible = items.filter((x) => !isCancelled(items, x));
  const delivered = eligible.filter((x) => x.kind === "feature" && x.owner === person && statusOf(items, x) === "done" && within(x.doneAt));
  const row = (x: WorkItem, detail: string, suffix = "", date?: string): Evidence => ({ id: `${x.id}:${suffix}`, itemId: x.id, title: x.title, detail, date });
  if (["delivered", "cycleDays", "onTime"].includes(metric)) return delivered.filter((x) => metric !== "cycleDays" || x.start <= x.doneAt!).map((x) => row(x, `${x.start} → ${x.doneAt} · ${daysBetween(x.start, x.doneAt!)} 天 · 截止 ${x.due} · ${x.doneAt! <= x.due ? "按期" : "逾期"}`, "delivery", x.doneAt));
  if (metric === "firstPass" || metric === "rework") return delivered.flatMap((x) => {
    const checks = x.checks.filter((c) => independentCheck(x, c) && c.date <= x.doneAt!).sort((a, b) => a.date.localeCompare(b.date));
    if (!checks.length) return [];
    const rework = x.rework || checks.some((c) => c.result === "不通过") || x.log.some((l) => l.action === "reopen");
    return [row(x, `首次${checks[0].result} · ${rework ? "发生返工" : "无返工"}；${checks.map((c) => `${c.date} ${c.by} ${c.type}${c.result}${c.note ? `：${c.note}` : ""}`).join("；")}`, "reviews", x.doneAt)];
  });
  if (metric === "escape") return eligible.filter((x) => x.owner === person).flatMap((x) => x.defects.filter((d) => within(d.date)).map((d) => row(x, `${d.severity} ${d.title} · ${d.foundAt}发现 · ${d.foundAt === "线上" ? "计入逃逸" : "未逃逸"}`, d.id, d.date)));
  if (metric === "verifierCount") return eligible.flatMap((x) => x.checks.filter((c) => c.by === person && independentCheck(x, c) && within(c.date)).map((c) => row(x, `${c.by} ${c.type}${c.result} · ${c.note || "无补充说明"}`, c.id, c.date)));
  if (metric === "riskReports") return eligible.flatMap((x) => x.log.filter((l) => l.action === "blocked" && l.by === person && within(l.date) && l.date <= x.due).map((l, i) => row(x, l.text, `risk:${i}`, l.date)));
  return eligible.flatMap((x) => (x.eval?.badCases ?? []).filter((b) => b.by === person && within(b.date)).map((b) => row(x, `${b.input} · ${b.status}`, b.id, b.date)));
}

export function qualitySummary(items: WorkItem[]) {
  const eligible = items.filter((x) => !isCancelled(items, x));
  const defects = eligible.flatMap((x) => x.defects.map((d) => ({ ...d, x })));
  const checks = eligible.flatMap((x) => x.checks.map((c) => ({ ...c, x })));
  const reviewed = eligible.map((x) => ({ x, checks: x.checks.filter((c) => independentCheck(x, c)).sort((a, b) => a.date.localeCompare(b.date)) })).filter((r) => r.checks.length);
  const defectEvidence = (d: (typeof defects)[number]): Evidence => ({
    id: `${d.x.id}:${d.id}`, itemId: d.x.id, defectId: d.id, title: d.title,
    detail: `${d.severity} · ${d.x.title} · ${d.foundAt}发现`, date: d.date,
  });
  const evidence = {
    open: defects.filter((d) => d.status === "open").map(defectEvidence),
    escape: defects.map((d) => {
      const row = defectEvidence(d);
      return { ...row, detail: `${row.detail} · ${d.foundAt === "线上" ? "计入逃逸" : "未逃逸"}` };
    }),
    firstPass: reviewed.map(({ x, checks }) => ({ id: x.id, itemId: x.id, title: x.title, detail: `首次${checks[0].result}；${checks.map((c) => `${c.date} ${c.type}${c.result} ${c.note}`).join("；")}` })),
    failed: checks.filter((c) => c.result === "不通过").map((c) => ({ id: `${c.x.id}:${c.id}`, itemId: c.x.id, title: c.x.title, detail: `${c.type}不通过 · ${c.note}`, date: c.date })),
  };
  const percent = (yes: number, total: number) => total ? Math.round(yes * 100 / total) : null;
  return { defects, checks, evidence, open: evidence.open.length, escape: percent(defects.filter((d) => d.foundAt === "线上").length, defects.length), firstPass: percent(reviewed.filter((r) => r.checks[0].result === "通过").length, reviewed.length), failed: evidence.failed.length };
}
