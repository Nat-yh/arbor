import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/lib/commands";
import { demoState } from "../src/lib/demo";
import { myQueue } from "../src/lib/queue";
import { dailyDigest } from "../src/lib/report";
import { planNotifications } from "../src/lib/notifications/plan";
import { computeAlerts } from "../src/lib/alerts";
import { performanceRows } from "../src/lib/performance";
import { applyRepoEvent } from "../src/lib/repo-sync";
import { progressOf, reviewSinceOf, statusOf } from "../src/lib/tree";
import { deleteBlockReason } from "../src/lib/lifecycle";
import { clientState } from "../src/lib/server-state";

const date = "2026-11-06";
const fresh = () => demoState(date);
const ctx = { accountId: "chenmo", today: date, newId: "P0NEW" };
const at = new Date(`${date}T10:00:00+08:00`);

describe("P0 统一待办", () => {
  it.each(["zhouhang", "chenmo"])("%s 的日报只列需要处理的有效事项，并与单独提醒按任务去重", (me) => {
    const state = fresh();
    const queue = myQueue(state, me, date);
    const digest = dailyDigest(state, me, date);
    const items = digest.sections.flatMap((s) => s.lines).map((l) => l.itemId);
    expect(new Set(items).size).toBe(items.length);
    const notices = planNotifications(state, at).filter((n) => n.recipient === `account:${me}`);
    const direct = new Set(notices.filter((n) => n.type === "event").map((n) => n.itemId));
    const daily = notices.find((n) => n.type === "daily");
    expect(daily?.report.sections.flatMap((s) => s.lines).map((l) => l.itemId) ?? []).toEqual(items.filter((id) => !direct.has(id)));
    expect(myQueue(clientState(state, me), me, date).map((e) => e.x.id)).toEqual(queue.map((e) => e.x.id));
  });
  it("管理者负责项目的五类风险都进入待办，关闭提醒规则也不能隐藏风险", () => {
    const state = fresh();
    state.items.find((x) => x.id === "P1")!.owner = "chenmo";
    const x = state.items.find((x) => x.id === "T2b")!;
    x.status = "blocked"; x.due = "2026-11-05"; x.blockedReason = "等待数据";
    const y = state.items.find((x) => x.id === "T2c")!;
    y.due = "2099-01-01"; y.assignee = "";
    const z = state.items.find((x) => x.id === "T1")!;
    z.status = "review"; z.reviewSince = "2026-11-03";
    state.rules.forEach((r) => { r.enabled = false; });
    const reasons = myQueue(state, "chenmo", date).flatMap((e) => e.reasons).filter((r) => r.management).map((r) => r.text).join("；");
    for (const expected of ["项目阻塞", "项目逾期", "计划冲突", "超时未验收", "无人负责"]) expect(reasons).toContain(expected);
  });
  it("项目负责人成员的投影不会把不可见账号详情误判成无人负责", () => {
    const state = fresh();
    state.items.find((x) => x.id === "P1")!.owner = "zhouhang";
    const snapshot = clientState(state, "zhouhang");
    expect(myQueue(snapshot, "zhouhang", date).map((e) => [e.x.id, e.reasons])).toEqual(myQueue(state, "zhouhang", date).map((e) => [e.x.id, e.reasons]));
  });
  it("100%未提交是优先待办，提交后改为等待验收，完成后移出队列", () => {
    let state = fresh();
    state = applyCommand(state, { ...ctx, accountId: "zhouhang" }, { type: "postUpdate", id: "T2b", text: "开发完成", progress: 100 }).state;
    expect(myQueue(state, "zhouhang", date).find((e) => e.x.id === "T2b")?.r.text).toBe("100% 未提交");
    state = applyCommand(state, { ...ctx, accountId: "zhouhang" }, { type: "submit", id: "T2b", deliverable: "https://example.com/p0", note: "" }).state;
    expect(myQueue(state, "zhouhang", date).find((e) => e.x.id === "T2b")?.r.text).toBe("等别人验收");
    state = applyCommand(state, ctx, { type: "verify", id: "T2b", pass: true, note: "通过" }).state;
    expect(myQueue(state, "zhouhang", date).some((e) => e.x.id === "T2b")).toBe(false);
  });
});

describe("P0 生命周期与权限", () => {
  it.each(["cancel", "archive", "delete"])("%s 拒绝空原因、非管理者、访客和停用账号，失败不污染输入", (type) => {
    const state = fresh(); const before = structuredClone(state);
    expect(() => applyCommand(state, ctx, { type, id: "P1", reason: " " })).toThrow("参数无效");
    for (const actor of ["zhouhang", "guest"]) expect(() => applyCommand(state, { ...ctx, accountId: actor }, { type, id: "T2b", reason: "测试" })).toThrow();
    expect(state).toEqual(before);
    state.accounts.find((a) => a.id === "chenmo")!.active = false;
    expect(() => applyCommand(state, ctx, { type, id: "P1", reason: "测试" })).toThrow("停用");
  });
  it("取消整棵子树，保留历史，每项留原因，进度/质量/待办/提醒全排除", () => {
    const state = fresh();
    const before = structuredClone(state);
    const next = applyCommand(state, ctx, { type: "cancel", id: "F1", reason: "需求撤回" }).state;
    const f = next.items.find((x) => x.id === "F1")!;
    expect(f.status).toBe("cancelled"); expect(f.cancelReason).toBe("需求撤回");
    expect(f.log.at(-1)?.text).toContain("需求撤回");
    expect(next.items.length).toBe(state.items.length);
    expect(next.items.find((x) => x.id === "T2b")!.log.at(-1)?.text).toContain("需求撤回");
    expect(myQueue(next, "zhouhang", date).some((e) => e.x.id === "T2b")).toBe(false);
    expect(computeAlerts(next.items, next.rules, date).some((a) => a.itemId === "T2b")).toBe(false);
    expect(state).toEqual(before);
    expect(() => applyCommand(next, ctx, { type: "postUpdate", id: "T2b", text: "重开", progress: 50 })).toThrow("已取消");
    expect(() => applyCommand(next, ctx, { type: "setStatus", id: "T2b", status: "doing" })).toThrow("已取消");
    expect(() => applyCommand(next, ctx, { type: "addItem", item: { parentId: "F1", kind: "task", title: "重开", owner: "chenmo", due: date } })).toThrow("已取消");
    expect(applyRepoEvent(next.items, next.accounts, { id: "ev", kind: "pr_open", repo: "company/approval-web", ref: "T2b", verified: true, receivedAt: `${date}T00:00:00Z` }, date).record.status).toBe("ignored");
  });
  it("取消叶子不影响其他任务，移除进度分母，全取消不自动完成", () => {
    const state = fresh();
    const base = state.items.find((x) => x.id === "T2b")!;
    const items = [{ ...base, id: "root", parentId: null, kind: "project" as const }, { ...base, id: "a", parentId: "root", estimate: 1, progress: 50 }, { ...base, id: "b", parentId: "root", estimate: 9, progress: 0, status: "cancelled" as const }];
    expect(progressOf(items, items[0])).toBe(50);
    items[1].status = "cancelled";
    expect(progressOf(items, items[0])).toBe(0); expect(statusOf(items, items[0])).toBe("todo");
  });
  it("多层汇总排除已全部取消的分支权重，汇总验收计时沿用最后叶子的完成日期", () => {
    const state = fresh(); const base = state.items.find((x) => x.id === "T2b")!;
    const root = { ...base, id: "root", parentId: null, kind: "project" as const };
    const branch = { ...base, id: "branch", parentId: "root", estimate: 99 };
    const a = { ...base, id: "a", parentId: "branch", status: "cancelled" as const, estimate: 99 };
    const b = { ...base, id: "b", parentId: "root", progress: 50, estimate: 1 };
    expect(progressOf([root, branch, a, b], root)).toBe(50);
    const done = { ...base, id: "a", parentId: "branch", status: "done" as const, doneAt: "2026-11-02" };
    const items = [root, branch, done];
    expect(reviewSinceOf(items, root, date)).toBe("2026-11-02");
  });
  it("项目归档保留历史绩效、停止全部提醒和待办、拒绝后续写入", () => {
    const state = fresh();
    const performance = performanceRows(state.items, state.people, date);
    const next = applyCommand(state, ctx, { type: "archive", id: "P1", reason: "项目结束" }).state;
    expect(next.items.find((x) => x.id === "P1")?.log.at(-1)?.text).toContain("归档项目：项目结束");
    expect(performanceRows(next.items, next.people, date)).toEqual(performance);
    expect(myQueue(next, "zhouhang", date).some((e) => e.x.id === "T2b")).toBe(false);
    expect(computeAlerts(next.items, next.rules, date).some((a) => a.itemId === "T2b")).toBe(false);
    expect(() => applyCommand(next, ctx, { type: "edit", id: "T2b", patch: { title: "修改" } })).toThrow("已归档");
    expect(() => applyCommand(state, ctx, { type: "archive", id: "T2b", reason: "归档" })).toThrow("只有项目");
  });
  it("项目只有当天误建可删除，删除后动态仍可查", () => {
    let state = fresh();
    state = applyCommand(state, ctx, { type: "addItem", item: { parentId: null, kind: "project", title: "误建", owner: "chenmo", due: date } }).state;
    const x = state.items.find((x) => x.id === ctx.newId)!;
    expect(deleteBlockReason(state, x, date)).toBeUndefined();
    expect(deleteBlockReason(state, x, "2026-11-07")).toBe("仅当天误建");
    const next = applyCommand(state, { ...ctx, newId: "audit" }, { type: "delete", id: x.id, reason: "创建错误" }).state;
    expect(next.items.some((i) => i.id === x.id)).toBe(false);
    expect(next.activities?.at(-1)).toMatchObject({ itemId: x.id, by: "chenmo", text: expect.stringContaining("创建错误") });
    const variants = [{ updates: [{ date, by: "chenmo", text: "已有动态" }] }, { checks: [{ id: "c", type: "验收" as const, by: "zhouhang", date, result: "通过" as const, note: "" }] }, { progress: 1 }, { log: [...x.log, { date, by: "chenmo", text: "修改" }] }, { pr: { number: 1, repo: "a/b", url: "x" } }];
    for (const patch of variants) expect(deleteBlockReason(state, { ...x, ...patch }, date)).toBe("仅当天误建");
    expect(() => applyCommand(state, ctx, { type: "delete", id: "P1", reason: "历史项" })).toThrow("当天刚创建");
  });
  it.each(["feature", "task"] as const)("可删除已有进展的历史 %s，保留删除动态", (kind) => {
    const state = fresh();
    const added = applyCommand(state, ctx, { type: "addItem", item: { parentId: "P1", kind, title: "重复工作项", owner: "chenmo", verifiers: ["zhouhang"], due: date } }).state;
    const later = { ...ctx, today: "2026-11-07", newId: "audit" };
    const progressed = applyCommand(added, later, { type: "postUpdate", id: ctx.newId, text: "已有进展", progress: 25 }).state;
    const next = applyCommand(progressed, later, { type: "delete", id: ctx.newId, reason: "重复创建" }).state;
    expect(next.items.some((x) => x.id === ctx.newId)).toBe(false);
    expect(next.items.find((x) => x.id === "P1")!.log.at(-1)?.text).toContain("重复创建");
    expect(next.activities?.at(-1)).toMatchObject({ itemId: ctx.newId, projectId: "P1", text: expect.stringContaining("重复创建") });
  });
  it("有下级、附件或仓库事件时阻止删除", () => {
    const state = fresh();
    const remove = (id: string) => applyCommand(state, ctx, { type: "delete", id, reason: "重复创建" });
    expect(() => remove("F1")).toThrow("有下级");
    state.attachments = [{ id: "file", itemId: "T2b", uploadedBy: "chenmo", name: "test.txt", mime: "text/plain", size: 1, createdAt: `${date}T00:00:00Z` }];
    expect(() => remove("T2b")).toThrow("有关联附件");
    state.attachments = [];
    state.repoEvents.push({ id: "ev", kind: "comment", verified: true, repo: "company/approval-web", receivedAt: `${date}T00:00:00Z`, status: "applied", itemId: "T2b", result: "" });
    expect(() => remove("T2b")).toThrow("有关联仓库记录");
  });
});

describe("P0 实时绩效", () => {
  it("缺少有效分母返回 null，不把无数据当0%；排除取消/未来/90天外记录", () => {
    const state = fresh();
    expect(performanceRows([], state.people, date).every((r) => Object.entries(r).filter(([k]) => k !== "person").every(([, v]) => v === null))).toBe(true);
    const base = state.items.find((x) => x.id === "T2b")!;
    const feature = { ...base, id: "F", kind: "feature" as const, parentId: null, owner: "zhouhang", assignee: "zhouhang", status: "done" as const, start: "2026-10-01", due: "2026-10-10", doneAt: "2026-10-09", checklist: [], checks: [{ id: "a", date: "2026-10-08", type: "业务验收" as const, by: "chenmo", result: "不通过" as const, note: "" }, { id: "b", date: "2026-10-09", type: "业务验收" as const, by: "chenmo", result: "通过" as const, note: "" }], defects: [{ id: "d", title: "bug", severity: "P2" as const, foundAt: "线上" as const, owner: "zhouhang", date: "2026-10-10", status: "fixed" as const }] };
    const items = [feature, { ...feature, id: "cancel", status: "cancelled" as const }, { ...feature, id: "old", doneAt: "2026-01-01", defects: [], checks: [] }, { ...feature, id: "future", doneAt: "2026-12-01", defects: [], checks: [] }];
    const row = performanceRows(items, state.people, date).find((r) => r.person === "zhouhang")!;
    expect(row).toMatchObject({ delivered: 1, cycleDays: 8, onTime: 100, firstPass: 0, escape: 100, rework: 100 });
    expect(row.riskReports).toBeNull();
    expect(performanceRows(items, state.people, date).find((r) => r.person === "chenmo")?.verifierCount).toBe(2);
    feature.checks[0].result = "通过";
    expect(performanceRows([feature], state.people, date).find((r) => r.person === "zhouhang")?.firstPass).toBe(100);
    feature.status = "cancelled" as never;
    expect(performanceRows([feature], state.people, date).find((r) => r.person === "zhouhang")?.delivered).toBeNull();
  });
  it("忽略自己验收和自动测试的首次通过率，周期偶数样本取中位数", () => {
    const state = fresh(); const base = state.items.find((x) => x.id === "T2b")!;
    const x = { ...base, id: "F", parentId: null, kind: "feature" as const, owner: "zhouhang", status: "done" as const, start: "2026-11-01", due: date, doneAt: "2026-11-03", checks: [{ id: "a", date, by: base.assignee, type: "验收" as const, result: "通过" as const, note: "" }] };
    const row = performanceRows([x, { ...x, id: "F2", doneAt: "2026-11-05" }], state.people, date).find((r) => r.person === "zhouhang")!;
    expect(row.cycleDays).toBe(3); expect(row.firstPass).toBeNull(); expect(row.rework).toBeNull();
  });
});
