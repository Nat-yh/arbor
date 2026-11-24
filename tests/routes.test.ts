import { createHash, createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { demoState } from "../src/lib/demo";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ token: undefined as string | undefined, values: new Map<string, string>() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === "arbor_session" && fake.token ? { value: fake.token } : fake.values.has(name) ? { value: fake.values.get(name) } : undefined, set: (name: string, value: string) => { fake.values.set(name, value); } }) }));
vi.mock("next/server", async (original) => ({ ...await original<typeof import("next/server")>(), connection: async () => {} }));
import { GET as getState } from "../src/app/api/state/route";
import { POST as command } from "../src/app/api/commands/route";
import { POST as demoLogin } from "../src/app/api/auth/demo/route";
import { POST as demoReset } from "../src/app/api/demo/reset/route";
import { GET as callback } from "../src/app/api/auth/feishu/callback/route";
import { GET as getFeishu, POST as postFeishu } from "../src/app/api/admin/feishu/route";
import { POST as githubWebhook } from "../src/app/api/webhooks/github/route";
import { POST as gitlabWebhook } from "../src/app/api/webhooks/gitlab/route";
import { POST as giteeWebhook } from "../src/app/api/webhooks/gitee/route";
import { POST as webhook } from "../src/app/api/webhooks/gitea/route";

// 队列与事务的实际写入由 PostgreSQL 集成测试覆盖。
vi.mock("../src/lib/notifications/outbox", () => ({ persistHandoffs: vi.fn() }));
const database = vi.hoisted(() => ({ where: vi.fn(), raw: vi.fn(), load: vi.fn(), persist: vi.fn(), lock: vi.fn() }));
vi.mock("../src/lib/db/state", async (original) => ({
  ...await original<typeof import("../src/lib/db/state")>(),
  loadState: database.load,
  persistState: database.persist,
  withWriteLock: database.lock,
}));
import { proxy } from "../src/proxy";

beforeEach(() => { fake.token = undefined; fake.values.clear(); vi.unstubAllEnvs(); });
const request = (path: string, body = {}) => new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("路由边界（无需数据库的拒绝路径）", () => {
  it("未登录 state 和 commands 返回401", async () => {
    expect((await getFeishu()).status).toBe(401);
    expect((await postFeishu(request("/api/admin/feishu"))).status).toBe(401);
    expect((await getState()).status).toBe(401);
    expect((await command(request("/api/commands", { type: "setStatus" }))).status).toBe(401);
  });
  it.each([undefined, "false", "TRUE", "1"])("DEMO_MODE=%s 拒绝演示登录和重置", async (value) => {
    if (value === undefined) delete process.env.DEMO_MODE; else vi.stubEnv("DEMO_MODE", value);
    expect((await demoLogin(request("/api/auth/demo", { id: "chenmo" }))).status).toBe(404);
    expect((await demoReset(request("/api/demo/reset"))).status).toBe(404);
  });
  it("演示模式也拒绝跨站登录和非法身份请求", async () => {
    vi.stubEnv("DEMO_MODE", "true"); vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    expect((await demoLogin(new Request("http://localhost:3000/api/auth/demo", { method: "POST", headers: { Origin: "https://evil.example.com", "Content-Type": "application/json" }, body: '{"id":"chenmo"}' }))).status).toBe(403);
    expect((await demoLogin(request("/api/auth/demo", { id: "" }))).status).toBe(400);
  });
  it("OAuth state 缺失和不匹配都不会换取凭证，并清理 cookie", async () => {
    vi.stubEnv("APP_BASE_URL", "http://localhost:3000");
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const noState = await callback(new Request("http://localhost:3000/api/auth/feishu/callback?code=bad&state=bad"));
      expect(noState.status).toBe(307); expect(noState.headers.get("location")).toContain("/login?error=");
      fake.values.set("arbor_oauth_state", "expected");
      await callback(new Request("http://localhost:3000/api/auth/feishu/callback?code=bad&state=wrong"));
      expect(fake.values.get("arbor_oauth_state")).toBe(""); expect(fetch).not.toHaveBeenCalled();
    } finally { fetch.mockRestore(); }
  });

});

describe("Gitea Webhook 路由", () => {
  const path = "http://localhost:3000/api/webhooks/gitea";
  const body = { action: "opened", repository: { full_name: "company/approval-web" }, pull_request: { number: 42, title: "AR-T2b", head: { ref: "feature/AR-T2b" } }, secret: "不落库", password: "不落库", sign: "不落库" };
  const signed = (raw = JSON.stringify(body), headers: Record<string, string> = {}, signatureHeader = "X-Gitea-Signature") => {
    const signature = createHmac("sha256", "test-key").update(raw).digest("hex");
    return new Request(path, { method: "POST", body: raw, headers: { "X-Gitea-Event": "pull_request", [signatureHeader]: signatureHeader === "X-Gitea-Signature" ? signature : `sha256=${signature}`, ...headers } });
  };
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("GITEA_WEBHOOK_SECRET", "test-key");
    database.where.mockResolvedValue([]);
    database.load.mockResolvedValue(demoState("2026-11-06"));
    database.persist.mockResolvedValue(undefined);
    database.raw.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
    database.lock.mockImplementation(async (fn) => fn({ select: () => ({ from: () => ({ where: database.where }) }), update: () => ({ set: database.raw }) }));
  });
  it.each(["X-Gitea-Signature", "X-Hub-Signature-256"])("%s 验签后事务处理并保存去凭证载荷", async (header) => {
    const raw = JSON.stringify(body, null, 2) + "\n";
    const response = await webhook(signed(raw, {}, header));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: "pr_open", ref: "T2b", verified: true });
    expect(database.lock).toHaveBeenCalledOnce(); expect(database.persist).toHaveBeenCalledOnce();
    const record = database.persist.mock.calls[0][2].repoEvents[0];
    expect(record.id).toBe(createHash("sha256").update(`pull_request\n${raw}`).digest("hex"));
    const { secret: _secret, sign: _sign, password: _password, ...business } = body;
    void _secret; void _sign; void _password;
    expect(database.raw).toHaveBeenCalledWith({ raw: business });
  });
  it("缺少密钥、错误或缺少签名返回 401，不进入事务", async () => {
    vi.stubEnv("GITEA_WEBHOOK_SECRET", "");
    const response = await webhook(signed());
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "未配置 GITEA_WEBHOOK_SECRET" });
    vi.stubEnv("GITEA_WEBHOOK_SECRET", "test-key");
    expect((await webhook(request("/api/webhooks/gitea"))).status).toBe(401);
    expect((await webhook(signed(undefined, { "X-Gitea-Signature": "bad" }))).status).toBe(401);
    expect((await webhook(signed(undefined, { "X-Gitea-Signature": "", "X-Hub-Signature-256": "sha256=bad" }))).status).toBe(401);
    expect(database.lock).not.toHaveBeenCalled();
  });
  it("拒绝非法 JSON、非对象和超过 1MB 的请求", async () => {
    for (const raw of ["invalid", "[]", "null"]) expect((await webhook(signed(raw))).status).toBe(400);
    expect((await webhook(signed(JSON.stringify({ content: "中".repeat(350000) })))).status).toBe(413);
    expect(database.lock).not.toHaveBeenCalled();
  });
  it("优先用投递 ID 的哈希去重，重复投递不再应用", async () => {
    const delivery = "delivery-42";
    await webhook(signed(undefined, { "X-Gitea-Delivery": delivery }));
    const id = createHash("sha256").update(delivery).digest("hex");
    expect(database.persist.mock.calls[0][2].repoEvents[0].id).toBe(id);
    database.where.mockResolvedValue([{ id }]);
    const response = await webhook(signed(JSON.stringify({ ...body, action: "synchronized" }), { "X-Gitea-Delivery": delivery }));
    expect(await response.json()).toEqual({ ok: true, duplicate: true });
    expect(database.persist).toHaveBeenCalledOnce(); expect(database.load).toHaveBeenCalledOnce();
  });
  it("不同投递 ID 即使原文相同也分别记录", async () => {
    for (const delivery of ["delivery-a", "delivery-b"]) await webhook(signed(undefined, { "X-Gitea-Delivery": delivery }));
    const ids = database.persist.mock.calls.map((call) => call[2].repoEvents[0].id);
    expect(ids).toEqual(["delivery-a", "delivery-b"].map((id) => createHash("sha256").update(id).digest("hex")));
    expect(new Set(ids).size).toBe(2);
  });
  it("没有投递 ID 时，相同事件头和原文也能去重", async () => {
    await webhook(signed());
    database.where.mockResolvedValue([{ id: database.persist.mock.calls[0][2].repoEvents[0].id }]);
    expect(await (await webhook(signed())).json()).toEqual({ ok: true, duplicate: true });
    expect(database.persist).toHaveBeenCalledOnce();
  });
  it("将具体审查事件头传给解析器", async () => {
    const payload = { ...body, action: "reviewed", review: { content: "补测试" } };
    const response = await webhook(signed(JSON.stringify(payload), { "X-Gitea-Event-Type": "pull_request_review_rejected" }));
    expect(await response.json()).toMatchObject({ kind: "comment" });
    expect(database.persist.mock.calls[0][2].repoEvents[0].note).toBe("要求修改：补测试");
  });
  it("GitHub 审查验证 HMAC，并使用 GitHub 的绑定和账号", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", "github-key");
    const state = demoState("2026-11-06");
    const project = state.items.find((item) => item.repos?.includes("company/approval-web"))!;
    project.repos!.push("github:company/approval-web");
    state.accounts.find((a) => a.id === "linyue")!.repoLogins = { github: "github-reviewer" };
    database.load.mockResolvedValue(state);
    const raw = JSON.stringify({ ...body, action: "submitted", review: { state: "approved", user: { login: "github-reviewer" } } });
    const signature = createHmac("sha256", "github-key").update(raw).digest("hex");
    const headers = { "X-GitHub-Event": "pull_request_review", "X-GitHub-Delivery": "delivery-42", "X-Hub-Signature-256": `sha256=${signature}` };
    const deliver = (content = raw) => githubWebhook(new Request("http://localhost:3000/api/webhooks/github", { method: "POST", headers, body: content }));
    expect((await deliver(raw + " ")).status).toBe(401);
    expect(await (await deliver()).json()).toMatchObject({ ok: true, kind: "pr_approved", ref: "T2b" });
    const saved = database.persist.mock.calls[0][2] as ReturnType<typeof demoState>;
    expect(saved.repoEvents[0]).toMatchObject({ repo: "github:company/approval-web", status: "applied" });
    expect(saved.repoEvents[0].id).not.toBe(createHash("sha256").update("delivery-42").digest("hex"));
    expect(saved.items.find(({ id }) => id === "T2b")!.checks.at(-1)).toMatchObject({ by: "linyue", note: "GitHub PR #42 审查通过" });
  });

  it("GitLab 支持签名令牌和旧版 Secret token", async () => {
    const key = Buffer.alloc(32, 23);
    vi.stubEnv("GITLAB_WEBHOOK_SECRET", `whsec_${key.toString("base64")}`);
    const raw = JSON.stringify({ user: { username: "reviewer" }, project: { path_with_namespace: "team/subgroup/repo" },
      object_attributes: { action: "merge", iid: 5, source_branch: "feature/AR-T2b", url: "https://gitlab.example.com/team/subgroup/repo/-/merge_requests/5" } });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = createHmac("sha256", key).update(`webhook-1.${timestamp}.${raw}`).digest("base64");
    const send = (headers: Record<string, string>) => gitlabWebhook(new Request("http://localhost:3000/api/webhooks/gitlab", {
      method: "POST", body: raw, headers: { "X-Gitlab-Event": "Merge Request Hook", ...headers },
    }));
    expect((await send({ "X-Gitlab-Token": "wrong" })).status).toBe(401);
    expect(await (await send({ "webhook-id": "webhook-1", "webhook-timestamp": timestamp, "webhook-signature": `v1,${signature}` })).json())
      .toMatchObject({ ok: true, kind: "pr_merged", ref: "T2b" });
    expect(database.persist.mock.calls[0][2].repoEvents[0]).toMatchObject({ repo: "gitlab:team/subgroup/repo", number: 5 });
    vi.stubEnv("GITLAB_WEBHOOK_SECRET", "legacy-token");
    expect((await send({ "X-Gitlab-Token": "legacy-token", "Idempotency-Key": "legacy" })).status).toBe(200);
  });

  it("Gitee 校验密码并脱敏，裸路径仓库不会误匹配", async () => {
    vi.stubEnv("GITEE_WEBHOOK_SECRET", "gitee-password");
    const payload = { ...body, action: "open", hook_name: "merge_request_hooks", password: "gitee-password" };
    expect(await (await giteeWebhook(request("/api/webhooks/gitee", payload))).json())
      .toMatchObject({ ok: true, kind: "pr_open", ref: "T2b" });
    expect(database.persist.mock.calls[0][2].repoEvents[0]).toMatchObject({ repo: "gitee:company/approval-web", status: "unbound" });
    expect(database.raw.mock.calls[0][0].raw).not.toHaveProperty("password");
    expect((await giteeWebhook(request("/api/webhooks/gitee", { ...payload, password: "wrong" }))).status).toBe(401);
    for (const provider of ["github", "gitlab", "gitee"]) {
      expect((await proxy(new NextRequest(`http://localhost:3000/api/webhooks/${provider}`))).headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("Proxy 允许新 Webhook 未登录访问，其余受保护接口仍拒绝", async () => {
    expect((await proxy(new NextRequest(path))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(new NextRequest("http://localhost:3000/api/commands"))).status).toBe(401);
  });
});
