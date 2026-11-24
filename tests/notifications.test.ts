import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeishuMessenger, messageCard } from "../src/lib/feishu/messages";
import { localTime, maySend, mergeNotices, planNotifications, scheduleDue } from "../src/lib/notifications/plan";
import { applyRepoEvent } from "../src/lib/repo-sync";
import { collectHandoffs } from "../src/lib/notifications/handoff";
import { applyCommand } from "../src/lib/commands";
import { demoState } from "../src/lib/demo";
import { requireNotificationAdmin } from "../src/lib/notifications/admin";

beforeEach(() => { vi.stubEnv("APP_TIMEZONE", "Asia/Shanghai"); vi.stubEnv("APP_BASE_URL", "https://arbor.example.com"); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
const at = (s: string) => new Date(`2026-11-${s}+08:00`);

describe("通知发送时间与规则", () => {
  it("免打扰边界与周末紧急等级，按业务时区", () => {
    expect(maySend("urgent", at("06T08:59:00"))).toBe(false);
    expect(maySend("info", at("06T09:00:00"))).toBe(true);
    expect(maySend("urgent", at("06T20:00:00"))).toBe(false);
    expect(maySend("info", at("06T19:59:00"))).toBe(true);
    expect(maySend("warn", at("07T10:00:00"))).toBe(false);
    expect(maySend("urgent", at("07T10:00:00"))).toBe(true);
    expect(maySend("urgent", at("08T10:00:00"))).toBe(true);
    expect(maySend("urgent", at("07T20:30:00"))).toBe(false);
    expect(localTime(new Date("2026-11-06T01:30:00Z")).minute).toBe(570);
    expect(localTime(new Date("2026-11-06T01:30:00Z"), "America/New_York").date).toBe("2026-11-05");
  });
  it("日报与周报触发边界、当天补发和周末", () => {
    expect(scheduleDue("daily", at("06T09:29:59"))).toBe(false);
    expect(scheduleDue("daily", at("06T09:30:00"))).toBe(true);
    expect(scheduleDue("daily", at("06T19:59:00"))).toBe(true);
    expect(scheduleDue("daily", at("06T20:00:00"))).toBe(false);
    expect(scheduleDue("daily", at("07T09:30:00"))).toBe(false);
    expect(scheduleDue("weekly", at("06T16:59:59"))).toBe(false);
    expect(scheduleDue("weekly", at("06T17:00:00"))).toBe(true);
    expect(scheduleDue("weekly", at("05T17:00:00"))).toBe(false);
    expect(scheduleDue("weekly", at("07T17:00:00"))).toBe(false);
  });
  it("管理员保存的发送时间用于实际调度，并遵守免打扰时段", () => {
    const state = demoState("2026-11-06");
    state.items.find((item) => item.kind === "project")!.feishuChatId = "oc_test";
    const ctx = { accountId: "chenmo", today: "2026-11-06", newId: "temp" };
    const configure = (id: string, scheduleTime: string) => ({ type: "setRule", id, patch: { scheduleTime } });
    const daily = applyCommand(state, ctx, configure("daily", "11:15")).state;
    const both = applyCommand(daily, ctx, configure("weekly", "18:20")).state;
    const has = (type: "daily" | "weekly", date: string) => planNotifications(both, at(date)).some((notice) => notice.type === type);

    expect(has("daily", "06T11:14:59")).toBe(false);
    expect(has("daily", "06T11:15:00")).toBe(true);
    expect(has("weekly", "06T18:19:59")).toBe(false);
    expect(has("weekly", "06T18:20:00")).toBe(true);
    expect(has("weekly", "06T20:00:00")).toBe(false);
    expect(has("weekly", "05T18:20:00")).toBe(false);
    expect(() => applyCommand(state, ctx, configure("daily", "19:56"))).toThrow();
    expect(() => applyCommand(state, ctx, configure("daily", "09:60"))).toThrow();
    expect(() => applyCommand(state, ctx, configure("blocked", "11:15"))).toThrow();
    expect(() => applyCommand(state, { ...ctx, accountId: "guest" }, configure("daily", "11:15"))).toThrow();
  });
  it("规则/渠道关闭不发，停用账号和无待办账号不收日报，周报仅绑定项目", () => {
    const state = demoState("2026-11-06");
    state.items.filter((x) => x.kind === "project")[0].feishuChatId = "oc_test";
    const notices = planNotifications(state, at("06T17:00:00"));
    expect(notices.some((n) => n.type === "event")).toBe(true);
    expect(notices.filter((n) => n.type === "weekly")).toHaveLength(1);
    expect(notices.some((n) => n.type === "daily")).toBe(true);
    state.accounts.forEach((a) => { a.active = false; });
    expect(planNotifications(state, at("06T17:00:00")).some((n) => n.recipient.startsWith("account:"))).toBe(false);
    state.rules.forEach((r) => { r.enabled = false; });
    expect(planNotifications(state, at("06T17:00:00"))).toEqual([]);
    state.rules.forEach((r) => { r.enabled = true; r.channels = []; });
    expect(planNotifications(state, at("06T17:00:00"))).toEqual([]);
  });
  it("无待办账号不产生每日摘要", () => {
    const state = demoState("2026-11-06");
    state.accounts = [{ ...state.accounts[0], id: "empty-account" }];
    expect(planNotifications(state, at("06T09:30:00")).some((n) => n.type === "daily")).toBe(false);
  });
  it("一条任务只占一行，优先保留交接与截止信息；每项都有直达链接", () => {
    const before = demoState("2026-11-06");
    const ctx = { accountId: "chenmo", today: "2026-11-06", newId: "batch" };
    const after = applyCommand(before, ctx, { type: "edit", id: "T2b", patch: { owner: "xunuo", assignees: ["xunuo"], due: "2026-11-07" } }).state;
    const now = at("06T17:00:00");
    const [handoff] = collectHandoffs(before, after, { id: "batch", actorId: "chenmo" }, now);
    expect(handoff.handoff).toEqual({ kind: "assign", roles: ["负责人", "执行人"] });
    const merged = mergeNotices([handoff, { ...handoff, type: "daily", report: {
      title: "今日待办", to: handoff.recipient, sections: [{ heading: "今天", lines: [
        { itemId: "T2b", text: "重复待办" }, { itemId: "T2c", text: "另一条待办" },
      ] }],
    }}]);
    expect(merged.sections.flatMap((s) => s.lines).map((l) => l.itemId)).toEqual(["T2b", "T2c"]);
    const card = JSON.stringify(messageCard(merged));
    expect(card).toContain("明天截止");
    expect(card).toContain("负责人、执行人");
    expect(card).toContain("https://arbor.example.com/item/T2b");
    expect(card).not.toContain("重复待办");
  });
  it("Gitea 首次进入待验收触发交接，同一轮 PR 更新不重发", () => {
    const before = demoState("2026-11-06");
    const now = at("06T10:00:00");
    const base = { repo: "company/approval-web", ref: "T2b", number: 42, url: "https://gitea.example/pr/42", sender: "zhouhang", verified: true, receivedAt: now.toISOString() };
    const opened = applyRepoEvent(before.items, before.accounts, { ...base, id: "pr-open", kind: "pr_open" }, "2026-11-06", before.people);
    const reviewing = { ...before, items: opened.items };
    expect(collectHandoffs(before, reviewing, { id: "pr-open", actorId: "zhouhang" }, now).some((n) => n.handoff?.kind === "review_requested")).toBe(true);
    const updated = applyRepoEvent(reviewing.items, before.accounts, { ...base, id: "pr-update", kind: "pr_update" }, "2026-11-06", before.people);
    expect(collectHandoffs(reviewing, { ...reviewing, items: updated.items }, { id: "pr-update", actorId: "zhouhang" }, now)).toEqual([]);
  });
  it("管理员接口权限与项目群字段权限", () => {
    const state = demoState("2026-11-06");
    expect(() => requireNotificationAdmin(state.accounts.find((a) => a.id === "guest")!)).toThrow("管理员");
    expect(() => requireNotificationAdmin(state.accounts.find((a) => a.menus.includes("settings"))!)).not.toThrow();
    const ctx = { accountId: "chenmo", today: "2026-11-06", newId: "temp" };
    expect(() => applyCommand(state, ctx, { type: "edit", id: "T2b", patch: { feishuChatId: "oc_invalid_node" } })).toThrow("只有项目");
    expect(() => applyCommand(state, { ...ctx, accountId: "guest" }, { type: "edit", id: "P1", patch: { feishuChatId: "oc_test" } })).toThrow();
    const changed = applyCommand(state, ctx, { type: "edit", id: "P1", patch: { feishuChatId: "oc_test" } });
    expect(changed.state.items.find((x) => x.id === "P1")?.feishuChatId).toBe("oc_test");
    expect(() => applyCommand(state, ctx, { type: "edit", id: "P1", patch: { feishuChatId: "群显示名" } })).toThrow();
  });
});

describe("飞书客户端", () => {
  it("演练模式不调用网络，包括缺失一个凭证或强制演练", async () => {
    const fetcher = vi.fn(); const client = new FeishuMessenger(fetcher);
    const card = messageCard({ title: "测试", to: "我", sections: [] });
    vi.stubEnv("FEISHU_APP_ID", ""); vi.stubEnv("FEISHU_APP_SECRET", "secret");
    expect((await client.send("open_id", null, card, "test")).status).toBe("dry_run");
    vi.stubEnv("FEISHU_APP_ID", "id");
    expect((await client.send("chat_id", "oc_test", card, "test", true)).status).toBe("dry_run");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("token 并发缓存，提前120秒刷新，凭证变更刷新", async () => {
    vi.stubEnv("FEISHU_APP_ID", "id"); vi.stubEnv("FEISHU_APP_SECRET", "secret");
    let now = 0;
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ code: 0, tenant_access_token: `t${fetcher.mock.calls.length}`, expire: 7200 }));
    const client = new FeishuMessenger(fetcher, () => now);
    expect(await Promise.all([client.tenantToken(), client.tenantToken()])).toEqual(["t1", "t1"]);
    now = 7079999; expect(await client.tenantToken()).toBe("t1");
    now = 7080000; expect(await client.tenantToken()).toBe("t2");
    vi.stubEnv("FEISHU_APP_SECRET", "new-secret"); expect(await client.tenantToken()).toBe("t3");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it("发送 open_id 和 chat_id 交互卡片，处理飞书业务错误而不抛出", async () => {
    vi.stubEnv("FEISHU_APP_ID", "id"); vi.stubEnv("FEISHU_APP_SECRET", "secret");
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ code: 0, tenant_access_token: "tok", expire: 7200 })).mockResolvedValueOnce(Response.json({ code: 0, data: { message_id: "om_test" } })).mockResolvedValueOnce(Response.json({ code: 230001 }));
    const client = new FeishuMessenger(fetcher);
    const card = messageCard({ title: "测试", to: "我", sections: [] });
    expect(await client.send("open_id", "ou_test", card, "uuid")).toEqual({ status: "sent", messageId: "om_test" });
    const request = JSON.parse(fetcher.mock.calls[1][1].body);
    expect(request.receive_id).toBe("ou_test"); expect(request.msg_type).toBe("interactive"); expect(JSON.parse(request.content)).toEqual(card);
    expect((await client.send("chat_id", "oc_test", card, "uuid2")).status).toBe("failed");
    expect(fetcher.mock.calls[2][0]).toContain("receive_id_type=chat_id");
  });
  it("保留飞书投递拒绝码供部署通知识别范围外用户", async () => {
    vi.stubEnv("FEISHU_APP_ID", "id"); vi.stubEnv("FEISHU_APP_SECRET", "secret");
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ code: 0, tenant_access_token: "tok", expire: 7200 }))
      .mockResolvedValueOnce(Response.json({ code: 230013 }, { status: 400 }))
      .mockResolvedValueOnce(Response.json({ code: 0, data: { message_id: "om_test" } }));
    const card = messageCard({ title: "Arbor 部署成功", to: "用户", sections: [] });
    const client = new FeishuMessenger(fetcher);
    expect(await client.send("open_id", "ou_outside", card, "uuid")).toMatchObject({ status: "failed", code: 230013 });
    expect(await client.send("open_id", "ou_inside", card, "uuid2")).toEqual({ status: "sent", messageId: "om_test" });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1][0]).toContain("/im/v1/messages?receive_id_type=open_id");
  });
});
