import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/lib/commands";
import { demoState } from "../src/lib/demo";
import { myQueue } from "../src/lib/queue";
import { computeAlerts } from "../src/lib/alerts";
import { performanceRows } from "../src/lib/performance";
import { performanceEvidence, qualitySummary, type PerfMetric } from "../src/lib/evidence";
import { canUseTeam } from "../src/lib/access";
import { memberLoads, recentActivity } from "../src/lib/team";
import { clientState } from "../src/lib/server-state";
import { progressOf } from "../src/lib/tree";
import { attachmentError, attachmentMime, attachmentHeaders, canAccessAttachment, MAX_ATTACHMENT_SIZE, validAttachmentContent } from "../src/lib/attachments";

const date = "2026-11-10";
const ctx = { accountId: "chenmo", today: date, newId: "batch1", now: `${date}T01:00:00Z` };
const fresh = () => demoState(date);
const run = (state: ReturnType<typeof fresh>, cmd: unknown, accountId = "chenmo", newId = "batch1") => applyCommand(state, { ...ctx, accountId, newId }, cmd).state;

describe("P1 可恢复生命周期", () => {
  it("恢复取消前原状态及同批连带下级，保留独立取消，统计和队列重入", () => {
    const before = fresh();
    let state = run(before, { type: "cancel", id: "T2c", reason: "单独取消" }, "chenmo", "separate");
    const baseline = structuredClone(state);
    state = run(state, { type: "cancel", id: "F1", reason: "暂停需求" });
    expect(myQueue(state, "zhouhang", date).some((e) => e.x.id === "T2b")).toBe(false);
    state = run(state, { type: "restore", id: "F1", reason: "需求继续" });
    for (const x of baseline.items.filter((x) => ["F1", "T2b", "T2c"].includes(x.id))) {
      expect(state.items.find((i) => i.id === x.id)?.status).toBe(x.status);
    }
    expect(state.items.find((x) => x.id === "T2c")?.cancelReason).toBe("单独取消");
    expect(state.items.find((x) => x.id === "T2b")?.log.at(-1)?.text).toContain("恢复（随上级");
    expect(myQueue(state, "zhouhang", date).map((e) => e.x.id)).toEqual(myQueue(baseline, "zhouhang", date).map((e) => e.x.id));
    expect(computeAlerts(state.items, state.rules, date)).toEqual(computeAlerts(baseline.items, baseline.rules, date));
    expect(performanceRows(state.items, state.people, date)).toEqual(performanceRows(baseline.items, baseline.people, date));
    const project = state.items.find((x) => x.id === "P1")!;
    expect(progressOf(state.items, project)).toBe(progressOf(baseline.items, baseline.items.find((x) => x.id === "P1")!));
    expect(before).toEqual(fresh());
  });
  it("恢复阻塞、待验收及已完成时保留计时和完成证据", () => {
    for (const status of ["blocked", "review", "done"] as const) {
      const state = fresh(); const x = state.items.find((x) => x.id === "T2b")!;
      Object.assign(x, { status, blockedSince: date, blockedReason: "等接口", reviewSince: date, doneAt: date });
      const restored = run(run(state, { type: "cancel", id: x.id, reason: "暂停" }), { type: "restore", id: x.id, reason: "继续" });
      expect(restored.items.find((i) => i.id === x.id)).toMatchObject({ status, blockedSince: date, reviewSince: date, doneAt: date, blockedReason: "等接口" });
    }
  });
  it.each(["restore", "unarchive"])("%s 重验原因、管理权限、停用、可见性及目标状态", (type) => {
    let state = fresh();
    state = run(state, type === "restore" ? { type: "cancel", id: "P1", reason: "暂停" } : { type: "archive", id: "P1", reason: "归档" });
    for (const actor of ["zhouhang", "guest"]) expect(() => run(state, { type, id: "P1", reason: "继续" }, actor)).toThrow();
    expect(() => run(state, { type, id: "P1", reason: " " })).toThrow("参数无效");
    expect(() => run(state, { type, id: "P2", reason: "继续" })).toThrow();
    state.accounts.find((a) => a.id === "chenmo")!.active = false;
    expect(() => run(state, { type, id: "P1", reason: "继续" })).toThrow("停用");
  });
  it("先恢复上级/解除归档；解除归档不恢复独立取消项，重复操作被拒绝", () => {
    let state = run(fresh(), { type: "cancel", id: "F1", reason: "暂停" });
    expect(() => run(state, { type: "restore", id: "T2b", reason: "继续" })).toThrow("上级");
    state = run(state, { type: "archive", id: "P1", reason: "封存" });
    expect(() => run(state, { type: "restore", id: "F1", reason: "继续" })).toThrow("归档");
    state = run(state, { type: "unarchive", id: "P1", reason: "继续项目" });
    expect(state.items.find((x) => x.id === "F1")?.status).toBe("cancelled");
    expect(() => run(state, { type: "unarchive", id: "P1", reason: "继续" })).toThrow("已归档项目");
    state = run(state, { type: "restore", id: "F1", reason: "继续需求" });
    expect(() => run(state, { type: "restore", id: "F1", reason: "继续" })).toThrow();
  });
  it("兼容 P0 无来源字段的连带取消日志，拒绝恢复同日期的独立取消", () => {
    let state = run(fresh(), { type: "cancel", id: "T2c", reason: "暂停" }, "chenmo", "separate");
    state = run(state, { type: "cancel", id: "F1", reason: "暂停" });
    for (const x of state.items) delete x.cancellation;
    state = run(state, { type: "restore", id: "F1", reason: "继续" });
    expect(state.items.find((x) => x.id === "T2b")?.status).not.toBe("cancelled");
    expect(state.items.find((x) => x.id === "T2c")?.status).toBe("cancelled");
  });
});

describe("P1 团队与统计证据", () => {
  it("管理员及项目负责人默认可见，成员不可见，可显式授权和关闭", () => {
    const state = fresh(); const admin = state.accounts.find((a) => a.id === "chenmo")!;
    const member = state.accounts.find((a) => a.id === "zhouhang")!;
    expect(canUseTeam(state.items, admin)).toBe(true); expect(canUseTeam(state.items, member)).toBe(false);
    state.items.find((x) => x.id === "P1")!.owner = member.id;
    expect(canUseTeam(state.items, member)).toBe(true);
    const denied = { ...member, menus: [...member.menus, "team:off" as const] };
    expect(canUseTeam(state.items, denied)).toBe(false);
    expect(memberLoads(state, denied, date)).toEqual([]);
    member.menus.push("team"); state.items.find((x) => x.id === "P1")!.owner = admin.id;
    expect(canUseTeam(state.items, member)).toBe(true);
    const saved = run(state, { type: "setAccount", id: member.id, account: denied });
    expect(canUseTeam(saved.items, saved.accounts.find((a) => a.id === member.id)!)).toBe(false);
  });
  it("负载按可见叶子去重、排除完成取消归档，同一任务可同时逾期阻塞", () => {
    const state = fresh(); const acc = state.accounts.find((a) => a.id === "chenmo")!;
    const base = state.items.find((x) => x.id === "T2b")!;
    state.items = [state.items.find((x) => x.id === "P1")!, { ...base, parentId: "P1", status: "blocked", due: "2026-11-01" }];
    expect(memberLoads(state, acc, date).find((r) => r.person.id === base.assignee)).toMatchObject({ overdue: 1, blocked: 1, doing: 0, review: 0 });
    state.items[0].archivedAt = date;
    expect(memberLoads(state, acc, date).flatMap((r) => r.tasks)).toEqual([]);
  });
  it("动态按精确时间倒序、可筛选分页，完整状态与投影结果一致，不泄漏隐藏项目", () => {
    const state = fresh(); const acc = state.accounts.find((a) => a.id === "zhouhang")!; acc.menus.push("team");
    const x = state.items.find((x) => x.id === "T2b")!;
    x.updates.push({ date, at: `${date}T04:00:00Z`, by: acc.id, text: "较新", progress: 55 }, { date, at: `${date}T03:00:00Z`, by: "chenmo", text: "较旧" });
    state.activities = [{ id: "deleted", itemId: "gone", projectId: "P1", title: "已删任务", date, by: acc.id, text: "删除任务" }, { id: "hidden", itemId: "secret", projectId: "secret-project", title: "隐藏", date, by: acc.id, text: "不可见" }];
    const all = recentActivity(state, acc);
    expect(all.entries.some((e) => e.text === "不可见")).toBe(false);
    expect(all.entries.findIndex((e) => e.text.includes("较新"))).toBeLessThan(all.entries.findIndex((e) => e.text.includes("较旧")));
    expect(recentActivity(state, acc, { limit: 2, offset: 2 }).entries).toEqual(all.entries.slice(2, 4));
    expect(recentActivity(state, acc, { project: "P1", person: acc.id }).entries.every((e) => e.projectId === "P1" && e.by === acc.id)).toBe(true);
    expect(recentActivity(clientState(state, acc.id), acc)).toEqual(all);  });
  it("删除人能看到自己删除根项目的记录，但看不到已失去权限项目里的删除", () => {
    const state = fresh(); const acc = state.accounts.find((a) => a.id === "zhouhang")!; acc.menus.push("team");
    state.activities = [{ id: "root", itemId: "Pgone", projectId: "Pgone", title: "误建项目", date, by: acc.id, text: "删除项目" }, { id: "child", itemId: "Tgone", projectId: "secret-project", title: "隐藏", date, by: acc.id, text: "不可见" }, { id: "other", itemId: "Pother", projectId: "Pother", title: "别人删的", date, by: "chenmo", text: "别人删除" }];
    const texts = clientState(state, acc.id).activities?.map((a) => a.text);
    expect(texts).toEqual(["删除项目"]);
    expect(recentActivity(state, acc).entries.filter((e) => e.deleted).map((e) => e.text)).toEqual(["删除项目"]);
    expect(recentActivity(clientState(state, acc.id), acc).entries.filter((e) => e.deleted).map((e) => e.text)).toEqual(["删除项目"]);
  });
  it("质量分母只认独立验收，取消项排除，无分母返回 null，每个指标提供对应样本", () => {
    const state = fresh(); const base = state.items.find((x) => x.id === "T2b")!;
    const x = { ...base, parentId: null, checks: [{ id: "self", by: base.assignee, type: "自测" as const, date, result: "通过" as const, note: "" }, { id: "review", by: "chenmo", type: "验收" as const, date, result: "不通过" as const, note: "修复" }], defects: [{ id: "d", title: "缺陷", owner: base.assignee, date, severity: "P1" as const, foundAt: "线上" as const, status: "open" as const }] };
    const summary = qualitySummary([x, { ...x, id: "cancel", status: "cancelled" as const }]);
    expect(summary).toMatchObject({ open: 1, escape: 100, firstPass: 0, failed: 1 });
    expect(summary.evidence.firstPass).toHaveLength(1); expect(summary.evidence.failed[0].detail).toContain("修复");
    expect(qualitySummary([])).toMatchObject({ open: 0, escape: null, firstPass: null, failed: 0 });
    const metrics: PerfMetric[] = ["delivered", "cycleDays", "onTime", "firstPass", "escape", "rework", "riskReports", "verifierCount", "badCases"];
    const perf = performanceRows(state.items, state.people, date);
    for (const p of state.people) for (const key of metrics) {
      const evidence = performanceEvidence(state.items, p.id, key, date);
      if (perf.find((r) => r.person === p.id)![key] === null) expect(evidence).toHaveLength(0);
      else expect(evidence.length).toBeGreaterThan(0);
    }
  });
});

describe("P1 附件命令及类型边界", () => {
  const meta = { name: "截图.png", mime: "image/png", size: 10 };
  it("限制10MB、文件名、扩展名和内容签名；HTML/SVG及伪装图片拒绝", () => {
    expect(attachmentError({ ...meta, size: MAX_ATTACHMENT_SIZE })).toBeUndefined();
    expect(attachmentMime("说明.md", "text/markdown")).toBe("text/plain");
    expect(attachmentMime("data.csv", "application/vnd.ms-excel")).toBe("text/csv");
    for (const size of [0, MAX_ATTACHMENT_SIZE + 1, -1, 1.5]) expect(attachmentError({ ...meta, size })).toBeTruthy();
    for (const name of ["../x.png", "a\r\nb.png", "x.svg", "x.html", "a.exe"]) expect(attachmentError({ ...meta, name })).toBeTruthy();
    expect(validAttachmentContent("image/png", Buffer.from("89504e470d0a1a0a", "hex"))).toBe(true);
    expect(validAttachmentContent("image/png", Buffer.from("<script>"))).toBe(false);
    expect(validAttachmentContent("text/plain", Buffer.from("中文说明"))).toBe(true);
  });
  it("上传/引用附件重新验证可见、只读、本人及相同工作项；只投影元信息", () => {
    let state = run(fresh(), { type: "uploadAttachment", id: "T2b", ...meta }, "zhouhang", "A1");
    expect(state.attachments?.[0]).toMatchObject({ id: "A1", itemId: "T2b", uploadedBy: "zhouhang" });
    state = run(state, { type: "postUpdate", id: "T2b", text: "附截图", attachmentIds: ["A1"] }, "zhouhang");
    expect(state.items.find((x) => x.id === "T2b")?.updates.at(-1)?.attachmentIds).toEqual(["A1"]);
    expect(() => run(state, { type: "postUpdate", id: "T2c", text: "跨任务", attachmentIds: ["A1"] }, "zhouhang")).toThrow("附件");
    expect(() => run(state, { type: "postUpdate", id: "T2b", text: "他人上传", attachmentIds: ["A1"] })).toThrow("附件");
    expect(() => run(state, { type: "addDefect", id: "T2b", defect: { title: "问题", severity: "P2", foundAt: "测试", owner: "zhouhang", attachmentIds: ["missing"] } }, "zhouhang")).toThrow("附件");
    const hidden = { ...state.accounts.find((a) => a.id === "guest")!, projects: [], scope: "selected" as const };
    expect(canAccessAttachment(state.items, state.attachments![0], hidden)).toBe(false);
    state = run(state, { type: "archive", id: "P1", reason: "归档" });
    const acc = state.accounts.find((a) => a.id === "zhouhang")!;
    expect(canAccessAttachment(state.items, state.attachments![0], acc)).toBe(true);
    expect(canAccessAttachment(state.items, state.attachments![0], acc, true)).toBe(false);
    expect(() => run(state, { type: "uploadAttachment", id: "T2b", ...meta }, "zhouhang")).toThrow("归档");
    expect(clientState(state, "zhouhang").attachments?.[0]).not.toHaveProperty("content");
  });
  it("附件下载图片内联、其余强制下载、中文文件名与 nosniff/no-store", () => {
    expect(attachmentHeaders(meta)).toMatchObject({ "Content-Type": "image/png", "X-Content-Type-Options": "nosniff", "Cache-Control": "private, no-store", "Content-Disposition": expect.stringMatching(/^inline;.*filename\*=UTF-8''/) });
    expect(attachmentHeaders({ ...meta, name: "说明.pdf", mime: "application/pdf" })["Content-Disposition"]).toMatch(/^attachment;/);
  });
});
