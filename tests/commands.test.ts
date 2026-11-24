import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyCommand, CommandError, type Command } from "../src/lib/commands";
import { demoState } from "../src/lib/demo";
import type { AppState } from "../src/lib/state";
import { applyRole } from "../src/lib/access";
import { buildChecklist, workingDays, type WorkItem } from "../src/lib/model";
import { applyRepoEvent } from "../src/lib/repo-sync";
import { collectHandoffs, validHandoff } from "../src/lib/notifications/handoff";
import { planRiskNotices } from "../src/lib/notifications/plan";
import { myQueue } from "../src/lib/queue";
import { clientState } from "../src/lib/server-state";
import { childrenOf, iterationIdOf, needsSubmission, openChecks, progressOf, projectWorkCounts, statusOf, visibleChecks } from "../src/lib/tree";

let state: AppState;
let sequence = 0;
const run = (cmd: unknown, actor = "zhouhang") => applyCommand(state, { accountId: actor, today: "2026-11-06", newId: `NEW${++sequence}` }, cmd);
const accept = (cmd: Command, actor?: string) => { const r = run(cmd, actor); state = r.state; return r; };
const item = () => state.items.find((x) => x.id === "T2b")!;
beforeEach(() => { vi.stubEnv("DEMO_MODE", "false"); state = demoState("2026-11-06"); sequence = 0; });
afterEach(() => { vi.unstubAllEnvs(); });

describe("项目执行人取消和删除本人任务", () => {
  const find = (id: string) => state.items.find((item) => item.id === id)!;
  const add = (overrides: Partial<Extract<Command, { type: "addItem" }>["item"]> = {}, actor = "zhouhang") =>
    accept({ type: "addItem", item: {
      parentId: "P1", kind: "task", title: "权限验证任务", owner: "zhouhang", due: "2026-11-20", ...overrides,
    } }, actor).result.id!;
  const remove = (type: "cancel" | "delete", id: string) => ({ type, id, reason: "不再需要" } as const);

  beforeEach(() => {
    const project = find("P1");
    project.assignees = [project.assignee, "zhouhang"];
  });

  it("允许多执行人中的非项目负责人取消和删除自己创建并负责的任务", () => {
    const cancelled = add();
    const deleted = add();
    accept(remove("cancel", cancelled));
    expect(find(cancelled)).toMatchObject({ status: "cancelled", cancelReason: "不再需要" });
    accept(remove("delete", deleted));
    expect(find(deleted)).toBeUndefined();
    expect(find("P1").childOrder).not.toContain(deleted);
    expect(state.activities?.at(-1)).toMatchObject({ itemId: deleted, by: "zhouhang", projectId: "P1" });
  });

  it("拒绝他人创建、本人转交、缺少创建记录及非任务", () => {
    const teammateTask = add({}, "chenmo");
    const handedOff = add();
    accept({ type: "edit", id: handedOff, patch: { owner: "xunuo" } });
    const legacy = add();
    find(legacy).log = [];
    const feature = add({ kind: "feature" });
    for (const id of [teammateTask, handedOff, legacy, feature, "P1"]) {
      expect(() => run(remove("cancel", id))).toThrow("项目负责人");
      expect(() => run(remove("delete", id))).toThrow("项目负责人");
    }
    const ownTask = add();
    find("P1").assignees = [find("P1").assignee];
    expect(() => run(remove("cancel", ownTask))).toThrow("项目负责人");
    expect(() => run(remove("delete", ownTask))).toThrow("项目负责人");
  });

  it("取消只连带本人的子任务，删除依旧校验子项和附件", () => {
    const parent = add();
    const child = add({ parentId: parent });
    const teammateChild = add({ parentId: parent }, "chenmo");
    expect(() => run(remove("cancel", parent))).toThrow("不能连带取消");
    expect(() => run(remove("delete", parent))).toThrow("有下级工作项");
    expect(find(child).status).toBe("todo");
    accept(remove("cancel", teammateChild), "chenmo");
    accept(remove("cancel", parent));
    expect(find(child).cancellation?.rootId).toBe(parent);
    expect(find(teammateChild).cancellation?.rootId).toBe(teammateChild);

    const withAttachment = add();
    accept({ type: "uploadAttachment", id: withAttachment, name: "note.txt", mime: "text/plain", size: 8 });
    expect(() => run(remove("delete", withAttachment))).toThrow("有关联附件");
  });
});

describe("命令权限与输入边界", () => {
  it("拒绝未登录和停用账号", () => {
    expect(() => run({ type: "postUpdate", id: "T2b", text: "x" }, "unknown")).toThrow("未登录");
    state.accounts.find((a) => a.id === "zhouhang")!.active = false;
    expect(() => run({ type: "setStatus", id: "T2b", status: "doing" })).toThrow("停用");
  });
  it("同项目的非执行人不能修改进度、状态或提交", () => {
    for (const cmd of [{ type: "postUpdate", id: "T2b", text: "x", progress: 50 }, { type: "setStatus", id: "T2b", status: "doing" }, { type: "submit", id: "T2b", deliverable: "https://example.com", note: "" }]) expect(() => run(cmd, "wanglei")).toThrow("执行人");
  });
  it("没有项目菜单时，即使是执行人也不能写", () => {
    state.accounts.find((a) => a.id === "zhouhang")!.menus = [];
    expect(() => run({ type: "setStatus", id: "T2b", status: "doing" })).toThrow("无访问权限");
  });
  it("拒绝不可见项目的读写", () => {
    state.items.push({ ...item(), id: "SECRET", parentId: null, kind: "project", owner: "chenmo", assignee: "chenmo", verifiers: [], members: [] });
    expect(() => run({ type: "edit", id: "SECRET", patch: { title: "steal" } })).toThrow("无访问权限");
    expect(clientState(state, "zhouhang").items.some((i) => i.id === "SECRET")).toBe(false);
  });
  it("成员不能管理账号和规则", () => {
    expect(() => run({ type: "setAccount", id: "zhouhang", account: state.accounts.find((a) => a.id === "zhouhang") })).toThrow("系统设置");
    expect(() => run({ type: "setRule", id: "stale", patch: { n: 1 } })).toThrow("系统设置");
  });
  it.each(["disable", "remove-settings"])("保留最后一个管理员：%s", (action) => {
    const a = structuredClone(state.accounts.find((a) => a.id === "chenmo")!);
    if (action === "disable") a.active = false; else a.menus = a.menus.filter((m) => m !== "settings");
    expect(() => run({ type: "setAccount", id: a.id, account: a }, "chenmo")).toThrow("至少要保留");
  });
  it("存在另一启用管理员时允许停用管理员", () => {
    state.accounts = state.accounts.map((a) => a.id === "linyue" ? applyRole(a, "admin") : a);
    const a = { ...state.accounts.find((a) => a.id === "chenmo")!, active: false };
    expect(run({ type: "setAccount", id: a.id, account: a }, "chenmo").result.ok).toBe(true);
  });
  it("访客不能新建项目或拆分别人的任务", () => {
    expect(() => run({ type: "addItem", item: { parentId: null, kind: "project", title: "x", owner: "guest", due: "2026-12-01" } }, "guest")).toThrow("新建项目权限");
    expect(() => run({ type: "addItem", item: { parentId: "P1", kind: "task", title: "x", owner: "guest", due: "2026-12-01" } }, "guest")).toThrow("执行人");
  });
  it("项目负责人可管理自己的项目，包括成员列表", () => {
    state.items.find((x) => x.id === "P1")!.owner = "zhouhang";
    const r = run({ type: "edit", id: "P1", patch: { members: ["guest"] } });
    expect(r.state.items.find((x) => x.id === "P1")!.members).toEqual(["guest"]);
  });
  it("任务负责人可编辑并转交本项，普通执行人可推进任务但不能编辑属性", () => {
    const id = "T2c"; // 周航负责，许诺执行
    expect(() => run({ type: "edit", id, patch: { title: "新标题" } }, "xunuo")).toThrow("编辑属性");
    accept({ type: "setStatus", id, status: "doing" }, "xunuo");
    accept({ type: "postUpdate", id, text: "说明", progress: 30 }, "xunuo");
    expect(run({ type: "submit", id, deliverable: "https://example.com", note: "" }, "xunuo").result.ok).toBe(true);

    expect(() => run({ type: "edit", id: "F1", patch: { title: "需求标题" } })).toThrow("编辑属性");
    expect(() => run({ type: "cancel", id, reason: "测试原因" })).toThrow("项目负责人");
    accept({ type: "edit", id, patch: { title: "已更新任务", owner: "xunuo" } });
    expect(state.items.find((x) => x.id === id)?.title).toBe("已更新任务");
    expect(() => run({ type: "edit", id, patch: { title: "再次修改" } })).toThrow("编辑属性");
    expect(run({ type: "edit", id, patch: { title: "转交后修改" } }, "xunuo").result.ok).toBe(true);
  });
  it("计划可保留停用人员的历史指派，但不能新指派停用人员", () => {
    state.accounts.find((a) => a.id === "zhouhang")!.active = false;
    expect(run({ type: "edit", id: "T2b", patch: { title: "保留历史指派" } }, "chenmo").result.ok).toBe(true);
    expect(() => run({ type: "edit", id: "T2c", patch: { assignee: "zhouhang" } }, "chenmo")).toThrow("启用中的人员");
  });
  it("成员不能通过计划编辑改写审计、验收、状态、ID或父节点", () => {
    for (const patch of [{ status: "done" }, { progress: 100 }, { checks: [] }, { log: [] }, { id: "P1" }, { parentId: null }, { repos: ["evil/repo"] }, { checklist: [] }]) {
      expect(() => run({ type: "edit", id: "T2b", patch }, "chenmo")).toThrow("参数无效");
    }
  });
  it("账号命令不能重写身份字段或冒充另一个账号", () => {
    const a = state.accounts[0];
    expect(() => run({ type: "setAccount", id: a.id, account: { ...a, feishu_open_id: "evil" } }, "chenmo")).toThrow("参数无效");
    expect(() => run({ type: "setAccount", id: "chenmo", account: a }, "chenmo")).toThrow("ID 不匹配");
  });
  it("不能用 setStatus 绕过验收，也不能直接标需求完成", () => {
    state.items = state.items.map((x) => x.id === "T2b" ? { ...x, status: "review" } : x);
    expect(() => run({ type: "setStatus", id: "T2b", status: "done" })).toThrow("验证人验收");
    expect(() => run({ type: "setStatus", id: "F3", status: "done" }, "chenmo")).toThrow();
  });
  it("阻塞必须有原因；非叶子不能手改状态", () => {
    expect(() => run({ type: "setStatus", id: "T2b", status: "blocked", reason: " " })).toThrow("原因");
    expect(() => run({ type: "setStatus", id: "F1", status: "doing" }, "chenmo")).toThrow("子任务");
  });
  it("留言不带进度可以协作，访客不能关闭别人的缺陷", () => {
    expect(run({ type: "postUpdate", id: "T2b", text: "请看这里" }, "wanglei").result.ok).toBe(true);
    expect(() => run({ type: "addDefect", id: "T2b", defect: { title: "bug", owner: "zhouhang", severity: "P1", foundAt: "测试" } }, "guest")).toThrow("质量中心");
  });
  it("新建项目强制保留创建者可见性，检查项默认为空", () => {
    const cmd = { type: "addItem", item: { parentId: null, kind: "project", title: "new", owner: "linyue", due: "2026-12-01" } };
    const r = run(cmd);
    const added = r.state.items.find((x) => x.id === r.result.id)!;
    expect(added.members).toContain("zhouhang"); expect(added.checklist).toEqual([]);
    expect(() => run({ ...cmd, item: { ...cmd.item, checklist: [] } })).toThrow("参数无效");
  });
  it("项目负责人可维护检查项，修改后重新确认并保留操作记录", () => {
    const project = state.items.find((x) => x.id === "P1")!;
    project.owner = "zhouhang";
    project.checklist = [{ id: "c0", source: "项目上线", label: "旧检查项", done: true, doneBy: "chenmo", doneAt: "2026-11-01" }];
    const edit = { type: "saveProjectCheck", id: "P1", checkId: "c0", label: "交付清单已确认" } as const;
    expect(() => run(edit, "wanglei")).toThrow("项目负责人");
    expect(() => run({ ...edit, id: "F1" }, "chenmo")).toThrow("仅支持");
    accept(edit);
    accept({ type: "saveProjectCheck", id: "P1", label: "核对 P0 / P1 报告" });
    const updated = state.items.find((x) => x.id === "P1")!;
    expect(updated.checklist[0]).toEqual({ id: "c0", label: edit.label, source: "自定义", done: false });
    expect(openChecks(state.items, updated)).toHaveLength(2);
    expect(() => run({ type: "saveProjectCheck", id: "P1", label: edit.label })).toThrow("同名");
    accept({ type: "deleteProjectCheck", id: "P1", checkId: "c0" });
    const remaining = state.items.find((x) => x.id === "P1")!;
    expect(remaining.checklist.map((c) => c.label)).toEqual(["核对 P0 / P1 报告"]);
    expect(remaining.log.at(-1)?.text).toBe("删除检查项「交付清单已确认」");
  });

  it("普通任务可拆一次，已有子任务不能再创建下级", () => {
    const child = accept({ type: "addItem", item: { parentId: "T2", kind: "task", title: "补充测试", owner: "chenmo", due: "2026-11-12" } }, "chenmo").result.id!;
    expect(() => run({ type: "addItem", item: { parentId: child, kind: "task", title: "再拆一层", owner: "chenmo", due: "2026-11-12" } }, "chenmo")).toThrow("子任务下不能继续拆分");
  });

  it("进度按日期算出的工作日加权，全部在周末时仍可显示进度", () => {
    expect(workingDays("2026-11-13", "2026-11-16")).toBe(2);
    expect(workingDays("2026-11-14", "2026-11-15")).toBe(0);
    const project: WorkItem = { ...item(), id: "project", kind: "project", parentId: null };
    const first = { ...item(), id: "first", parentId: project.id, start: "2026-11-13", due: "2026-11-16", progress: 0, estimate: 99 };
    const second = { ...item(), id: "second", parentId: project.id, start: "2026-11-16", due: "2026-11-16", progress: 90, estimate: 1 };
    expect(progressOf([project, first, second], project)).toBe(30);
    const weekend = { start: "2026-11-14", due: "2026-11-15" };
    expect(progressOf([project, { ...first, ...weekend }, { ...second, ...weekend }], project)).toBe(45);
  });

  it("项目忽略历史手填百分比，允许发布文字并从下级汇总", () => {
    const project: WorkItem = { ...item(), id: "PNEW", kind: "project", parentId: null, progress: 100, status: "doing" };
    state.items.push(project);
    expect(progressOf(state.items, project)).toBe(0);
    expect(needsSubmission(state.items, project)).toBe(false);
    expect(() => run({ type: "postUpdate", id: project.id, text: "同步进度", progress: 50 })).toThrow("汇总");
    accept({ type: "postUpdate", id: project.id, text: "同步联调情况" });
    const updated = state.items.find((x) => x.id === project.id)!;
    expect(updated.updates.at(-1)).toMatchObject({ text: "同步联调情况", progress: undefined });
    state.items.push({ ...item(), id: "PNEW-T", parentId: project.id, progress: 40, status: "doing" });
    expect(progressOf(state.items, updated)).toBe(40);
  });

  it("未知命令和畸形数据被拒绝，失败不污染输入", () => {
    const before = JSON.stringify(state);
    expect(() => run({ type: "patch", id: "T2b", patch: {} })).toThrow(CommandError);
    expect(() => run({ type: "postUpdate", id: "T2b", text: "x", progress: 101 })).toThrow(CommandError);
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe("提交、打回、重新提交和验收", () => {
  it("完整流程留痕、记录返工并由独立验证人验收", () => {
    const original = structuredClone(state);
    accept({ type: "submit", id: "T2b", deliverable: "https://example.com/pr/1", note: "做完" });
    expect(item().status).toBe("review"); expect(item().reviewSince).toBe("2026-11-06");
    expect(original.items.find((i) => i.id === "T2b")!.status).toBe("doing");
    expect(() => run({ type: "verify", id: "T2b", pass: true, note: "" })).toThrow("验证人");
    expect(() => run({ type: "verify", id: "T2b", pass: false, note: " " }, "chenmo")).toThrow("原因");
    accept({ type: "verify", id: "T2b", pass: false, note: "补边界用例" }, "chenmo");
    expect(item().status).toBe("doing"); expect(item().rework).toBe(1); expect(item().checks.at(-1)?.note).toBe("补边界用例");
    accept({ type: "submit", id: "T2b", deliverable: "https://example.com/pr/1", note: "已补" });
    accept({ type: "verify", id: "T2b", pass: true, note: "通过" }, "chenmo");
    expect(item().status).toBe("done"); expect(item().doneAt).toBe("2026-11-06"); expect(item().checks).toHaveLength(2);
  });
  it("管理员没有被指定为验证人时，不能验收自己执行的任务", () => {
    Object.assign(item(), { assignee: "chenmo", status: "review", verifiers: ["linyue"] });
    expect(() => run({ type: "verify", id: "T2b", pass: true, note: "" }, "chenmo")).toThrow("验证人");
  });
  it("未提交的工作不能验收，非验证人不能验收", () => {
    expect(() => run({ type: "verify", id: "T2b", pass: true, note: "" }, "chenmo")).toThrow("尚未提交");
    item().status = "review";
    expect(() => run({ type: "verify", id: "T2b", pass: true, note: "" }, "wanglei")).toThrow("验证人");
  });
  it("需求和任务都能将执行人设为唯一验证人，项目仍要求独立验证人", () => {
    for (const id of ["F1", "T2b"]) {
      const x = state.items.find((x) => x.id === id)!;
      accept({ type: "edit", id, patch: { verifiers: [x.assignee] } }, "chenmo");
      expect(state.items.find((x) => x.id === id)?.verifiers).toEqual([x.assignee]);
    }
    const project = state.items.find((x) => x.id === "P1")!;
    expect(() => run({ type: "edit", id: project.id, patch: { verifiers: [project.assignee] } }, "chenmo")).toThrow("验证人不能只有执行人自己");
  });
  it("任务由执行人提交后，可进入自己的验收待办并完成验收", () => {
    item().verifiers = ["zhouhang"];
    accept({ type: "submit", id: "T2b", deliverable: "https://example.com/pr/1", note: "" });
    expect(myQueue(state, "zhouhang", "2026-11-06").find(({ x }) => x.id === "T2b")?.r.text).toBe("等你验收");
    accept({ type: "verify", id: "T2b", pass: true, note: "检查完成" });
    expect(item().status).toBe("done");
    expect(item().checks.at(-1)).toMatchObject({ by: "zhouhang", result: "通过" });
  });
  it("缺失交付物、缺失验证人和未知验证人被拒绝", () => {
    expect(() => run({ type: "submit", id: "T2b", deliverable: " ", note: "" })).toThrow();
    item().verifiers = []; state.items.find((x) => x.id === "F1")!.verifiers = [];
    expect(() => run({ type: "submit", id: "T2b", deliverable: "link", note: "" })).toThrow("至少一位验证人");
    expect(() => run({ type: "submit", id: "T2b", deliverable: "link", note: "", verifiers: ["missing"] })).toThrow("启用中的人员");
  });
  it("自动检查项不能手动勾，未完成检查不能验收", () => {
    const x: WorkItem = { ...item(), id: "FEATURE", kind: "feature", checklist: buildChecklist("feature"), status: "review" };
    state.items.push(x);
    const auto = x.checklist.find((c) => c.label.includes("P0 / P1"))!;
    expect(() => run({ type: "toggleCheck", id: x.id, checkId: auto.id }, "chenmo")).toThrow("自动检查项");
    expect(() => run({ type: "verify", id: x.id, pass: true, note: "" }, "chenmo")).toThrow("检查项");
  });
});

describe("新建需求的验收与交付检查", () => {
  const create = (overrides: Partial<Extract<Command, { type: "addItem" }>["item"]> = {}) => accept({
    type: "addItem", item: {
      kind: "feature", parentId: "P1", title: "验证达人筛选流程", owner: "zhouhang", verifiers: ["linyue"],
      due: "2026-11-20", ...overrides,
    },
  }, "chenmo").result.id!;
  const get = (id: string) => state.items.find((entry) => entry.id === id)!;
  const submit = (id: string) => ({ type: "submit", id, deliverable: "https://example.com/samples", note: "" } as const);
  const verify = (id: string) => ({ type: "verify", id, pass: true, note: "" } as const);

  it("不添加默认检查项，填验收标准后可直接完成测试验收", () => {
    const legacy = structuredClone(get("F1").checklist);
    const id = create({ acceptance: ["  "] });
    expect(get(id).checklist).toEqual([]);
    expect(visibleChecks(state.items, get(id))).toEqual([]);
    expect(() => run(submit(id))).toThrow("请先填写验收标准");
    accept({ type: "edit", id, patch: { acceptance: ["用约定数据跑通流程"] } }, "chenmo");
    accept(submit(id));
    accept(verify(id), "linyue");
    expect(get(id)).toMatchObject({ status: "release", productionRequired: true, checks: [{ type: "测试验收", result: "通过" }] });
    expect(get("F1").checklist).toEqual(legacy);
  });

  it("代码评审和测试独立启用，停用检查保留确认记录", () => {
    const id = create({ acceptance: ["功能测试通过"], verifiers: ["zhouhang", "linyue"], deliveryChecks: ["code-review"] });
    expect(openChecks(state.items, get(id)).map((check) => check.id)).toEqual(["code-review"]);
    expect(() => run({ type: "toggleCheck", id, checkId: "code-review" })).toThrow("执行人以外");
    accept({ type: "toggleCheck", id, checkId: "code-review" }, "linyue");
    accept({ type: "edit", id, patch: { deliveryChecks: ["testing"] }, expected: { deliveryChecks: ["code-review"] } }, "chenmo");
    expect(get(id).checklist.find((check) => check.id === "code-review")).toMatchObject({ required: false, doneBy: "linyue", done: true });
    expect(openChecks(state.items, get(id)).map((check) => check.id)).toEqual(["testing"]);
    expect(() => run({ type: "edit", id, patch: { deliveryChecks: [] }, expected: { deliveryChecks: ["code-review"] } }, "chenmo")).toThrow("交付检查已被其他人更新");
    accept(submit(id));
    expect(() => run(verify(id), "linyue")).toThrow("测试通过");
    accept({ type: "toggleCheck", id, checkId: "testing" }, "linyue");
    accept(verify(id), "linyue");
  });

  it("子任务全完成后等待整体验收，且未关闭的 P1 缺陷会拦截", () => {
    const id = create();
    const child = accept({ type: "addItem", item: {
      kind: "task", parentId: id, title: "核对样本", owner: "zhouhang", due: "2026-11-20",
    } }).result.id!;
    accept({ type: "addDefect", id: child, defect: { title: "关键字段缺失", severity: "P1", foundAt: "测试", owner: "zhouhang" } });
    accept({ type: "setStatus", id: child, status: "done" });
    expect(statusOf(state.items, get(id))).toBe("review");
    expect(() => run(verify(id), "linyue")).toThrow("请先填写验收标准");
    accept({ type: "edit", id, patch: { acceptance: ["子任务结果汇总后抽样通过"] } }, "chenmo");
    expect(get(id).checklist).toEqual([]);
    expect(visibleChecks(state.items, get(id)).some((check) => check.id === "blocking-defects")).toBe(true);
    expect(() => run(verify(id), "linyue")).toThrow("P1「关键字段缺失」尚未关闭");
    accept({ type: "fixDefect", id: child, defectId: get(child).defects[0].id });
    expect(visibleChecks(state.items, get(id))).toEqual([]);
    expect(statusOf(state.items, get(id))).toBe("review");
    accept(verify(id), "linyue");
    expect(statusOf(state.items, get(id))).toBe("release");
  });

  it("仓库评审和测试记录自动满足交付检查，合并仍需测试验收", () => {
    const id = create({ acceptance: ["可以按约定条件筛选"], verifiers: ["zhouhang"], deliveryChecks: ["code-review", "testing"] });
    const event = {
      id: "event", repo: "company/approval-web", ref: id, number: 1, url: "https://example.com/pulls/1",
      receivedAt: "2026-11-06T09:00:00Z", verified: true,
    };
    for (const kind of ["pr_approved", "pr_tested", "pr_merged"] as const) {
      const synced = applyRepoEvent(state.items, state.accounts, { ...event, kind }, "2026-11-06", state.people);
      expect(synced.record.status).toBe("applied");
      state.items = synced.items;
    }
    expect(openChecks(state.items, get(id))).toEqual([]);
    expect(statusOf(state.items, get(id))).toBe("review");
    accept(verify(id));
    expect(get(id).checks.at(-1)?.type).toBe("测试验收");
  });
});

describe("生产发布与线上验收", () => {
  const get = (id: string) => state.items.find((entry) => entry.id === id)!;
  const create = () => accept({
    type: "addItem", item: {
      kind: "feature", parentId: "P1", title: "需上线需求", owner: "zhouhang", assignees: ["zhouhang", "xunuo"], verifiers: ["linyue"],
      acceptance: ["线上筛选结果正确"], due: "2026-11-20",
    },
  }, "chenmo").result.id!;
  const submit = (id: string) => accept({ type: "submit", id, deliverable: "https://example.com/test", note: "" });
  const testPass = (id: string) => accept({ type: "verify", id, pass: true, note: "" }, "linyue");
  const publish = (id: string) => ({ type: "publish", id, version: "v2.3.0", cycle: get(id).releaseCycle!.id } as const);
  const online = (id: string, pass = true) => ({ type: "verifyProduction", id, publicationId: get(id).publication!.id, pass, note: pass ? "" : "线上数据未刷新" } as const);
  const status = (id: string) => statusOf(state.items, get(id));

  it("执行人发布、验收人线上确认，线上通过后写入完成时间", () => {
    const id = create();
    submit(id);
    expect(() => run({ type: "verify", id, pass: true, note: "" }, "chenmo")).toThrow("指定的验收人");
    testPass(id);
    expect(status(id)).toBe("release");
    expect(get(id).doneAt).toBeUndefined();
    expect(myQueue(state, "xunuo", "2026-11-06").find(({ x }) => x.id === id)?.r.text).toBe("等你发布到生产");
    expect(() => run(publish(id), "linyue")).toThrow("只有执行人");
    expect(run(publish(id), "zhouhang").result.ok).toBe(true);
    accept(publish(id), "xunuo");
    expect(status(id)).toBe("production-review");
    expect(get(id).publication).toMatchObject({ version: "v2.3.0", by: "xunuo" });
    expect(() => run(online(id), "xunuo")).toThrow("指定的验收人");
    expect(myQueue(state, "linyue", "2026-11-06").find(({ x }) => x.id === id)?.r.text).toBe("等你线上验收");
    accept(online(id), "linyue");
    expect(status(id)).toBe("done");
    expect(get(id).doneAt).toBe("2026-11-06");
    expect(get(id).checks.slice(-2).map((check) => check.type)).toEqual(["测试验收", "线上验收"]);
  });

  it("发布失败和回滚留在待发布，过时发布登记或线上验收无法覆盖当前轮次", () => {
    const id = create();
    submit(id);
    testPass(id);
    const initial = publish(id);
    accept({ type: "recordReleaseIssue", id, cycle: initial.cycle, publicationId: null, note: "部署流水线失败" }, "xunuo");
    expect(status(id)).toBe("release");
    accept(initial, "xunuo");
    const stale = online(id);
    accept({ type: "recordReleaseIssue", id, cycle: initial.cycle, publicationId: stale.publicationId, note: "已恢复旧版本" }, "xunuo");
    expect(status(id)).toBe("release");
    expect(() => run(initial, "xunuo")).toThrow("发布轮次已变化");
    accept(publish(id), "xunuo");
    expect(() => run(stale, "linyue")).toThrow("生产版本或状态已变化");
    accept(online(id, false), "linyue");
    expect(status(id)).toBe("doing");
    expect(get(id).log.some((entry) => entry.text.includes("线上数据未刷新"))).toBe(true);
    expect(() => run(publish(id), "xunuo")).toThrow();
    submit(id);
    testPass(id);
    expect(status(id)).toBe("release");
  });

  it("子任务整体验收、修复后的重新验收与 Gitea 合并保持发布门槛", () => {
    const id = create();
    const child = accept({ type: "addItem", item: {
      kind: "task", parentId: id, title: "实现筛选", owner: "zhouhang", due: "2026-11-20",
    } }).result.id!;
    accept({ type: "setStatus", id: child, status: "done" });
    expect(status(id)).toBe("review");
    testPass(id);
    const merged = applyRepoEvent(state.items, state.accounts, {
      id: "release-pr", kind: "pr_merged", repo: "company/approval-web", ref: id, number: 12, receivedAt: "2026-11-06T09:00:00Z", verified: true,
    }, "2026-11-06", state.people);
    state.items = merged.items;
    expect(status(id)).toBe("release");
    accept(publish(id), "xunuo");
    accept(online(id, false), "linyue");
    expect(status(id)).toBe("doing");
    accept({ type: "setStatus", id: child, status: "doing" });
    accept({ type: "setStatus", id: child, status: "done" });
    expect(status(id)).toBe("review");
    testPass(id);
    expect(status(id)).toBe("release");
  });

  it("飞书交接按当前角色和版本发送，逾期催办切换接收人，打回通知执行人", () => {
    const id = create();
    const now = new Date("2026-11-06T03:00:00Z");
    const later = new Date("2026-11-09T03:00:00Z");
    const notices = (before: AppState, actorId: string, rejected = false) =>
      collectHandoffs(before, state, { id: "delivery", actorId, rejected }, now).filter((notice) => notice.itemId === id);
    const reminders = () => planRiskNotices(state, later).filter((notice) => notice.itemId === id && notice.objectId === `review:${id}`);
    submit(id);
    const beforeTesting = state;
    testPass(id);
    const releaseNotices = notices(beforeTesting, "linyue");
    expect(releaseNotices.map((notice) => notice.recipient).sort()).toEqual(["account:xunuo", "account:zhouhang"]);
    const release = releaseNotices.find((notice) => notice.recipient === "account:xunuo")!;
    expect(release.handoff?.kind).toBe("release_requested");
    expect(reminders()).toContainEqual(expect.objectContaining({ recipient: "account:xunuo" }));
    const beforeRelease = state;
    accept(publish(id), "xunuo");
    const [production] = notices(beforeRelease, "xunuo");
    expect(production).toMatchObject({ recipient: "account:linyue", handoff: { kind: "production_review_requested" } });
    expect(validHandoff(state, release, "2026-11-06")).toBeUndefined();
    expect(reminders()).toContainEqual(expect.objectContaining({ recipient: "account:linyue" }));
    const beforeOnline = state;
    accept(online(id, false), "linyue");
    expect(validHandoff(state, production, "2026-11-06")).toBeUndefined();
    expect(notices(beforeOnline, "linyue", true)).toContainEqual(expect.objectContaining({ recipient: "account:zhouhang", handoff: expect.objectContaining({ kind: "review_rejected" }) }));
  });
});

describe("仓库管理与状态投影", () => {
  it("只有管理者能绑定或忽略仓库事件", () => {
    expect(() => run({ type: "bindRepo", id: "P1", repo: "org/new" })).toThrow("项目负责人");
    expect(() => run({ type: "bindRepo", id: "P1", repo: "COMPANY/APPROVAL-WEB" }, "chenmo")).toThrow("已经绑定");
  });
  it("绑定后补处理未绑定事件；禁止重复手动应用", () => {
    state.repoEvents = [{ id: "e", kind: "pr_open", verified: true, receivedAt: "2026-11-06T00:00:00Z", repo: "org/new", ref: "T2b", status: "unbound", result: "" }];
    accept({ type: "bindRepo", id: "P1", repo: "https://git.example.com/org/new.git" }, "chenmo");
    expect(item().status).toBe("review"); expect(state.repoEvents[0].status).toBe("applied");
    expect(() => run({ type: "linkRepoEvent", eventId: "e", itemId: "T2b" }, "chenmo")).toThrow("未关联");
  });
  it("非管理员只能拿自己的权限、可见子树和可见提醒", () => {
    const snapshot = clientState(state, "guest");
    expect(snapshot.accounts.map((a) => a.id)).toEqual(["guest"]);
    const all = new Set(snapshot.items.map((i) => i.id));
    expect(snapshot.alerts.every((a) => all.has(a.itemId))).toBe(true);
    expect(snapshot.items.filter((i) => i.parentId && !all.has(i.parentId))).toHaveLength(0);
    expect(JSON.stringify(snapshot)).not.toContain("feishuOpenId");
  });
});

describe("项目需求与任务计数", () => {
  it("按汇总状态统计所有层级，只纳入进行中与未开始", () => {
    const project = { ...state.items.find((x) => x.id === "P1")!, id: "P" };
    const example = item();
    const rows: WorkItem[] = [
      project,
      { ...example, id: "F", parentId: "P", kind: "feature", status: "todo" },
      { ...example, id: "A", parentId: "F", status: "doing" },
      { ...example, id: "B", parentId: "F", status: "todo" },
      { ...example, id: "C", parentId: "B", status: "todo" },
      { ...example, id: "V", parentId: "P", status: "review" },
      { ...example, id: "R", parentId: "P", status: "release" },
      { ...example, id: "O", parentId: "P", status: "production-review" },
      { ...example, id: "D", parentId: "P", status: "done" },
      { ...example, id: "X", parentId: "P", status: "cancelled" },
      { ...example, id: "Y", parentId: "X", status: "doing" },
      { ...example, id: "Z", parentId: "P", status: "blocked" },
    ];
    expect(projectWorkCounts(rows, "P")).toEqual({ doing: 2, todo: 2 });
    expect(projectWorkCounts([project], "P")).toEqual({ doing: 0, todo: 0 });
  });
});

describe("工作项移动", () => {
  const order = (id: string) => childrenOf(state.items, id).map((x) => x.id);
  const reorder = { type: "moveItem", id: "F2", fromParentId: "P1", targetId: "F1", placement: "before" } as const;
  const reparent = { type: "moveItem", id: "T2b", fromParentId: "T2", targetId: "F2", placement: "inside" } as const;

  it("同级重排保留父子关系，新工作项置顶后保留已有手动顺序", () => {
    const original = order("P1");
    accept(reorder, "chenmo");
    expect(order("P1")).toEqual(["F2", ...original.filter((id) => id !== "F2")]);
    expect(order("F2")).toEqual(["T5", "T6", "T7", "T8"]);
    const added = accept({ type: "addItem", item: { parentId: "P1", kind: "task", title: "新任务", owner: "chenmo", due: "2026-11-20" } }, "chenmo");
    expect(order("P1")).toEqual([added.result.id, "F2", ...original.filter((id) => id !== "F2")]);
  });

  it("拒绝非管理者、过期归属、跨上级的排序目标", () => {
    expect(() => run(reorder, "zhouhang")).toThrow("项目负责人");
    expect(() => run({ ...reorder, fromParentId: "F1" }, "chenmo")).toThrow("原归属已变更");
    expect(() => run({ ...reorder, targetId: "T2b" }, "chenmo")).toThrow("不在所选归属");
  });

  it("更换上级需确认，保留原迭代与任务状态，并在新上级下排到末尾", () => {
    state.items.find((x) => x.id === "F2")!.iteration = "backlog";
    const oldIteration = iterationIdOf(state.items, item());
    expect(oldIteration).not.toBe(iterationIdOf(state.items, state.items.find((x) => x.id === "F2")!));
    const previous = item();
    expect(() => run(reparent, "chenmo")).toThrow("请确认");
    accept({ ...reparent, confirmed: true }, "chenmo");
    expect(order("T2")).not.toContain("T2b");
    expect(order("F2").at(-1)).toBe("T2b");
    expect(item()).toMatchObject({ parentId: "F2", status: previous.status, progress: previous.progress, assignee: previous.assignee });
    expect(iterationIdOf(state.items, item())).toBe(oldIteration);
    expect(item().log.at(-1)?.text).toContain("归属从");
    expect(() => run({ ...reparent, confirmed: true }, "chenmo")).toThrow("原归属已变更");
  });

  it.each(["before", "after"] as const)("转移时可在新归属内指定位置：%s", (placement) => {
    accept({ type: "addItem", item: { parentId: "T7", kind: "task", title: "同组锚点", owner: "chenmo", due: "2026-11-20" } }, "chenmo");
    const anchor = order("T7")[0];
    const move = { ...reparent, targetId: anchor, toParentId: "T7", placement };
    expect(() => run(move, "chenmo")).toThrow("请确认转移");
    expect(() => run({ ...move, toParentId: "F2", confirmed: true }, "chenmo")).toThrow("不在所选归属");
    accept({ ...move, confirmed: true }, "chenmo");
    expect(order("T2")).not.toContain("T2b");
    expect(order("T7")).toEqual(placement === "before" ? ["T2b", anchor] : [anchor, "T2b"]);
    expect(item().parentId).toBe("T7");
  });

  it.each([["F6", "T17", "review"], ["F7", "T19", "done"]] as const)(
    "进行中的任务可转入飞书机器人接入或 IT 知识库同步：%s", (targetId, anchorId, currentStatus) => {
      // 飞书机器人接入的任务做完后仍有未完成的需求检查项。
      state.items.find((x) => x.id === "T18")!.status = "done";
      const destination = state.items.find((x) => x.id === targetId)!;
      expect(statusOf(state.items, destination)).toBe(currentStatus);
      const move = { type: "moveItem", id: "T15", fromParentId: "F5", targetId: anchorId, toParentId: targetId, placement: "before" } as const;
      expect(() => run(move, "chenmo")).toThrow("请确认转移");
      accept({ ...move, confirmed: true }, "chenmo");
      expect(order(targetId).slice(0, 2)).toEqual(["T15", anchorId]);
      expect(state.items.find((x) => x.id === "T15")).toMatchObject({ parentId: targetId, status: "doing" });
      expect(statusOf(state.items, destination)).toBe("doing");
    },
  );

  it("拒绝跨项目、向自己移动、嵌套到子任务或移动非末级/验收中的任务", () => {
    const blocked = [
      { targetId: "T2b" },
      { targetId: "T2c" },
      { id: "T2", fromParentId: "F1" },
      { id: "T6", fromParentId: "F2", targetId: "F1" },
      { targetId: state.items.find((i) => i.kind === "feature" && i.parentId !== "P1")!.id },
    ];
    for (const fields of blocked) expect(() => run({ ...reparent, ...fields, confirmed: true }, "chenmo")).toThrow();
  });
});
