import { describe, expect, it } from "vitest";
import { computeAlerts } from "../src/lib/alerts";
import { applyCommand } from "../src/lib/commands";
import { demoState } from "../src/lib/demo";
import type { WorkItem } from "../src/lib/model";
import { planRiskNotices } from "../src/lib/notifications/plan";
import { myQueue } from "../src/lib/queue";
import { dailyDigest } from "../src/lib/report";

const date = "2026-11-23";
const actor = "zhouhang";

function fixture() {
  const state = demoState(date);
  const project = state.items.find((item) => item.id === "P1")!;
  project.iterations = [{ id: "CURRENT", name: "当前迭代", start: "2026-11-18", end: "2026-12-01" }];
  const template = state.items.find((item) => item.kind === "task")!;
  const sample = (id: string, fields: Partial<WorkItem>): WorkItem => ({
    ...template, id, title: id, parentId: project.id, owner: actor, assignee: actor, assignees: undefined,
    start: "2026-11-20", due: "2026-11-30", status: "todo", progress: 0, doneAt: undefined, iteration: "CURRENT",
    verifiers: [], checklist: [], updates: [], checks: [], defects: [], log: [], ...fields,
  });
  const stale = sample("停更样例", { status: "doing", progress: 30, updates: [
    { date: "2026-11-19", progress: 30, text: "已联调", by: actor },
    { date, text: "普通留言", by: actor },
    { date, progress: 40, text: "", by: actor, retractedAt: "2026-11-23T09:00:00Z" },
  ] });
  const split = sample("待拆样例", { kind: "feature", owner: actor, assignee: "xunuo" });
  const late = sample("开工样例", {});
  state.items = [project, stale, split, late];
  return { state, stale, split, late };
}

describe("工作台提醒", () => {
  it("区分末级停更、待拆解和晚于开工日，既进工作台也进同一份每日摘要", () => {
    const { state, stale, split, late } = fixture();
    const alerts = computeAlerts(state.items, state.rules, date);
    expect(alerts.filter(({ ruleId }) => ["stale", "split_needed", "start_late"].includes(ruleId))
      .map(({ itemId, to }) => [itemId, to])).toEqual([[stale.id, [actor]], [split.id, [actor]], [late.id, [actor]]]);
    expect(computeAlerts(state.items, state.rules, "2026-11-21").some((alert) => alert.ruleId === "start_late")).toBe(false);
    expect(myQueue(state, actor, date, alerts).flatMap(({ reasons }) => reasons.flatMap((r) => r.attention ?? [])))
      .toEqual(expect.arrayContaining(["stale", "start_late", "split_needed"]));
    const lines = dailyDigest(state, actor, date, new Set(), alerts).sections.flatMap(({ lines }) => lines);
    expect(lines.map(({ itemId }) => itemId).sort()).toEqual([stale.id, split.id, late.id].sort());
    expect(lines.find(({ itemId }) => itemId === stale.id)?.detail).toContain("上次更新 11/19");
    expect(planRiskNotices(state, new Date("2026-11-23T03:00:00Z"), alerts)
      .some((notice) => /^(stale|start_late|split_needed):/.test(notice.objectId))).toBe(false);
  });

  it("约定更新日期前暂停提醒，到期恢复，保存真实进展后清除约定", () => {
    const { state, stale } = fixture();
    const ctx = { today: date, accountId: actor, newId: "DEFERRED" };
    const deferred = applyCommand(state, ctx, { type: "deferProgress", id: stale.id, until: "2026-11-25" }).state;
    const matches = (asOf: string) => computeAlerts(deferred.items, deferred.rules, asOf).some((a) => a.itemId === stale.id && a.ruleId === "stale");
    expect(matches("2026-11-24")).toBe(false);
    expect(matches("2026-11-25")).toBe(true);
    expect(() => applyCommand(state, { ...ctx, accountId: "xunuo" }, { type: "deferProgress", id: stale.id, until: "2026-11-25" })).toThrow("执行人");
    const updated = applyCommand(deferred, { ...ctx, newId: "UPDATE" }, { type: "postUpdate", id: stale.id, text: "开始实测", progress: 60 }).state;
    expect(updated.items.find((item) => item.id === stale.id)?.progressRemindAt).toBeUndefined();
    expect(computeAlerts(updated.items, updated.rules, date).some((a) => a.itemId === stale.id && a.ruleId === "stale")).toBe(false);
  });

  it("需求负责人可以拆分自己负责的需求，或按当前排期确认直接交付", () => {
    const { state, split } = fixture();
    const ctx = { today: date, accountId: actor, newId: "CHILD" };
    expect(() => applyCommand(state, { ...ctx, accountId: "xunuo" }, { type: "confirmDirectDelivery", id: split.id })).toThrow("需求负责人");
    const decided = applyCommand(state, ctx, { type: "confirmDirectDelivery", id: split.id }).state;
    expect(computeAlerts(decided.items, decided.rules, date).some((alert) => alert.ruleId === "split_needed")).toBe(false);
    decided.items.find((item) => item.id === split.id)!.due = "2026-11-27";
    expect(computeAlerts(decided.items, decided.rules, date).some((alert) => alert.ruleId === "split_needed")).toBe(true);
    const afterSplit = applyCommand(state, ctx, { type: "addItem", item: {
      kind: "task", title: "拆出子任务", parentId: split.id, owner: actor, due: "2026-11-26",
    } }).state;
    expect(computeAlerts(afterSplit.items, afterSplit.rules, date).some((alert) => alert.ruleId === "split_needed")).toBe(false);
  });
});
