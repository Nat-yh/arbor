import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appTimezone, dateOffset, daysBetween, person, setAppTimezone, setPeople, today } from "../src/lib/model";
import { demoState } from "../src/lib/demo";
import { applyRepoEvent } from "../src/lib/repo-sync";
import { findRef, parseGiteaPayload, type RepoEvent } from "../src/lib/gitea";
import { verifyGiteaSignature } from "../src/lib/gitea-server";
import { computeAlerts } from "../src/lib/alerts";
import { exchangeCode, authorizationUrl, FEISHU_ENDPOINTS } from "../src/lib/feishu/oauth";
import { checkOrigin } from "../src/lib/http";

beforeEach(() => { setAppTimezone("Asia/Shanghai"); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("应用日期与人员注册", () => {
  it("同一时刻按应用时区取日期，跨 UTC 日期边界", () => {
    const instant = new Date("2026-11-05T17:01:00Z");
    expect(today(instant, "Asia/Shanghai")).toBe("2026-11-06");
    expect(today(instant, "UTC")).toBe("2026-11-05");
    expect(today(instant, "America/Los_Angeles")).toBe("2026-11-05");
    expect(today(new Date("2026-01-01T01:00:00Z"), "America/Los_Angeles")).toBe("2025-12-31");
  });
  it("客户端使用服务端传入的时区", () => {
    setAppTimezone("Pacific/Kiritimati");
    expect(appTimezone()).toBe("Pacific/Kiritimati");
    expect(today(new Date("2026-11-05T11:00:00Z"))).toBe("2026-11-06");
  });
  it("日期加减不受 DST 影响", () => {
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(dateOffset("2024-02-28", 1)).toBe("2024-02-29");
    expect(dateOffset("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("person 签名不变且人员可替换", () => {
    setPeople([{ id: "db-user", name: "数据库用户", title: "产品", kind: "pm", role: "member" }]);
    expect(person("db-user").name).toBe("数据库用户");
    expect(person("missing").id).toBe("missing");
  });
  it("远期演示数据保留逾期和即将到期", () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2030-06-15T04:00:00Z"));
    try {
      const state = demoState(); setPeople(state.people);
      const alerts = computeAlerts(state.items, state.rules);
      expect(alerts.some((a) => a.ruleId === "overdue")).toBe(true);
      expect(alerts.some((a) => a.ruleId === "due_soon")).toBe(true);
      expect(state.items[0].start.startsWith("2030")).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe("repo-sync 匹配与业务规则", () => {
  const sample = () => { const state = demoState("2026-11-06"); setPeople(state.people); return state; };
  const event = (kind: RepoEvent["kind"], patch: Partial<RepoEvent> = {}): RepoEvent => ({ id: "ev1", kind, receivedAt: "2026-11-06T00:00:00Z", verified: true, repo: "company/approval-web", ref: "T2b", number: 1, url: "https://git.example.com/company/approval-web/pulls/1", author: "zhouhang", sender: "xunuo", ...patch });
  it("提取分支、标题、正文的 BF 编号", () => {
    expect(findRef("feature/AR-T2b", "AR-T9")).toBe("T2b"); expect(findRef("nothing", "fix AR-T3")).toBe("T3"); expect(findRef(undefined, "foo", "AR-T6")).toBe("T6"); expect(findRef("ABC-AR- invalid")).toBeUndefined();
  });
  it("仓库未绑定不处理；无编号、未知编号进入未关联", () => {
    const s = sample();
    const a = applyRepoEvent(s.items, s.accounts, event("pr_open", { repo: "other/repo" }), "2026-11-06", s.people);
    expect(a.record.status).toBe("unbound"); expect(a.items).toBe(s.items);
    expect(applyRepoEvent(s.items, s.accounts, event("pr_open", { ref: undefined }), "2026-11-06", s.people).record.status).toBe("unlinked");
    expect(applyRepoEvent(s.items, s.accounts, event("pr_open", { ref: "none" }), "2026-11-06", s.people).record.status).toBe("unlinked");
  });
  it("跨项目仍同步并标记警告，编号大小写不敏感", () => {
    const s = sample();
    const target = s.items.find((x) => x.kind === "task" && x.parentId !== "F1" && x.status !== "done")!;
    s.items.push({ ...target, id: "CROSS", parentId: "OTHER" });
    s.items.push({ ...s.items[0], id: "OTHER", repos: [], members: [] });
    const r = applyRepoEvent(s.items, s.accounts, event("pr_open", { ref: "cross" }), "2026-11-06", s.people);
    expect(r.record.warning).toContain("任务在"); expect(r.record.status).toBe("applied"); expect(r.items.find((x) => x.id === "CROSS")!.status).toBe("review");
  });
  it("PR 提交带交付物，重复更新不追加重复提交记录", () => {
    const s = sample();
    const a = applyRepoEvent(s.items, s.accounts, event("pr_open"), "2026-11-06", s.people);
    const b = applyRepoEvent(a.items, s.accounts, event("pr_update"), "2026-11-07", s.people);
    const x = b.items.find((x) => x.id === "T2b")!;
    expect(x.status).toBe("review"); expect(x.deliverable).toContain("git.example.com"); expect(x.reviewSince).toBe("2026-11-06"); expect(x.updates.length).toBe(s.items.find((x) => x.id === "T2b")!.updates.length + 1);
  });
  it("本人审查不算（含未映射 Gitea 作者）", () => {
    const s = sample();
    for (const login of ["zhouhang", "unmapped-author"]) {
      const r = applyRepoEvent(s.items, s.accounts, event("pr_approved", { sender: login, author: login }), "2026-11-06", s.people);
      expect(r.record.result).toContain("本人"); expect(r.items.find((x) => x.id === "T2b")!.checks).toHaveLength(0);
    }
  });
  it("独立审查和测试通过分别记录", () => {
    const s = sample();
    const a = applyRepoEvent(s.items, s.accounts, event("pr_approved"), "2026-11-06", s.people);
    const b = applyRepoEvent(a.items, s.accounts, event("pr_tested"), "2026-11-06", s.people);
    expect(b.items.find((x) => x.id === "T2b")!.checks.map((c) => c.type)).toEqual(["代码评审", "自动化测试"]);
  });
  it("有产品验证人的合并等待业务验收，其余自动完成", () => {
    const s = sample();
    const a = applyRepoEvent(s.items, s.accounts, event("pr_merged"), "2026-11-06", s.people);
    expect(a.items.find((x) => x.id === "T2b")!.status).toBe("review");
    s.items.find((x) => x.id === "T2b")!.verifiers = ["xunuo"];
    const b = applyRepoEvent(s.items, s.accounts, event("pr_merged"), "2026-11-06", s.people);
    expect(b.items.find((x) => x.id === "T2b")!.status).toBe("done");
    Object.assign(s.items.find((x) => x.id === "T2b")!, { assignee: "chenmo", verifiers: ["chenmo"] });
    const self = applyRepoEvent(s.items, s.accounts, event("pr_merged"), "2026-11-06", s.people);
    expect(self.items.find((x) => x.id === "T2b")!.status).toBe("review");
  });
  it("关闭未合并记录返工，评论同步到动态", () => {
    const s = sample();
    const a = applyRepoEvent(s.items, s.accounts, event("pr_closed"), "2026-11-06", s.people);
    const x = a.items.find((x) => x.id === "T2b")!;
    expect(x.status).toBe("doing"); expect(x.rework).toBe(1); expect(x.checks[0].result).toBe("不通过");
    const b = applyRepoEvent(a.items, s.accounts, event("comment", { note: "补测试" }), "2026-11-06", s.people);
    expect(b.items.find((x) => x.id === "T2b")!.updates.at(-1)?.text).toContain("补测试");
  });
  it("CI 状态不覆盖 PR 关联，标签使用上下文", () => {
    const s = sample();
    const target = s.items.find((x) => x.id === "T2b")!;
    target.pr = { number: 42, url: "https://git.example.com/pulls/42", repo: "company/approval-web" };
    const parsed = parseGiteaPayload("status", null, { repository: { full_name: "company/approval-web" }, state: "success", branches: [{ name: "feature/AR-T2b" }], context: "build" }, true);
    const r = applyRepoEvent(s.items, s.accounts, parsed, "2026-11-06", s.people);
    const updated = r.items.find((x) => x.id === "T2b")!;
    expect(updated.pr).toEqual(target.pr);
    expect(updated.checks.at(-1)?.note).toBe("Gitea CI build 测试通过");
    expect(updated.log.at(-1)?.text).not.toContain("undefined");
  });
});

describe("Gitea 事件映射", () => {
  const body = { repository: { full_name: "org/repo" }, sender: { login: "reviewer" }, pull_request: { number: 3, title: "修复 AR-T3", body: "关联 AR-T4", html_url: "https://git.example.com/org/repo/pulls/3", user: { login: "author" }, head: { ref: "feature/AR-T2b" } } };
  it.each([
    ["opened", false, "pr_open"], ["synchronized", false, "pr_update"], ["reopened", false, "pr_update"],
    ["closed", true, "pr_merged"], ["closed", false, "pr_closed"],
    ["edited", true, "ignored"], ["assigned", false, "ignored"], ["label_updated", false, "ignored"], ["review_requested", false, "ignored"],
  ])("PR 动作 %s，merged=%s → %s", (action, merged, kind) => {
    const event = parseGiteaPayload("pull_request", null, { ...body, action, pull_request: { ...body.pull_request, merged } }, true, "固定时间");
    expect(event).toMatchObject({ kind, receivedAt: "固定时间", verified: true, repo: "org/repo", ref: "T2b", number: 3, title: body.pull_request.title, url: body.pull_request.html_url, branch: "feature/AR-T2b", author: "author", sender: "reviewer" });
    if (kind === "ignored") expect(event.note).toContain(action);
  });
  it.each(["approved", "rejected", "comment"])("审查 %s 从两个事件头或 review.type 识别", (type) => {
    const specific = `pull_request_review_${type}`;
    for (const [eventHeader, eventTypeHeader, reviewType] of [[specific, null, ""], ["pull_request", specific, ""], ["pull_request", null, type], ["pull_request", null, specific], ...(type === "comment" ? [] : [[`pull_request_${type}`, null, ""]])]) {
      const event = parseGiteaPayload(eventHeader, eventTypeHeader, { ...body, action: "reviewed", review: { type: reviewType, content: "补测试" } }, true);
      expect(event.kind).toBe(type === "approved" ? "pr_approved" : "comment");
      if (type !== "approved") expect(event.note).toBe(type === "rejected" ? "要求修改：补测试" : "补测试");
    }
  });
  it.each(["issue_comment", "pull_request_comment"])("%s 仅同步 PR 评论", (header) => {
    const payload = { repository: body.repository, sender: body.sender, issue: { number: 9, title: "AR-T9", body: "AR-T8" }, comment: { body: "补文档", html_url: "https://git.example.com/comment/1", user: { login: "commenter" } } };
    for (const patch of [{ is_pull: true }, { issue: { ...payload.issue, pull_request: {} } }]) {
      expect(parseGiteaPayload(header, null, { ...payload, ...patch }, true)).toMatchObject({ kind: "comment", ref: "T9", number: 9, title: "AR-T9", note: "补文档", url: payload.comment.html_url, sender: "commenter" });
    }
    expect(parseGiteaPayload(header, null, payload, true).kind).toBe("ignored");
    expect(parseGiteaPayload("pull_request", header, { ...payload, is_pull: true, action: "created" }, true)).toMatchObject({ kind: "comment", note: "补文档" });
    expect(parseGiteaPayload(header, null, { ...payload, is_pull: true, comment: { body: "评论" } }, true).sender).toBe("reviewer");
  });
  it("提交状态 success 同步，分支和两种提交消息都能关联", () => {
    for (const patch of [{ branches: [{ name: "feature/AR-T1" }] }, { commit: { commit: { message: "修复 AR-T1" } } }, { commit: { message: "修复 AR-T1" } }]) {
      const event = parseGiteaPayload("status", null, { ...body, ...patch, state: "success", target_url: "https://ci.example.com/1", context: "单测" }, true);
      expect(event).toMatchObject({ kind: "pr_tested", ref: "T1", url: "https://ci.example.com/1", note: "单测" });
      expect(event.number).toBeUndefined();
    }
    for (const state of ["failure", "error", "pending"]) expect(parseGiteaPayload("status", null, { ...body, state }, true).kind).toBe("ignored");
  });
  it("不支持的事件和空载荷被忽略", () => {
    expect(parseGiteaPayload("push", null, body, true)).toMatchObject({ kind: "ignored", note: "不处理的事件类型：push" });
    expect(parseGiteaPayload(null, null, null, true).kind).toBe("ignored");
  });
});

describe("Gitea 签名", () => {
  const secret = "unit-test-secret";
  const raw = '{ "内容": "原始请求体" }\n';
  const signature = createHmac("sha256", secret).update(raw).digest("hex");
  it.each(["X-Gitea-Signature", "X-Hub-Signature-256"])("接受 %s 并校验精确原文", (header) => {
    const headers = new Headers({ [header]: header === "X-Gitea-Signature" ? signature : `sha256=${signature}` });
    expect(verifyGiteaSignature(raw, headers, secret).ok).toBe(true);
    expect(verifyGiteaSignature(JSON.stringify(JSON.parse(raw)), headers, secret).ok).toBe(false);
    expect(verifyGiteaSignature(raw, headers, "")).toEqual({ ok: false, reason: "未配置 GITEA_WEBHOOK_SECRET" });
  });
  it("拒绝缺失、错误和畸形签名", () => {
    for (const value of ["", "bad", "0".repeat(64), signature + "zz", `sha256=${signature}`]) expect(verifyGiteaSignature(raw, new Headers({ "X-Gitea-Signature": value }), secret).ok).toBe(false);
    expect(verifyGiteaSignature(raw, new Headers({ "X-Hub-Signature-256": signature }), secret).ok).toBe(false);
  });
  it("两个头任一个有效即通过", () => {
    expect(verifyGiteaSignature(raw, new Headers({ "X-Gitea-Signature": "bad", "X-Hub-Signature-256": `sha256=${signature}` }), secret).ok).toBe(true);
  });
});

describe("OAuth 与跨站写入", () => {
  beforeEach(() => { vi.stubEnv("FEISHU_APP_ID", "cli_test"); vi.stubEnv("FEISHU_APP_SECRET", "secret"); vi.stubEnv("APP_BASE_URL", "https://arbor.example.com"); });
  it("授权带随机 state、固定回调，换码不把 secret 暴露在地址中", async () => {
    expect(FEISHU_ENDPOINTS.token).toBe("https://accounts.feishu.cn/oauth/v3/token");
    const url = new URL(authorizationUrl("nonce")); expect(url.searchParams.get("state")).toBe("nonce"); expect(url.searchParams.get("client_id")).toBe("cli_test"); expect(url.href).not.toContain("secret");
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, access_token: "user-token" }))).mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { open_id: "ou_1", union_id: "on_1", name: "张三" } })));
    vi.stubGlobal("fetch", fetch);
    const identity = await exchangeCode("auth-code");
    expect(identity.open_id).toBe("ou_1"); expect(fetch.mock.calls[0][0]).toBe(FEISHU_ENDPOINTS.token);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({ code: "auth-code", client_secret: "secret", redirect_uri: "https://arbor.example.com/api/auth/feishu/callback" });
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe("Bearer user-token");
  });
  it("拒绝换码失败和缺少 open_id 的响应", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 999, msg: "secret-detail" }))));
    await expect(exchangeCode("bad")).rejects.toThrow("换取凭证失败");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, access_token: "token" }))).mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { name: "x" } }))));
    await expect(exchangeCode("ok")).rejects.toThrow("用户信息失败");
  });
  it("拒绝跨站请求，允许同源与 CLI", () => {
    expect(() => checkOrigin(new Request("https://arbor.example.com/api/commands", { headers: { Origin: "https://evil.example.com" } }))).toThrow("跨站");
    expect(() => checkOrigin(new Request("https://arbor.example.com/api/commands", { headers: { Origin: "https://arbor.example.com" } }))).not.toThrow();
    expect(() => checkOrigin(new Request("https://arbor.example.com/api/commands"))).not.toThrow();
  });
});
