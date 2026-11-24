import { isAssignee, dateOffset, daysBetween, type Person, type WorkItem } from "./model";
import { isCancelled, statusOf } from "./tree";

export interface PerfRow {
  person: string;
  delivered: number | null; cycleDays: number | null; onTime: number | null;
  firstPass: number | null; escape: number | null; rework: number | null;
  riskReports: number | null; verifierCount: number | null; badCases: number | null;
}
export const independentCheck = (x: WorkItem, c: WorkItem["checks"][number]) => !isAssignee(x, c.by) && ["代码评审", "业务验收", "验收", "UAT", "测试验收", "线上验收"].includes(c.type);
const rate = (yes: number, total: number) => total ? Math.round(100 * yes / total) : null;
const median = (values: number[]) => {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  return (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
};

/** 近90个公历日。交付/质量归需求负责人，验证贡献归实际验证人；归档保留历史，取消整棵子树排除。 */
export function performanceRows(items: WorkItem[], people: Person[], asOf: string): PerfRow[] {
  const from = dateOffset(asOf, -89);
  const within = (d?: string): d is string => !!d && d >= from && d <= asOf;
  const eligible = items.filter((x) => !isCancelled(items, x));
  return people.map((p) => {
    const delivered = eligible.filter((x) => x.kind === "feature" && x.owner === p.id && statusOf(items, x) === "done" && within(x.doneAt));
    const cycles = delivered.filter((x) => x.start && x.start <= x.doneAt!).map((x) => daysBetween(x.start, x.doneAt!));
    const reviewed = delivered.map((x) => ({ x, checks: x.checks.filter((c) => independentCheck(x, c) && c.date <= x.doneAt!).sort((a, b) => a.date.localeCompare(b.date)) })).filter((e) => e.checks.length);
    const defects = eligible.filter((x) => x.owner === p.id).flatMap((x) => x.defects).filter((d) => within(d.date));
    const verification = eligible.flatMap((x) => x.checks.filter((c) => c.by === p.id && independentCheck(x, c) && within(c.date)));
    const risks = eligible.flatMap((x) => x.log.filter((l) => l.action === "blocked" && l.by === p.id && within(l.date) && l.date <= x.due));
    const cases = eligible.flatMap((x) => (x.eval?.badCases ?? []).filter((b) => b.by === p.id && within(b.date)));
    return {
      person: p.id, delivered: delivered.length || null, cycleDays: median(cycles),
      onTime: rate(delivered.filter((x) => x.doneAt! <= x.due).length, delivered.length),
      firstPass: rate(reviewed.filter((e) => e.checks[0].result === "通过").length, reviewed.length),
      escape: rate(defects.filter((d) => d.foundAt === "线上").length, defects.length),
      rework: rate(reviewed.filter((e) => e.x.rework || e.checks.some((c) => c.result === "不通过") || e.x.log.some((l) => l.action === "reopen")).length, reviewed.length),
      riskReports: risks.length || null, verifierCount: verification.length || null, badCases: cases.length || null,
    };
  });
}
