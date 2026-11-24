import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCommand, type Command } from "../src/lib/commands";
import { demoState } from "../src/lib/demo";
import type { AppState } from "../src/lib/state";
import { BACKLOG, currentIteration, doneInIteration, iterationIdOf, iterationScope, iterationStats } from "../src/lib/tree";

let state: AppState;
let sequence = 0;
const run = (cmd: unknown, actor = "chenmo") => applyCommand(state, { accountId: actor, today: "2026-11-06", newId: `NEW${++sequence}` }, cmd);
const accept = (cmd: Command, actor?: string) => { const r = run(cmd, actor); state = r.state; return r; };
const get = (id: string) => state.items.find((x) => x.id === id)!;
const project = () => get("P1");
const create = (name: string, start: string, end: string) => accept({ type: "saveIteration", id: "P1", iteration: { name, start, end } }).result.id!;

beforeEach(() => {
  vi.stubEnv("DEMO_MODE", "false");
  state = demoState("2026-11-06");
  // 用无迭代的干净状态测试，演示数据里的迭代另行覆盖
  state.items = state.items.map(({ iterations: _i, iteration: _t, ...x }) => { void _i; void _t; return x; });
  sequence = 0;
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("迭代", () => {
  it("只有项目负责人或管理员能新建，名称不能重复，结束不能早于开始", () => {
    expect(() => run({ type: "saveIteration", id: "P1", iteration: { name: "V2.1", start: "2026-11-01", end: "2026-11-14" } }, "zhouhang")).toThrow("项目负责人");
    const id = create("V2.1", "2026-11-01", "2026-11-14");
    expect(project().iterations).toEqual([{ id, name: "V2.1", start: "2026-11-01", end: "2026-11-14" }]);
    expect(() => run({ type: "saveIteration", id: "P1", iteration: { name: "V2.1", start: "2026-11-15", end: "2026-11-28" } })).toThrow("已有名为");
    expect(() => run({ type: "saveIteration", id: "P1", iteration: { name: "V2.2", start: "2026-11-15", end: "2026-11-10" } })).toThrow("不能早于");
    expect(() => run({ type: "saveIteration", id: "F1", iteration: { name: "X", start: "2026-11-15", end: "2026-11-20" } })).toThrow("只有项目");
  });

  it("工作项归入迭代，下级沿用；只能归入本项目未结束的迭代", () => {
    const v1 = create("V2.1", "2026-11-01", "2026-11-14");
    accept({ type: "edit", id: "F1", patch: { iteration: v1 } });
    expect(get("F1").log.at(-1)!.text).toContain("迭代：待规划 → V2.1");
    expect(iterationIdOf(state.items, get("T2b"))).toBe(v1);
    expect(iterationScope(state.items, project(), v1).map((x) => x.id)).toEqual(["F1"]);
    expect(() => run({ type: "edit", id: "F5", patch: { iteration: v1 } })).toThrow();
    expect(() => run({ type: "edit", id: "F2", patch: { iteration: "nope" } })).toThrow("迭代不存在");
    expect(() => run({ type: "edit", id: "P1", patch: { iteration: v1 } })).toThrow("项目本身");
    accept({ type: "edit", id: "F1", patch: { iteration: null } });
    expect(get("F1").iteration).toBeUndefined();
  });

  it("新建工作项时可直接归入迭代", () => {
    const v1 = create("V2.1", "2026-11-01", "2026-11-14");
    const id = accept({ type: "addItem", item: { parentId: "P1", kind: "task", title: "新任务", owner: "chenmo", due: "2026-11-12", iteration: v1 } }).result.id!;
    expect(get(id).iteration).toBe(v1);
  });

  it("结束迭代并结转", () => {
    const v1 = create("V2.1", "2026-11-01", "2026-11-14");
    const v2 = create("V2.2", "2026-11-15", "2026-11-28");
    accept({ type: "edit", id: "F1", patch: { iteration: v1 } });
    accept({ type: "edit", id: "T12", patch: { iteration: v1 } });
    // 让 T12 全部完成
    for (const t of ["T12a", "T12b", "T12c"]) state.items = state.items.map((x) => x.id === t ? { ...x, status: "done", progress: 100 } : x);
    expect(iterationStats(state.items, iterationScope(state.items, project(), v1), v1)).toMatchObject({ total: 2, done: 1 });
    expect(() => run({ type: "closeIteration", id: "P1", iterationId: v1, moveTo: v1 })).toThrow("结转目标");
    accept({ type: "closeIteration", id: "P1", iterationId: v1, moveTo: v2 });
    const closed = project().iterations!.find((i) => i.id === v1)!;
    expect(closed).toMatchObject({ closedAt: "2026-11-06", closedBy: "chenmo", summary: { planned: 2, done: 1, carried: 1, to: v2 } });
    expect(get("F1").iteration).toBe(v2);
    expect(get("T12").iteration).toBe(v1);
    // F1 下已完成的任务固定在 V2.1，没完成的跟着 F1 去 V2.2
    expect(get("T1").iteration).toBe(v1);
    expect(iterationIdOf(state.items, get("T2b"))).toBe(v2);
    expect(get("F1").log.at(-1)!.text).toContain("结转到「V2.2」");
    expect(project().log.at(-1)!.text).toBe("结束迭代「V2.1」：完成 1/2，1 项结转到「V2.2」");
    // 已结束的迭代不能再改、删、归入
    expect(() => run({ type: "saveIteration", id: "P1", iterationId: v1, iteration: { name: "x", start: "2026-11-01", end: "2026-11-02" } })).toThrow("已结束");
    expect(() => run({ type: "deleteIteration", id: "P1", iterationId: v1 })).toThrow("历史记录");
    expect(() => run({ type: "edit", id: "F2", patch: { iteration: v1 } })).toThrow("已结束");
    // 保持原值（已结束迭代的历史归属）时编辑其他字段不受影响
    expect(run({ type: "edit", id: "T12", patch: { title: "上线准备（一期）" } }).result.ok).toBe(true);
    expect(currentIteration(project(), "2026-11-06")!.id).toBe(v2);
  });

  it("下级显式写了同一迭代且没做完，也跟着上级结转", () => {
    const v1 = create("V2.1", "2026-11-01", "2026-11-14");
    const v2 = create("V2.2", "2026-11-15", "2026-11-28");
    accept({ type: "edit", id: "F1", patch: { iteration: v1 } });
    accept({ type: "edit", id: "T2", patch: { iteration: v1 } }); // 与上级相同的显式设置
    accept({ type: "closeIteration", id: "P1", iterationId: v1, moveTo: v2 });
    expect(get("T2").iteration).toBeUndefined();
    expect(iterationIdOf(state.items, get("T2b"))).toBe(v2);
    expect(get("T2a").iteration).toBe(v1); // 已完成的留在原迭代
  });

  it("结束迭代不结转时，未完成项回到待规划", () => {
    const v1 = create("V2.1", "2026-11-01", "2026-11-14");
    accept({ type: "edit", id: "F2", patch: { iteration: v1 } });
    accept({ type: "closeIteration", id: "P1", iterationId: v1, moveTo: null });
    expect(get("F2").iteration).toBeUndefined();
    expect(iterationScope(state.items, project(), null).map((x) => x.id)).toContain("F2");
    expect(get("F2").log.at(-1)!.text).toContain("结转到「待规划」");
  });

  it("只能删除空的迭代", () => {
    const v1 = create("V2.1", "2026-11-01", "2026-11-14");
    accept({ type: "edit", id: "F2", patch: { iteration: v1 } });
    expect(() => run({ type: "deleteIteration", id: "P1", iterationId: v1 })).toThrow("还有工作项");
    accept({ type: "edit", id: "F2", patch: { iteration: null } });
    accept({ type: "deleteIteration", id: "P1", iterationId: v1 });
    expect(project().iterations).toEqual([]);
  });
});

describe("迭代边界（审查发现）", () => {
  it("不能经由沿用上级进入已结束的迭代；补拆的子任务放进待规划", () => {
    const v1 = create("V2.1", "2026-11-01", "2026-11-14");
    const v2 = create("V2.2", "2026-11-15", "2026-11-28");
    accept({ type: "edit", id: "F1", patch: { iteration: v1 } });
    accept({ type: "edit", id: "T3", patch: { iteration: v2 } });
    for (const t of ["T2a", "T2b", "T2c", "T4"]) state.items = state.items.map((x) => x.id === t ? { ...x, status: "done", progress: 100 } : x);
    accept({ type: "closeIteration", id: "P1", iterationId: v1, moveTo: v2 });
    expect(get("F1").iteration).toBe(v1); // 本迭代的部分都完成了，需求留在 V2.1
    // 清掉 T3 的单独设置会沿用已结束的 V2.1：拒绝
    expect(() => run({ type: "edit", id: "T3", patch: { iteration: null } })).toThrow("已结束");
    // 在已结束迭代的需求下补拆子任务：自动进入待规划
    const id = accept({ type: "addItem", item: { parentId: "T2", kind: "task", title: "补充", owner: "zhouhang", due: "2026-11-20" } }, "zhouhang").result.id!;
    expect(get(id).iteration).toBe(BACKLOG);
    expect(iterationIdOf(state.items, get(id))).toBeUndefined();
    expect(iterationScope(state.items, project(), null).map((x) => x.id)).toContain(id);
  });

  it("嵌套项结束时选待规划，不会悄悄回到上级的迭代", () => {
    const a = create("V2.1", "2026-11-01", "2026-11-14");
    const b = create("V2.2", "2026-11-15", "2026-11-28");
    accept({ type: "edit", id: "F1", patch: { iteration: a } });
    accept({ type: "edit", id: "T3", patch: { iteration: b } });
    accept({ type: "closeIteration", id: "P1", iterationId: b, moveTo: null });
    expect(get("T3").iteration).toBe(BACKLOG);
    expect(iterationIdOf(state.items, get("T3"))).toBeUndefined();
    expect(get("T3").log.at(-1)!.text).toContain("结转到「待规划」");
  });

  it("统计与结转只看属于本迭代的部分", () => {
    const a = create("V2.1", "2026-11-01", "2026-11-14");
    const b = create("V2.2", "2026-11-15", "2026-11-28");
    accept({ type: "edit", id: "F2", patch: { iteration: a } });
    accept({ type: "edit", id: "T7", patch: { iteration: b } });
    accept({ type: "edit", id: "T8", patch: { iteration: b } });
    // F2 在 V2.1 的部分：T5（完成）+ T6（待验收）
    expect(doneInIteration(state.items, get("F2"), a)).toBe(false);
    state.items = state.items.map((x) => x.id === "T6" ? { ...x, status: "done" } : x);
    expect(doneInIteration(state.items, get("F2"), a)).toBe(true);
    expect(iterationStats(state.items, iterationScope(state.items, project(), a), a)).toMatchObject({ done: 1, progress: 100 });
    accept({ type: "closeIteration", id: "P1", iterationId: a, moveTo: b });
    expect(get("F2").iteration).toBe(a);
    expect(project().iterations!.find((i) => i.id === a)!.summary).toMatchObject({ planned: 1, done: 1, carried: 0 });
  });

  it("结束迭代不改动已取消项的归属", () => {
    const a = create("V2.1", "2026-11-01", "2026-11-14");
    const b = create("V2.2", "2026-11-15", "2026-11-28");
    accept({ type: "edit", id: "F1", patch: { iteration: a } });
    accept({ type: "edit", id: "T4", patch: { iteration: a } });
    accept({ type: "cancel", id: "T4", reason: "不做了" });
    accept({ type: "cancel", id: "T3", reason: "不做了" });
    accept({ type: "closeIteration", id: "P1", iterationId: a, moveTo: b });
    expect(get("F1").iteration).toBe(b);
    expect(get("T4").iteration).toBe(a);
    expect(get("T3").iteration).toBe(a); // 原本沿用，固定在原迭代
  });

  it("结转目标的名称写入快照；只剩已取消项的迭代可以删除", () => {
    const a = create("V2.1", "2026-11-01", "2026-11-14");
    const b = create("V2.2", "2026-11-15", "2026-11-28");
    accept({ type: "edit", id: "F2", patch: { iteration: a } });
    accept({ type: "closeIteration", id: "P1", iterationId: a, moveTo: b });
    expect(project().iterations!.find((i) => i.id === a)!.summary!.toName).toBe("V2.2");
    accept({ type: "cancel", id: "F2", reason: "砍掉" });
    accept({ type: "deleteIteration", id: "P1", iterationId: b });
    expect(get("F2").iteration).toBeUndefined();
  });

  it("沿用的验证人是执行人自己时仍然有效，不能擅自替换", () => {
    state.items = state.items.map((x) => x.id === "F1" ? { ...x, verifiers: ["zhouhang"] } : x.id === "T2b" ? { ...x, assignee: "zhouhang", verifiers: [] } : x);
    expect(() => run({ type: "submit", id: "T2b", deliverable: "https://example.com/pr/1", note: "", verifiers: ["xunuo"] }, "zhouhang")).toThrow("项目负责人");
    expect(accept({ type: "submit", id: "T2b", deliverable: "https://example.com/pr/1", note: "" }, "zhouhang").result.ok).toBe(true);
  });

  it("当前迭代：到期未结束的优先于未开始的", () => {
    create("V2.1", "2026-10-20", "2026-11-02");
    create("V2.2", "2026-11-10", "2026-11-23");
    expect(currentIteration(project(), "2026-11-06")!.name).toBe("V2.1");
  });
});
