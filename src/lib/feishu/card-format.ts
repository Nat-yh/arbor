export function progressDifference(actual: number, plan: number) {
  const gap = actual - plan;
  return gap === 0 ? "进度符合计划" : `较计划${gap > 0 ? "领先" : "落后"} ${Math.abs(gap)} 个百分点`;
}
