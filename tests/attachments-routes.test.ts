import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoState } from "../src/lib/demo";
import { CommandError } from "../src/lib/commands";

const fake = vi.hoisted(() => ({ state: undefined as unknown, actor: "zhouhang", secondActor: "", calls: 0, file: undefined as unknown, failInsert: false, token: "token", insert: vi.fn() }));
vi.mock("../src/lib/auth", () => ({ requireAccount: async () => {
  fake.calls++;
  const state = fake.state as ReturnType<typeof demoState>;
  const acc = state.accounts.find((a) => a.id === (fake.calls > 1 && fake.secondActor ? fake.secondActor : fake.actor));
  if (!fake.token || !acc?.active) throw new CommandError("请先登录", 401);
  return acc;
} }));
vi.mock("../src/lib/http", async (original) => ({ ...await original<typeof import("../src/lib/http")>(), sessionToken: async () => fake.token }));
vi.mock("../src/lib/db/state", () => ({ loadState: async () => structuredClone(fake.state), persistState: async (_tx: unknown, _before: unknown, state: unknown) => { fake.state = state; }, withWriteLock: async (fn: (tx: unknown) => unknown) => fn(tx) }));
const tx = {
  insert: () => ({ values: async (file: unknown) => { fake.insert(file); if (fake.failInsert) throw new Error("database failed"); fake.file = file; } }),
  select: () => ({ from: () => ({ where: async () => fake.file ? [fake.file] : [] }) }),
};
vi.mock("../src/lib/db", () => ({ db: () => ({ transaction: async (fn: (tx: unknown) => unknown) => fn(tx) }) }));
import { POST } from "../src/app/api/attachments/route";
import { GET } from "../src/app/api/attachments/[id]/route";
import { POST as command } from "../src/app/api/commands/route";

const upload = (body: Uint8Array | string = "文件内容", headers: Record<string, string> = {}, itemId = "T2b") => new Request(`http://localhost:3000/api/attachments?itemId=${itemId}`, { method: "POST", headers: { "Content-Type": "text/plain", "X-File-Name": encodeURIComponent("说明.txt"), ...headers }, body: typeof body === "string" ? body : new Uint8Array(body) });
const screenshot = (itemId: string, body: Uint8Array | string = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGO8AAAAASUVORK5CYII=", "base64"),
  headers: Record<string, string> = { "Content-Type": "image/png", "X-File-Name": "screen.png" }) =>
  upload(body, headers, `${itemId}&purpose=item-screenshot`);
const download = (id: string) => GET(new Request(`http://localhost:3000/api/attachments/${id}`), { params: Promise.resolve({ id }) });
beforeEach(() => { fake.state = demoState("2026-11-10"); fake.actor = "zhouhang"; fake.secondActor = ""; fake.calls = 0; fake.token = "token"; fake.file = undefined; fake.failInsert = false; fake.insert.mockClear(); vi.unstubAllEnvs(); });

describe("附件路由真实 Request/Response 边界", () => {
  it("普通命令接口不能伪造只有元信息的附件", async () => {
    const res = await command(new Request("http://localhost:3000/api/commands", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "uploadAttachment", id: "T2b", name: "x.txt", mime: "text/plain", size: 1 }) }));
    expect(res.status).toBe(400);
    expect(fake.insert).not.toHaveBeenCalled();
  });
  it("恰好10MiB的有效文件可以完整上传", async () => {
    const res = await POST(upload("x".repeat(10485760)));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.attachment.size).toBe(10485760);
    expect((fake.file as { content: Buffer }).content.length).toBe(10485760);
  });
  it("成功上传通过命令写入元信息，下载字节、文件名及响应头一致", async () => {
    const res = await POST(upload()); expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.state.attachments[0]).toMatchObject({ id: data.result.id, name: "说明.txt", uploadedBy: "zhouhang", itemId: "T2b" });
    expect(data.state.attachments[0]).not.toHaveProperty("content");
    const get = await download(data.result.id); expect(get.status).toBe(200); expect(await get.text()).toBe("文件内容");
    expect(get.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(get.headers.get("x-content-type-options")).toBe("nosniff");
  });
  it("未登录、跨站写入、不可见项目均拒绝，附件 ID 不能绕过权限", async () => {
    fake.token = ""; expect((await POST(upload())).status).toBe(401);
    expect((await download("unknown")).status).toBe(401);
    fake.token = "token"; expect((await POST(upload("x", { Origin: "https://evil.example" }))).status).toBe(403);
    expect((await POST(upload("x", {}, "missing"))).status).toBe(403);
    const success = await (await POST(upload())).json();
    const state = fake.state as ReturnType<typeof demoState>;
    const guest = state.accounts.find((a) => a.id === "guest")!; guest.projects = []; guest.scope = "selected";
    fake.actor = "guest"; fake.calls = 0;
    expect((await download(success.result.id)).status).toBe(404);
    expect(fake.insert).toHaveBeenCalledOnce();
  });
  it("上传等待期间权限撤销，在写锁内重验后拒绝且不落库", async () => {
    const state = fake.state as ReturnType<typeof demoState>;
    state.accounts.find((a) => a.id === "guest")!.menus = [];
    fake.secondActor = "guest";
    expect((await POST(upload())).status).toBe(403);
    expect(fake.insert).not.toHaveBeenCalled();
  });
  it("无 Content-Length 也执行流式10MB上限，空文件、伪图片、HTML和非法文件名不写入", async () => {
    expect((await POST(upload(new Uint8Array(10485761)))).status).toBe(413);
    expect((await POST(upload("", { "Content-Type": "text/plain" }))).status).toBe(400);
    expect((await POST(upload("fake image", { "Content-Type": "image/png", "X-File-Name": "fake.png" }))).status).toBe(415);
    expect((await POST(upload("<html>", { "Content-Type": "text/html", "X-File-Name": "x.html" }))).status).toBe(400);
    expect((await POST(upload("x", { "X-File-Name": "%0D%0Ax.txt" }))).status).toBe(400);
    expect(fake.insert).not.toHaveBeenCalled();
  });
  it.each(["F1", "T2b"])("截图直接保存到需求或任务 %s，继续使用现有图片预览", async (itemId) => {
    fake.actor = "chenmo";
    const response = await POST(screenshot(itemId));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.state.items.find((item: { id: string }) => item.id === itemId)).toMatchObject({ screenshotIds: [data.result.id] });
    const image = await download(data.result.id);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toMatch(/^inline;/);
  });

  it("截图用途拒绝非图片、无项目权限的成员、项目和超出上限的工作项", async () => {
    const guest = (fake.state as ReturnType<typeof demoState>).accounts.find((account) => account.id === "guest")!;
    guest.menus = [];
    fake.actor = "guest";
    expect((await POST(screenshot("T2b"))).status).toBe(403);
    fake.actor = "chenmo";
    expect((await POST(screenshot("P1"))).status).toBe(403);
    expect((await POST(screenshot("T2b", "普通说明", { "Content-Type": "text/plain", "X-File-Name": "notes.txt" }))).status).toBe(400);
    const task = (fake.state as ReturnType<typeof demoState>).items.find((item) => item.id === "T2b")!;
    task.screenshotIds = Array.from({ length: 10 }, (_, index) => `existing-${index}`);
    expect((await POST(screenshot("T2b"))).status).toBe(400);
    expect(fake.insert).not.toHaveBeenCalled();
  });
  it("图片未写入时，需求上也不会留下截图引用", async () => {
    fake.actor = "chenmo";
    fake.failInsert = true;
    expect((await POST(screenshot("F1"))).status).toBe(503);
    expect((fake.state as ReturnType<typeof demoState>).items.find((item) => item.id === "F1")?.screenshotIds).toBeUndefined();
  });
  it("文件持久化失败不返回成功，也不发布元信息", async () => {
    fake.failInsert = true;
    expect((await POST(upload())).status).toBe(503);
    expect((fake.state as ReturnType<typeof demoState>).attachments).toBeUndefined();
  });
});
