import { describe, expect, it } from "vitest";
import { demoState } from "../src/lib/demo";
import type { WorkItem } from "../src/lib/model";
import { personalWeeklyActivity, personalWeeklyReport, projectWeeklyPreview, reportPlainText, weeklyReport } from "../src/lib/report";

const asOf = "2026-11-26";
const author = "zhouhang";
const peer = "xunuo";
const update = (text: string, date: string, by = author) => ({ text, date, by, progress: 40 });

function fixture() {
  const sample = demoState(asOf);
  const projectTemplate = sample.items.find(({ kind }) => kind === "project")!;
  const taskTemplate = sample.items.find(({ kind }) => kind === "task")!;
  const account = sample.accounts.find(({ id }) => id === author)!;
  const project = (id: string, members: string[]): WorkItem => ({
    ...projectTemplate, id, title: id, owner: peer, assignee: peer, assignees: undefined, members, verifiers: [],
    status: "todo", updates: [], log: [],
  });
  const task = (id: string, parentId: string, fields: Partial<WorkItem> = {}): WorkItem => ({
    ...taskTemplate, id, parentId, title: id, owner: author, assignee: author, assignees: undefined, verifiers: [],
    status: "doing", progress: 40, doneAt: undefined, updates: [], log: [], ...fields,
  });
  const current = project("当前项目", [author]);
  const other = project("其他有进展的项目", [author]);
  const idle = project("本周无进展的项目", [author]);
  const hidden = project("无权限的项目", []);
  const items = [
    current, other, idle, hidden,
    task("本人任务", current.id, { updates: [
      update("上周的动态", "2026-11-22"),
      update("本周最新进展\n已核对样本", "2026-11-25"),
      update("未来更新", "2026-11-27"),
      { ...update("撤回内容", asOf), retractedAt: "2026-11-26T09:00:00Z" },
      update("他人动态", asOf, peer),
    ] }),
    task("同事的任务", current.id, { owner: peer, assignee: peer, updates: [update("同事本周交付", asOf, peer)] }),
    task("本周已完成", other.id, { status: "done", doneAt: "2026-11-23" }),
    task("本周刚开始", other.id, { log: [{ by: author, date: asOf, text: "状态改为「进行中」" }] }),
    task("没有本周活动", idle.id, { updates: [update("上周更新", "2026-11-22")] }),
    task("不可见的工作", hidden.id, { owner: peer, assignee: peer, updates: [update("本人以前的记录", asOf)] }),
    task("已取消的工作", other.id, { status: "cancelled", updates: [update("取消前的动态", asOf)] }),
  ];
  return { items, account, current };
}

describe("周报范围与复制", () => {
  it("个人周报仅汇总本周有进展的可见项目，切换当前项目后复制范围随之变化", () => {
    const { items, account, current } = fixture();
    const activity = personalWeeklyActivity(items, account, asOf);
    expect(activity.map(({ id }) => id)).toEqual(["当前项目", "其他有进展的项目"]);
    expect(activity[1].lines.map(({ text }) => text)).toEqual(["本周已完成", "本周刚开始"]);
    const text = reportPlainText(personalWeeklyReport(activity, "周航", current, asOf));
    expect(text).toContain("11 月 23 日至 11 月 26 日");
    expect(text).toContain("本周最新进展\n  已核对样本");
    for (const excluded of ["上周", "未来", "撤回", "他人动态", "同事的任务", "其他有进展的项目"]) {
      expect(text).not.toContain(excluded);
    }
  });

  it("项目总览包含团队本周进展和计数，定时推送沿用原有整体进度口径", () => {
    const { items, current } = fixture();
    const report = projectWeeklyPreview(items, current, [], asOf);
    const text = reportPlainText(report);
    expect(text).toContain("进行中 2 项，未开始 0 项");
    expect(text).toContain("同事本周交付");
    expect(text).not.toContain("其他有进展的项目");
    expect(weeklyReport(items, current, [], asOf).sections[0]).toMatchObject({ heading: "整体进度", variant: "progress" });
  });
});
