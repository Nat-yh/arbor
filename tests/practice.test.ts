import { afterEach, describe, expect, it, vi } from "vitest";
import { hasPracticeReference, PRACTICE, PracticeSession } from "../src/lib/practice";

const session = (track: "work" | "create" | "review" = "work") => new PracticeSession(track, "/projects?mine=1", "2026-11-13", "Asia/Shanghai");
afterEach(() => vi.unstubAllGlobals());

describe("指南练习的数据隔离", () => {
  it("真实操作规则可以走通更新、提交、验收，全程无网络调用", () => {
    const fetch = vi.fn(() => { throw new Error("must not use network"); });
    vi.stubGlobal("fetch", fetch);
    const s = session();
    expect(s.dispatch({ type: "setStatus", id: PRACTICE.task, status: "doing" }).ok).toBe(true);
    expect(s.dispatch({ type: "postUpdate", id: PRACTICE.task, text: "已检查正确密码", progress: 50 }).ok).toBe(true);
    expect(s.dispatch({ type: "submit", id: PRACTICE.task, deliverable: "测试说明", note: "", verifiers: [PRACTICE.reviewer] }).ok).toBe(true);
    expect(s.snapshot.items.find((x) => x.id === PRACTICE.task)?.status).toBe("review");
    expect(s.switchActor(PRACTICE.reviewer)).toBe(true);
    expect(s.dispatch({ type: "verify", id: PRACTICE.task, pass: true, note: "" }).ok).toBe(true);
    expect(s.snapshot.items.find((x) => x.id === PRACTICE.task)?.status).toBe("done");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("打回必须写原因，执行人修改后仍需验证人验收", () => {
    const s = session("review");
    expect(s.dispatch({ type: "verify", id: PRACTICE.task, pass: false, note: "" }).ok).toBe(false);
    expect(s.dispatch({ type: "verify", id: PRACTICE.task, pass: false, note: "请补充错误提示" }).ok).toBe(true);
    s.switchActor(PRACTICE.learner);
    expect(s.dispatch({ type: "submit", id: PRACTICE.task, deliverable: "补充后的结果", note: "已修正" }).ok).toBe(true);
    expect(s.dispatch({ type: "verify", id: PRACTICE.task, pass: true, note: "" }).ok).toBe(false);
    s.switchActor(PRACTICE.reviewer);
    expect(s.dispatch({ type: "verify", id: PRACTICE.task, pass: true, note: "" }).ok).toBe(true);
    expect(s.snapshot.items.find((x) => x.id === PRACTICE.task)?.rework).toBe(1);
  });

  it("所有非命令接口均拒绝，不退回真实写入", () => {
    const s = session();
    const before = JSON.stringify(s.snapshot);
    for (const endpoint of ["/api/auth/demo", "/api/auth/logout", "/api/demo/reset", "/api/attachments?itemId=x", "/api/admin/feishu", "/api/unknown"]) {
      expect(s.dispatch(undefined, endpoint).ok).toBe(false);
    }
    expect(s.dispatch({ type: "uploadAttachment", id: PRACTICE.task, name: "x.txt", mime: "text/plain", size: 5 }).ok).toBe(false);
    expect(s.dispatch({ type: "setRule", id: "stale", patch: { enabled: true } }).ok).toBe(false);
    expect(s.dispatch({ type: "bindRepo", id: PRACTICE.project, repo: "owner/repo" }).ok).toBe(false);
    expect(JSON.stringify(s.snapshot)).toBe(before);
  });

  it("不包含真实人员、附件或通知配置，演练账号无系统管理权限", () => {
    const s = session();
    expect(s.snapshot.people.map((p) => p.id)).toEqual([PRACTICE.learner, PRACTICE.reviewer]);
    expect(s.snapshot.accounts.every((a) => !a.menus.includes("settings"))).toBe(true);
    expect(s.snapshot.attachments).toEqual([]);
    expect(s.snapshot.rules).toEqual([]);
    expect(s.snapshot.repoEvents).toEqual([]);
    expect(s.snapshot.demoMode).toBe(false);
    expect(s.dispatch({ type: "postUpdate", id: "real-task", text: "不得保存", progress: 50 }).ok).toBe(false);
  });

  it("创建与拆分使用独立 ID，失败不能污染已有快照", () => {
    const s = session("create");
    const initial = structuredClone(s.snapshot);
    const task = s.dispatch({ type: "addItem", item: { parentId: PRACTICE.project, kind: "task", title: "检查页面", owner: PRACTICE.learner, due: "2026-11-20" } });
    expect(task.ok).toBe(true);
    expect(task.id).toMatch(/^practice-new-/);
    expect(s.dispatch({ type: "addItem", item: { parentId: task.id!, kind: "task", title: "检查按钮", owner: PRACTICE.learner, due: "2026-11-20" } }).ok).toBe(true);
    expect(initial.items).toHaveLength(1);
    expect(s.snapshot.items).toHaveLength(3);
    const before = JSON.stringify(s.snapshot);
    expect(s.dispatch({ type: "setStatus", id: task.id!, status: "doing" }).ok).toBe(false);
    expect(JSON.stringify(s.snapshot)).toBe(before);
  });

  it("退出后旧操作失效，重新进入不会带入上次记录", () => {
    const s = session();
    s.dispatch({ type: "postUpdate", id: PRACTICE.task, text: "一次练习", progress: 50 });
    s.close();
    expect(s.dispatch({ type: "setStatus", id: PRACTICE.task, status: "done" }).ok).toBe(false);
    expect(s.switchActor(PRACTICE.reviewer)).toBe(false);
    const next = session();
    expect(next.id).not.toBe(s.id);
    expect(next.snapshot.items.find((x) => x.id === PRACTICE.task)?.updates).toEqual([]);
    expect(next.returnTo).toBe("/projects?mine=1");
  });

  it("识别嵌套的练习 ID，防止刷新后的残留表单发送到真实工作区", () => {
    expect(hasPracticeReference({ type: "postUpdate", id: PRACTICE.task })).toBe(true);
    expect(hasPracticeReference({ item: { parentId: PRACTICE.project } })).toBe(true);
    expect(hasPracticeReference({ verifiers: [PRACTICE.reviewer] })).toBe(true);
    expect(hasPracticeReference({ type: "addItem", item: { parentId: "P1", title: "登录测试", owner: "zhouhang" } })).toBe(false);
    expect(hasPracticeReference({ type: "addItem", item: { parentId: "P1", title: "practice-login", desc: "practice-说明", owner: "zhouhang" } })).toBe(false);
  });
});
