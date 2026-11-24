// 只在显式 npm run test:db 时运行；创建并清理独立测试库，不修改连接串原有库的数据。
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq, sql } from "drizzle-orm";
import { closeDatabase, db } from "../src/lib/db";
import { loadState, persistState, withWriteLock } from "../src/lib/db/state";
import { seedDemo } from "../src/lib/db/seed";
import { attachments, activityLog, accounts, draftScreenshots, localCredentials, memberInvitations, notificationLog, repoEvents, roleTemplates, rules, sessions, workItems } from "../src/lib/db/schema";
import { applyCommand } from "../src/lib/commands";
import { assigneeIds, dateOffset, today } from "../src/lib/model";
import { myQueue } from "../src/lib/queue";
import { childrenOf } from "../src/lib/tree";
import { createSession, sessionAccount, sessionHash } from "../src/lib/auth";
import { loginFeishu } from "../src/lib/feishu/account";
import { issueMemberInvitation, loginLocal, registerLocal } from "../src/lib/local-auth";
import { accountRoleId, applyRoleTemplate, isAdmin, ROLES } from "../src/lib/access";

import { planRiskNotices } from "../src/lib/notifications/plan";
import { collectHandoffs } from "../src/lib/notifications/handoff";
import { runNotifications, NOTIFY_LOCK } from "../src/lib/notifications/runner";
import { messenger } from "../src/lib/feishu/messages";
import { testNotification } from "../src/lib/notifications/admin";

const requestSession = vi.hoisted(() => ({ token: "", oauthState: "" }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = name === "arbor_oauth_state" ? requestSession.oauthState : requestSession.token;
      return value ? { value } : undefined;
    },
    set: (name: string, value: string) => {
      if (name === "arbor_oauth_state") requestSession.oauthState = value;
      if (name === "arbor_session") requestSession.token = value;
    },
  }),
}));
import { GET as startFeishuLogin } from "../src/app/api/auth/feishu/route";
import { GET as finishFeishuLogin } from "../src/app/api/auth/feishu/callback/route";
import { FEISHU_ENDPOINTS } from "../src/lib/feishu/oauth";
import { POST as postCommand } from "../src/app/api/commands/route";
import { POST as stageScreenshot } from "../src/app/api/attachments/draft/route";
import { POST as uploadAttachment } from "../src/app/api/attachments/route";
import { GET as downloadAttachment } from "../src/app/api/attachments/[id]/route";

const databaseName = `arbor_test_${randomBytes(6).toString("hex")}`;
let admin: ReturnType<typeof postgres>;
let created = false;
const initialUrl = process.env.DATABASE_URL;
const initialDemo = process.env.DEMO_MODE;
const notificationEnv = Object.fromEntries(["APP_BASE_URL", "APP_TIMEZONE", "FEISHU_APP_ID", "FEISHU_APP_SECRET"].map((k) => [k, process.env[k]]));

beforeAll(async () => {
  if (!initialUrl) throw new Error("需要 DATABASE_URL（仅用于创建独立临时测试库）");
  admin = postgres(initialUrl, { max: 1, connect_timeout: 5 });
  const version = await admin`show server_version`;
  expect(version[0].server_version).toMatch(/^16\./);
  await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const testUrl = new URL(initialUrl); testUrl.pathname = `/${databaseName}`;
  process.env.DATABASE_URL = testUrl.href;
  process.env.DEMO_MODE = "true";
  process.env.APP_BASE_URL = "http://localhost:3000"; process.env.APP_TIMEZONE = "Asia/Shanghai";
  process.env.FEISHU_APP_ID = ""; process.env.FEISHU_APP_SECRET = "";
  await closeDatabase();
  const baseline = await mkdtemp(join(tmpdir(), "arbor-baseline-"));
  try {
    await mkdir(join(baseline, "meta"));
    const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
    await writeFile(join(baseline, "meta/_journal.json"), JSON.stringify({ ...journal, entries: journal.entries.slice(0, 1) }));
    await copyFile(`drizzle/${journal.entries[0].tag}.sql`, join(baseline, `${journal.entries[0].tag}.sql`));
    await migrate(drizzle(db().$client), { migrationsFolder: baseline });
    await db().insert(rules).values({ id: "old-manual-rule", data: { id: "old-manual-rule", name: "人工配置", desc: "", to: "", channels: [], enabled: false, kind: "event" } });
    // 用实际新增 DDL 注入中途失败，检查 PostgreSQL 事务回滚后可正常重试迁移。
    for (const entry of journal.entries.slice(1)) {
      const migration = await readFile(`drizzle/${entry.tag}.sql`, "utf8");
      await expect(db().transaction(async (tx) => {
        for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) await tx.execute(sql.raw(statement));
        throw new Error("migration failure probe");
      })).rejects.toThrow("migration failure probe");
    }
    expect((await db().execute(sql`select to_regclass('public.notification_log') as name`))[0].name).toBeNull();
    expect((await db().execute(sql`select to_regclass('public.activity_log') as name`))[0].name).toBeNull();
    expect((await db().execute(sql`select to_regclass('public.attachments') as name`))[0].name).toBeNull();
    const legacy = journal.entries.slice(0, -1);
    await writeFile(join(baseline, "meta/_journal.json"), JSON.stringify({ ...journal, entries: legacy }));
    for (const { tag } of legacy) await copyFile(`drizzle/${tag}.sql`, join(baseline, `${tag}.sql`));
    await migrate(drizzle(db().$client), { migrationsFolder: baseline });
    const legacySession = await withWriteLock(async (tx) => {
      const id = "upgrade-test";
      await tx.execute(sql`insert into accounts (id, name, menus, scope, feishu_open_id)
        values (${id}, '升级前的飞书管理员', '["settings","projects"]'::jsonb, 'all', 'upgrade-test')`);
      return { id, ...await createSession(tx, id) };
    });
    await migrate(drizzle(db().$client), { migrationsFolder: "./drizzle" });
    const preserved = await sessionAccount(legacySession.token);
    expect(preserved?.id).toBe(legacySession.id);
    expect(isAdmin(preserved!)).toBe(true);
    expect((await db().select().from(rules).where(eq(rules.id, "old-manual-rule")))[0].data.enabled).toBe(false);
  } finally { await rm(baseline, { recursive: true, force: true }); }
  // 重复迁移应无副作用。
  await migrate(drizzle(db().$client), { migrationsFolder: "./drizzle" });
});

afterAll(async () => {
  await closeDatabase();
  if (created) await admin.unsafe(`DROP DATABASE "${databaseName}"`);
  if (admin) await admin.end({ timeout: 5 });
  if (initialUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = initialUrl;
  if (initialDemo === undefined) delete process.env.DEMO_MODE; else process.env.DEMO_MODE = initialDemo;
  for (const [key, value] of Object.entries(notificationEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
});

// 每个用例前清空所有业务表再写演示数据：用例之间互不影响，也不会触发「含飞书账号禁止重置」的保护
beforeEach(async () => {
  requestSession.token = "";
  requestSession.oauthState = "";
  await db().execute(sql`truncate table attachments, draft_screenshots, activity_log, notification_log, sessions, repo_events, work_items, rules, accounts, role_templates restart identity cascade`);
  await withWriteLock((tx) => seedDemo(tx, true, "2026-11-06"));
});
const command = (type: unknown, accountId = "zhouhang") => withWriteLock(async (tx) => {
  const before = await loadState(tx);
  const next = applyCommand(before, { accountId, today: "2026-11-06", newId: randomBytes(8).toString("hex") }, type);
  await persistState(tx, before, next.state);
  return next;
});

describe("真实 PostgreSQL 16 验证", () => {
  it("完整表、字段、索引和约束存在，重复迁移不重复写版本", async () => {
    const cols = await db().execute(sql`select table_name, column_name from information_schema.columns where table_schema = 'public'`);
    expect(cols.filter((c) => c.table_name === "accounts")).toHaveLength(17);
    expect(cols.filter((c) => c.table_name === "work_items")).toHaveLength(6);
    expect(new Set(cols.map((c) => c.table_name)).size).toBe(13);
    const indexes = await db().execute(sql`select indexname from pg_indexes where schemaname='public'`);
    expect(indexes.map((i) => i.indexname)).toContain("work_items_parent_idx");
    expect(cols.filter((c) => c.table_name === "attachments")).toHaveLength(8);
    expect(indexes.map((i) => i.indexname)).toContain("attachments_item_idx");
    expect(cols.filter((c) => c.table_name === "draft_screenshots").map((c) => c.column_name).sort())
      .toEqual(["content", "expires_at", "id", "mime", "name", "size", "uploaded_by"]);
    expect(indexes.map((i) => i.indexname)).toContain("draft_screenshots_expiry_idx");
    expect(cols.filter((c) => c.table_name === "notification_log")).toHaveLength(15);
    expect(indexes.map((i) => i.indexname)).toEqual(expect.arrayContaining(["notification_log_identity_idx", "notification_log_status_idx", "notification_log_sent_idx"]));
    const journal = await db().execute(sql`select * from drizzle.__drizzle_migrations`);
    expect(journal.length).toBe(8);
    await expect(db().execute(sql`insert into app_meta(id) values (2)`)).rejects.toThrow();
    await expect(db().execute(sql`update work_items set version=0 where id='T2b'`)).rejects.toThrow();
  });
  it("项目和需求保存多位执行人，只向新接手的人生成提醒，并保留独立项目验收", async () => {
    const owner = "chenmo", first = "wanglei", second = "xunuo", added = "sunqi", verifier = "linyue";
    const time = new Date("2026-11-06T10:00:00+08:00");
    const before = await db().transaction(loadState);
    const created = await command({ type: "addItem", item: {
      kind: "project", parentId: null, title: "多人项目", owner, assignees: [first, second],
      verifiers: [verifier], due: "2026-11-10",
    } }, owner);
    const projectId = created.result.id!;
    expect(collectHandoffs(before, created.state, { id: "created", actorId: owner }, time)
      .filter((notice) => notice.itemId === projectId).map((notice) => notice.recipient).sort())
      .toEqual([`account:${first}`, `account:${second}`].sort());
    await expect(command({ type: "edit", id: projectId, patch: { verifiers: [second] } }, owner))
      .rejects.toThrow("验证人不能只有执行人自己");

    // 第二位项目执行人能够拆需求，第二位需求执行人能够更新进度。
    const demand = await command({ type: "addItem", item: {
      kind: "feature", parentId: projectId, title: "多人需求", owner, assignees: [first, second],
      verifiers: [verifier, owner], due: "2026-11-09",
    } }, second);
    const demandId = demand.result.id!;
    const updated = await command({ type: "postUpdate", id: demandId, text: "更新进度", progress: 20 }, second);
    const edited = await command({
      type: "edit", id: demandId, patch: { assignees: [first, second, added] }, expected: { assignees: [first, second] },
    }, owner);
    const notices = collectHandoffs(updated.state, edited.state, { id: "edited", actorId: owner }, time);
    expect(notices.map((notice) => [notice.itemId, notice.recipient])).toEqual([[demandId, `account:${added}`]]);
    const saved = await db().transaction(loadState);
    expect(saved.items.find((item) => item.id === projectId)).toMatchObject({ owner, assignees: [first, second] });
    expect(saved.items.find((item) => item.id === demandId)).toMatchObject({
      owner, assignees: [first, second, added], verifiers: [verifier, owner], progress: 20,
    });
  });
  it("任务多执行人保存、进度、编辑冲突和飞书提醒都按人员独立处理", async () => {
    const manager = "chenmo", first = "wanglei", second = "xunuo", replacement = "sunqi";
    const old = (await db().transaction(loadState)).items.find((x) => x.id === "T2b")!;
    expect(old.assignees).toBeUndefined();
    expect(assigneeIds(old)).toEqual([old.assignee]);

    const project = await command({ type: "addItem", item: {
      kind: "project", parentId: null, title: "隔离项目", owner: manager, due: "2026-11-07",
    } }, manager);
    const task = { kind: "task", parentId: project.result.id, title: "多人任务", owner: first, due: "2026-11-07" };
    await expect(command({ type: "addItem", item: { ...task, assignees: [first, first] } }, manager)).rejects.toThrow("执行人不能重复");
    const created = await command({ type: "addItem", item: { ...task, assignees: [first, second] } }, manager);
    const id = created.result.id!;
    await command({ type: "postUpdate", id, text: "第一位更新", progress: 25 }, first);
    await command({ type: "postUpdate", id, text: "第二位更新", progress: 60 }, second);

    const saved = await db().transaction(loadState);
    expect(saved.items.find((x) => x.id === id)).toMatchObject({
      assignees: [first, second], progress: 60, updates: [
        expect.objectContaining({ by: first, progress: 25 }),
        expect.objectContaining({ by: second, progress: 60 }),
      ],
    });
    for (const account of [first, second]) {
      expect(myQueue(saved, account, "2026-11-06").map(({ x }) => x.id)).toContain(id);
    }

    await runNotifications({ now: new Date("2026-11-06T10:00:00+08:00"), dryRun: true });
    await runNotifications({ now: new Date("2026-11-09T10:00:00+08:00"), dryRun: true });
    const rows = await db().select().from(notificationLog);
    const direct = rows.filter((row) => row.objectId === `overdue:${id}`);
    expect(direct.map((row) => row.recipient).sort()).toEqual([`account:${first}`, `account:${second}`].sort());
    expect(direct.every((row) => row.type === "event" && row.status === "dry_run")).toBe(true);
    expect(rows.find((row) => row.objectId === `overdue_escalated:${id}`)?.recipient).toBe(`account:${manager}`);
    expect(rows.some((row) => [`stale:${id}`, `due_soon:${id}`].includes(row.objectId))).toBe(false);
    for (const person of [first, second]) {
      const digest = rows.find((row) => row.type === "daily" && row.recipient === `account:${person}` && row.window === "2026-11-06");
      expect(digest?.payload.report.sections.flatMap((section) => section.lines).some((line) => line.itemId === id)).toBe(true);
    }

    await command({ type: "edit", id, patch: { assignees: [replacement, first] }, expected: { assignees: [first, second] } }, manager);
    await expect(command({ type: "edit", id, patch: { assignees: [second] }, expected: { assignees: [first, second] } }, manager))
      .rejects.toMatchObject({ status: 409, conflicts: { assignees: [replacement, first] } });
    const edited = await db().transaction(loadState);
    expect(edited.items.find((x) => x.id === id)).toMatchObject({ assignee: replacement, assignees: [replacement, first], progress: 60 });
    expect(myQueue(edited, second, "2026-11-06").map(({ x }) => x.id)).not.toContain(id);
    await expect(command({ type: "postUpdate", id, text: "已移除", progress: 90 }, second)).rejects.toMatchObject({ status: 403 });
    await command({ type: "postUpdate", id, text: "新执行人更新", progress: 75 }, replacement);
  });
  it("历史分组新建任务后，重新读取时置顶并保留各层原顺序", async () => {
    const before = await db().transaction(loadState);
    const projectsChildren = childrenOf(before.items, "P1").map((item) => item.id);
    const siblings = childrenOf(before.items, "F2").map((item) => item.id);
    const add = (title: string) => command({
      type: "addItem", item: { parentId: "F2", kind: "task", title, owner: "chenmo", due: "2026-11-20" },
    }, "chenmo");
    const first = await add("第一条新任务");
    const latest = await add("第二条新任务");
    const { items } = await db().transaction(loadState);
    expect(childrenOf(items, "P1").map((item) => item.id)).toEqual(projectsChildren);
    expect(childrenOf(items, "F2").map((item) => item.id)).toEqual([latest.result.id, first.result.id, ...siblings]);
  });
  it("同级顺序及更换上级可从 PostgreSQL 重新读取", async () => {
    await command({ type: "moveItem", id: "F2", fromParentId: "P1", targetId: "F1", placement: "before" }, "chenmo");
    await command({ type: "moveItem", id: "T2b", fromParentId: "T2", targetId: "F2", placement: "inside", confirmed: true }, "chenmo");
    const { items } = await db().transaction(loadState);
    const projectChildren = childrenOf(items, "P1").map((x) => x.id);
    expect(projectChildren.indexOf("F2")).toBeLessThan(projectChildren.indexOf("F1"));
    expect(childrenOf(items, "F2").at(-1)?.id).toBe("T2b");
    expect(childrenOf(items, "T2").map((x) => x.id)).not.toContain("T2b");
    await command({ type: "moveItem", id: "T2b", fromParentId: "F2", toParentId: "T2", targetId: "T2c", placement: "before", confirmed: true }, "chenmo");
    const transferred = await db().transaction(loadState);
    expect(transferred.items.find((x) => x.id === "T2b")?.parentId).toBe("T2");
    expect(childrenOf(transferred.items, "T2").map((x) => x.id)).toEqual(["T2a", "T2b", "T2c"]);
  });
  it("转移任务不改变尚未设置手动顺序的需求列表", async () => {
    const before = await db().transaction(loadState);
    const requirementOrder = childrenOf(before.items, "P2").map((item) => item.id);
    await command({ type: "moveItem", id: "T15", fromParentId: "F5", toParentId: "F6", targetId: "T17", placement: "before", confirmed: true }, "chenmo");
    const after = await db().transaction(loadState);
    expect(childrenOf(after.items, "P2").map((item) => item.id)).toEqual(requirementOrder);
    expect(childrenOf(after.items, "F6")[0]?.id).toBe("T15");
  });
  it("恢复和解除归档持久化，恢复后重新加载队列和原状态", async () => {
    const before = await db().transaction(loadState);
    const status = before.items.find((x) => x.id === "T2b")!.status;
    await command({ type: "cancel", id: "F1", reason: "暂停" }, "chenmo");
    await command({ type: "restore", id: "F1", reason: "继续" }, "chenmo");
    await command({ type: "archive", id: "P1", reason: "归档" }, "chenmo");
    await command({ type: "unarchive", id: "P1", reason: "继续" }, "chenmo");
    const state = await db().transaction(loadState);
    expect(state.items.find((x) => x.id === "T2b")).toMatchObject({ status });
    expect(state.items.find((x) => x.id === "P1")?.archivedAt).toBeUndefined();
    expect(state.items.find((x) => x.id === "F1")?.log.at(-1)?.text).toContain("恢复");
  });
  it("附件路由真实 bytea 往返、会话/可见权限/只读校验及附件引用持久化", async () => {
    requestSession.token = (await withWriteLock((tx) => createSession(tx, "zhouhang"))).token;
    const request = () => new Request("http://localhost:3000/api/attachments?itemId=T2b", { method: "POST", headers: { "Content-Type": "text/plain", "X-File-Name": encodeURIComponent("真实附件.txt"), Origin: "http://localhost:3000" }, body: "PG16 中文附件" });
    const response = await uploadAttachment(request());
    expect(response.status).toBe(200);
    const data = await response.json();
    const id = data.result.id;
    const [file] = await db().select().from(attachments).where(eq(attachments.id, id));
    expect(file.content.toString("utf8")).toBe("PG16 中文附件");
    expect(file.size).toBe(Buffer.byteLength("PG16 中文附件"));
    const get = () => downloadAttachment(new Request("http://localhost:3000/api/attachments/" + id), { params: Promise.resolve({ id }) });
    const downloaded = await get(); expect(downloaded.status).toBe(200); expect(await downloaded.text()).toBe("PG16 中文附件");
    expect(downloaded.headers.get("x-content-type-options")).toBe("nosniff");
    await command({ type: "postUpdate", id: "T2b", text: "附件已保存", attachmentIds: [id] });
    expect((await db().transaction(loadState)).items.find((x) => x.id === "T2b")?.updates.at(-1)?.attachmentIds).toEqual([id]);
    await db().update(accounts).set({ menus: [] }).where(eq(accounts.id, "zhouhang"));
    expect((await get()).status).toBe(404); expect((await uploadAttachment(request())).status).toBe(403);
    await db().update(accounts).set({ menus: ["projects", "quality", "alerts"] }).where(eq(accounts.id, "zhouhang"));
    await command({ type: "archive", id: "P1", reason: "只读验证" }, "chenmo");
    expect((await get()).status).toBe(200); expect((await uploadAttachment(request())).status).toBe(403);
    requestSession.token = ""; expect((await get()).status).toBe(401);
    expect(await db().select().from(attachments)).toHaveLength(1);
  });
  it("需求和任务截图随原文件落库，重新读取仍可预览", async () => {
    requestSession.token = (await withWriteLock((tx) => createSession(tx, "chenmo"))).token;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGO8AAAAASUVORK5CYII=", "base64");
    const screenshotIds = new Map<string, string>();
    for (const itemId of ["F1", "T2b"]) {
      const response = await uploadAttachment(new Request(`http://localhost:3000/api/attachments?itemId=${itemId}&purpose=item-screenshot`, {
        method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": "screen.png", Origin: "http://localhost:3000" }, body: new Uint8Array(png),
      }));
      expect(response.status).toBe(200);
      const { result: { id } } = await response.json();
      screenshotIds.set(itemId, id);
      const get = await downloadAttachment(new Request(`http://localhost:3000/api/attachments/${id}`), { params: Promise.resolve({ id }) });
      expect(Buffer.from(await get.arrayBuffer())).toEqual(png);
    }
    const snapshot = await db().transaction(loadState);
    for (const [itemId, imageId] of screenshotIds) {
      expect(snapshot.items.find((item) => item.id === itemId)?.screenshotIds).toEqual([imageId]);
      expect(snapshot.attachments?.find((file) => file.id === imageId)?.itemId).toBe(itemId);
    }
  });
  it("创建需求和任务时消费暂存截图，失败不会留下工作项，重试不会重复创建", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGO8AAAAASUVORK5CYII=", "base64");
    const url = "http://localhost:3000";
    const login = async (actor: string) => { requestSession.token = (await withWriteLock((tx) => createSession(tx, actor))).token; };
    const stage = async () => {
      const response = await stageScreenshot(new Request(`${url}/api/attachments/draft`, {
        method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": "draft.png", Origin: url }, body: new Uint8Array(png),
      }));
      expect(response.status).toBe(200);
      return (await response.json()).result.id as string;
    };
    const create = (parentId: string, kind: "feature" | "task", screenshotDraftIds: string[]) => postCommand(new Request(`${url}/api/commands`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ type: "addItem", item: { parentId, kind, title: `带截图创建 ${kind}`, owner: "chenmo", due: dateOffset(today(), 7) }, screenshotDraftIds }),
    }));
    await login("zhouhang");
    const someoneElses = await stage();
    await login("chenmo");
    expect((await create("P1", "feature", [someoneElses])).status).toBe(409);
    expect((await db().select().from(workItems)).every((row) => row.data.title !== "带截图创建 feature")).toBe(true);
    expect(await db().select().from(attachments)).toHaveLength(0);

    const requirementImage = await stage();
    const response = await create("P1", "feature", [requirementImage]);
    expect(response.status).toBe(200);
    const requirement = await response.json();
    expect(requirement.state.items.find((item: { id: string }) => item.id === requirement.result.id)?.screenshotIds).toEqual([requirementImage]);
    const repeat = await create("P1", "feature", [requirementImage]);
    expect(repeat.status).toBe(200);
    expect((await repeat.json()).result.id).toBe(requirement.result.id);

    const taskImage = await stage();
    const taskResponse = await create(requirement.result.id, "task", [taskImage]);
    expect(taskResponse.status).toBe(200);
    const taskId = (await taskResponse.json()).result.id;
    const [task] = await db().select().from(workItems).where(eq(workItems.id, taskId));
    expect(task.data.screenshotIds).toEqual([taskImage]);
    const [file] = await db().select().from(attachments).where(eq(attachments.id, taskImage));
    expect(file.itemId).toBe(taskId);
    expect(file.content).toEqual(png);
    expect((await db().select().from(draftScreenshots)).map((draft) => draft.id)).toEqual([someoneElses]);
    expect((await db().select().from(workItems)).filter((row) => row.data.title === "带截图创建 feature")).toHaveLength(1);
  });
  it("编辑时原子保存属性与截图，保留可协作成员单独补图的权限", async () => {
    const url = "http://localhost:3000";
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aGO8AAAAASUVORK5CYII=", "base64");
    const login = async (actor: string) => { requestSession.token = (await withWriteLock((tx) => createSession(tx, actor))).token; };
    const stage = async () => {
      const response = await stageScreenshot(new Request(`${url}/api/attachments/draft`, {
        method: "POST", headers: { "Content-Type": "image/png", "X-File-Name": "edit.png", Origin: url }, body: new Uint8Array(png),
      }));
      expect(response.status).toBe(200);
      return (await response.json()).result.id as string;
    };
    const edit = (patch: object, screenshotDraftIds: string[], expected?: object) => postCommand(new Request(`${url}/api/commands`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: url },
      body: JSON.stringify({ type: "edit", id: "F1", patch, expected, screenshotDraftIds }),
    }));
    const read = async () => (await db().select().from(workItems).where(eq(workItems.id, "F1")))[0].data;

    await login("zhouhang");
    const collaboratorScreenshot = await stage();
    expect((await edit({ title: "不能改标题" }, [collaboratorScreenshot])).status).toBe(403);
    expect((await read()).screenshotIds).toBeUndefined();
    expect((await edit({}, [collaboratorScreenshot])).status).toBe(200);
    const initial = await read();
    expect(initial.screenshotIds).toEqual([collaboratorScreenshot]);

    await login("chenmo");
    const adminScreenshot = await stage();
    expect((await edit({ title: "编辑与截图一同保存" }, [adminScreenshot], { title: "旧窗口" })).status).toBe(409);
    expect(await read()).toMatchObject({ title: initial.title, screenshotIds: [collaboratorScreenshot] });
    expect((await edit({ title: "编辑与截图一同保存" }, [adminScreenshot], { title: initial.title })).status).toBe(200);
    expect((await edit({ title: "编辑与截图一同保存" }, [adminScreenshot], { title: initial.title })).status).toBe(200);
    const updated = await read();
    expect(updated).toMatchObject({ title: "编辑与截图一同保存", screenshotIds: [collaboratorScreenshot, adminScreenshot] });
    expect((await db().select().from(attachments).where(eq(attachments.itemId, "F1")))).toHaveLength(2);
    expect(await db().select().from(draftScreenshots)).toHaveLength(0);
  });
  it("附件约束及中途失败事务回滚，不留下文件或半条动态", async () => {
    const file = { id: "rollback-file", itemId: "T2b", uploadedBy: "zhouhang", name: "a.txt", mime: "text/plain", size: 1, content: Buffer.from("a") };
    await expect(withWriteLock(async (tx) => {
      await tx.insert(attachments).values(file);
      const before = await loadState(tx);
      const next = applyCommand(before, { accountId: "zhouhang", today: "2026-11-06", newId: "new" }, { type: "postUpdate", id: "T2b", text: "rollback update", attachmentIds: [file.id] });
      await persistState(tx, before, next.state);
      throw new Error("attachment rollback");
    })).rejects.toThrow("attachment rollback");
    expect(await db().select().from(attachments)).toHaveLength(0);
    expect((await db().transaction(loadState)).items.find((x) => x.id === "T2b")?.updates.some((u) => u.text === "rollback update")).toBe(false);
    await expect(db().insert(attachments).values({ ...file, size: 2 })).rejects.toThrow();
    await expect(db().insert(attachments).values({ ...file, itemId: "missing" })).rejects.toThrow();
  });
  it("持久化命令仅更新变更行，刷新再读仍存在", async () => {
    await command({ type: "postUpdate", id: "T2b", text: "真实数据库进展", progress: 55 });
    const rows = await db().select().from(workItems);
    expect(rows.find((x) => x.id === "T2b")!.version).toBe(2);
    expect(rows.filter((x) => x.version !== 1)).toHaveLength(1);
    const snapshot = await db().transaction((tx) => loadState(tx));
    expect(snapshot.items.find((x) => x.id === "T2b")!.updates.at(-1)?.text).toBe("真实数据库进展");
  });
  it("取消/归档和删除审计落库，刷新后仍保留，失败命令不写入", async () => {
    await command({ type: "cancel", id: "F1", reason: "数据库取消验收" }, "chenmo");
    let snapshot = await db().transaction(loadState);
    expect(snapshot.items.find((x) => x.id === "T2b")?.status).toBe("cancelled");
    expect(snapshot.items.find((x) => x.id === "F1")?.log.at(-1)?.text).toContain("数据库取消验收");
    await expect(command({ type: "setStatus", id: "T2b", status: "doing" })).rejects.toThrow("已取消");
    await command({ type: "archive", id: "P2", reason: "项目结项" }, "chenmo");
    snapshot = await db().transaction(loadState);
    expect(snapshot.items.find((x) => x.id === "P2")?.archivedAt).toBe("2026-11-06");
    const parentId = snapshot.items.find((x) => x.id === "T21")!.parentId;
    await command({ type: "delete", id: "T21", reason: "数据库删除验收" }, "chenmo");
    expect((await db().select().from(workItems)).some((x) => x.id === "T21")).toBe(false);
    expect((await db().select().from(activityLog))[0].data.text).toContain("数据库删除验收");
    snapshot = await db().transaction(loadState);
    expect(snapshot.items.find((x) => x.id === parentId)?.log.at(-1)?.text).toContain("数据库删除验收");
    expect(snapshot.activities?.at(-1)?.itemId).toBe("T21");
  });
  it("项目执行人只能经命令接口取消或删除本人创建并负责的任务", async () => {
    await command({ type: "edit", id: "P1", patch: { assignees: ["chenmo", "zhouhang"] } }, "chenmo");
    const create = async (title: string, actor: string) => (await command({
      type: "addItem", item: { parentId: "P1", kind: "task", title, owner: "zhouhang", due: "2026-11-20" },
    }, actor)).result.id!;
    const cancelled = await create("本人待取消", "zhouhang");
    const deleted = await create("本人待删除", "zhouhang");
    const assigned = await create("他人创建的任务", "chenmo");
    requestSession.token = (await withWriteLock((tx) => createSession(tx, "zhouhang"))).token;
    const post = (type: "cancel" | "delete", id: string) => postCommand(new Request("http://localhost:3000/api/commands", {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ type, id, reason: "权限回归" }),
    }));
    expect((await post("cancel", assigned)).status).toBe(403);
    expect((await post("delete", assigned)).status).toBe(403);
    expect((await post("cancel", cancelled)).status).toBe(200);
    expect((await post("delete", deleted)).status).toBe(200);
    const snapshot = await db().transaction(loadState);
    expect(snapshot.items.find((item) => item.id === assigned)?.status).toBe("todo");
    expect(snapshot.items.find((item) => item.id === cancelled)?.status).toBe("cancelled");
    expect(snapshot.items.find((item) => item.id === deleted)).toBeUndefined();
    expect(snapshot.activities?.at(-1)).toMatchObject({ itemId: deleted, by: "zhouhang" });
  });

  it("删除和审计在同一事务，失败回滚保留原项且不遗留审计", async () => {
    const added = await command({ type: "addItem", item: { parentId: null, kind: "project", title: "回滚待删", owner: "chenmo", due: "2026-12-01" } }, "chenmo");
    await expect(withWriteLock(async (tx) => {
      const before = await loadState(tx);
      const next = applyCommand(before, { accountId: "chenmo", today: "2026-11-06", newId: "audit-rollback" }, { type: "delete", id: added.result.id, reason: "回滚" });
      await persistState(tx, before, next.state);
      throw new Error("删除中途失败");
    })).rejects.toThrow("删除中途失败");
    expect((await db().select().from(workItems)).some((x) => x.id === added.result.id)).toBe(true);
    expect(await db().select().from(activityLog)).toHaveLength(0);
  });
  it("并发命令串行读写，不丢失更新", async () => {
    await Promise.all(Array.from({ length: 8 }, (_, n) => command({ type: "postUpdate", id: "T2b", text: `concurrent-${n}` })));
    const [x] = await db().select().from(workItems).where(eq(workItems.id, "T2b"));
    expect(x.data.updates.filter((u) => u.text.startsWith("concurrent-"))).toHaveLength(8);
    expect(x.version).toBe(9);
  });
  it("并行编辑不同字段都保留，同一字段冲突返回最新值且原子拒绝请求", async () => {
    const initial = (await db().transaction(loadState)).items.find((x) => x.id === "T2b")!;
    await Promise.all([
      command({ type: "edit", id: initial.id, expected: { title: initial.title }, patch: { title: "同事改了标题" } }, "chenmo"),
      command({ type: "edit", id: initial.id, expected: { desc: initial.desc ?? "" }, patch: { desc: "保留同事的说明" } }, "chenmo"),
    ]);
    requestSession.token = (await withWriteLock((tx) => createSession(tx, "chenmo"))).token;
    const post = (body: unknown) => postCommand(new Request("http://localhost:3000/api/commands", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }));
    const res = await post({
      type: "edit", id: initial.id, expected: { title: initial.title, acceptance: [] },
      patch: { title: "旧窗口的标题", acceptance: ["旧窗口新增验收标准"] },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, conflicts: { title: "同事改了标题" } });
    let current = (await db().transaction(loadState)).items.find((x) => x.id === initial.id)!;
    expect(current).toMatchObject({ title: "同事改了标题", desc: "保留同事的说明" });
    expect(current.acceptance).toEqual(initial.acceptance);
    const retry = await post({ type: "edit", id: initial.id, expected: { acceptance: [] }, patch: { acceptance: ["旧窗口新增验收标准"] } });
    expect(retry.status).toBe(200);
    current = (await db().transaction(loadState)).items.find((x) => x.id === initial.id)!;
    expect(current).toMatchObject({ title: "同事改了标题", desc: "保留同事的说明", acceptance: ["旧窗口新增验收标准"] });
  });
  it("权限拒绝和事务中途失败都不会写入部分数据", async () => {
    await expect(command({ type: "setAccount", id: "guest", account: {} })).rejects.toThrow();
    await expect(withWriteLock(async (tx) => {
      await tx.update(accounts).set({ active: false }).where(eq(accounts.id, "guest"));
      throw new Error("模拟事务失败");
    })).rejects.toThrow();
    expect((await db().select().from(accounts).where(eq(accounts.id, "guest")))[0].active).toBe(true);
    await expect(withWriteLock(async (tx) => {
      await tx.execute(sql`create table rollback_probe(id integer)`);
      await tx.execute(sql`select * from missing_table_probe`);
    })).rejects.toThrow();
    const probe = await db().execute(sql`select to_regclass('public.rollback_probe') as name`);
    expect(probe[0].name).toBeNull();
    await migrate(drizzle(db().$client), { migrationsFolder: "./drizzle" });
  });
  it("会话只保存摘要，停用与过期会话立即失效", async () => {
    const session = await withWriteLock((tx) => createSession(tx, "zhouhang"));
    expect((await sessionAccount(session.token))!.id).toBe("zhouhang");
    const [row] = await db().select().from(sessions);
    expect(row.id).toBe(sessionHash(session.token)); expect(row.id).not.toBe(session.token);
    await db().update(accounts).set({ active: false }).where(eq(accounts.id, "zhouhang"));
    expect(await sessionAccount(session.token)).toBeNull();
    await db().update(accounts).set({ active: true }).where(eq(accounts.id, "zhouhang"));
    await db().update(sessions).set({ expiresAt: new Date(0) });
    expect(await sessionAccount(session.token)).toBeNull();
  });
  it("空正式库首次并发登录只产生一个管理员，同一身份重登不重复建号", async () => {
    await withWriteLock(async (tx) => { await tx.delete(sessions); await tx.delete(repoEvents); await tx.delete(workItems); await tx.delete(rules); await tx.delete(accounts); });
    process.env.DEMO_MODE = "false";
    const ids = await Promise.all([1, 2].map((n) => withWriteLock((tx) => loginFeishu(tx, { open_id: `ou_${n}`, union_id: `on_${n}`, name: `人员${n}` }))));
    const rows = await db().select().from(accounts);
    expect(rows.filter((a) => a.menus.includes("settings"))).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(await db().select().from(workItems)).toHaveLength(0);
    const again = await withWriteLock((tx) => loginFeishu(tx, { open_id: "ou_1", union_id: "on_1", name: "新姓名" }));
    expect(again).toBe(ids[0]);
    expect(await withWriteLock((tx) => loginFeishu(tx, { open_id: "ou_1_new_app", union_id: "on_1", name: "同一人员" }))).toBe(ids[0]);
    await db().update(accounts).set({ active: false }).where(eq(accounts.id, again));
    await expect(withWriteLock((tx) => loginFeishu(tx, { open_id: "ou_1_new_app", name: "停用用户" }))).rejects.toThrow("停用");
    process.env.DEMO_MODE = "true";
  });
});


describe("多平台代码仓库", () => {
  it("平台之间的同名仓库可以分别绑定，成员身份与角色权限独立保存", async () => {
    const state = await db().transaction(loadState);
    const bound = state.items.find((item) => item.kind === "project" && item.repos?.includes("company/approval-web"))!;
    const project = state.items.find((item) => item.kind === "project" && item.id !== bound.id)!;
    await command({ type: "bindRepo", id: project.id, provider: "github", repo: "https://github.com/Company/Approval-Web.git" }, "chenmo");
    await command({ type: "bindRepo", id: project.id, provider: "gitlab", repo: "team/subgroup/approval-web" }, "chenmo");
    await expect(command({ type: "bindRepo", id: bound.id, provider: "github", repo: "company/approval-web" }, "chenmo"))
      .rejects.toThrow("仓库已经绑定");

    await command({ type: "setMember", id: "zhouhang", active: true, gitee: "legacy-user",
      repoLogins: { github: "github-user", gitlab: "gitlab-user", gitee: "gitee-user" } }, "chenmo");
    await command({ type: "setMember", id: "zhouhang", active: true, roleId: "guest" }, "chenmo");
    const next = await db().transaction(loadState);
    expect(next.items.find((item) => item.id === bound.id)?.repos).toContain("company/approval-web");
    expect(next.items.find((item) => item.id === project.id)?.repos).toEqual(expect.arrayContaining([
      "github:company/approval-web", "gitlab:team/subgroup/approval-web",
    ]));
    expect(next.accounts.find((account) => account.id === "zhouhang")).toMatchObject({
      gitee: "legacy-user", repoLogins: { github: "github-user", gitlab: "gitlab-user", gitee: "gitee-user" }, canCreate: false,
    });
    await command({ type: "unbindRepo", id: project.id, repo: "github:company/approval-web" }, "chenmo");
    const final = await db().transaction(loadState);
    expect(final.items.find((item) => item.id === bound.id)?.repos).toContain("company/approval-web");
    expect(final.items.find((item) => item.id === project.id)?.repos).not.toContain("github:company/approval-web");
  });
});

describe("自定义角色", () => {
  it("角色变更同步给绑定成员，成员可独立配置，始终保留管理员", async () => {
    const actor = "chenmo";
    const target = "zhouhang";
    const template = { name: "交付负责人", description: "查看参与的交付", permissions: ROLES.member.preset };
    const create = { type: "saveRoleTemplate", template };
    await expect(command(create, target)).rejects.toThrow("需要系统设置权限");
    await command(create, actor);
    await expect(command(create, actor)).rejects.toThrow("已有同名角色");
    const [role] = await db().select().from(roleTemplates);
    const snapshot = await db().transaction(loadState);
    const original = snapshot.accounts.find((a) => a.id === target)!;
    const assigned = applyRoleTemplate(original, role);
    const memberUpdate = { type: "setMember", id: target, active: true, gitee: "delivery-member" };
    await expect(command({ ...memberUpdate, menus: ["settings"] }, actor)).rejects.toThrow("命令参数无效");
    await command({ ...memberUpdate, roleId: role.id }, actor);
    await expect(command({ type: "deleteRoleTemplate", id: role.id }, actor)).rejects.toThrow("请先为使用此角色的成员更换角色");

    const edit = { type: "saveRoleTemplate", id: role.id, expectedRevision: role.revision,
      template: { ...template, permissions: { ...template.permissions, scope: "all", canCreate: false } } };
    await command(edit, actor);
    const [updated] = await db().select().from(roleTemplates);
    expect(updated.revision).toBe(role.revision + 1);
    const [updatedMember] = await db().select().from(accounts).where(eq(accounts.id, target));
    expect(updatedMember).toMatchObject({ roleTemplateId: role.id, scope: "all", canCreate: false, gitee: "delivery-member" });
    await command({ ...memberUpdate, gitee: "updated-profile" }, actor);
    const [savedProfile] = await db().select().from(accounts).where(eq(accounts.id, target));
    expect(savedProfile).toMatchObject({ roleTemplateId: role.id, scope: "all", canCreate: false, gitee: "updated-profile" });
    await expect(command(edit, actor)).rejects.toThrow("角色已变更");
    await expect(command({ type: "setAccount", id: target, account: assigned }, actor)).rejects.toThrow("角色已变更");

    await command({ type: "setAccount", id: target, account: { ...assigned, roleTemplateId: undefined, canCreate: false } }, actor);
    await command({ ...edit, expectedRevision: updated.revision, template }, actor);
    const [detached] = await db().select().from(accounts).where(eq(accounts.id, target));
    expect(detached).toMatchObject({ roleTemplateId: null, scope: "joined", canCreate: false });
    await command({ type: "deleteRoleTemplate", id: role.id }, actor);
    expect(await db().select().from(roleTemplates)).toHaveLength(0);

    await command({ type: "saveRoleTemplate", template: { ...template, name: "本地管理", permissions: ROLES.admin.preset } }, actor);
    const [administrator] = await db().select().from(roleTemplates);
    const activeAdmin = (await db().transaction(loadState)).accounts.find((a) => a.id === actor)!;
    await command({ type: "setAccount", id: actor, account: applyRoleTemplate(activeAdmin, administrator) }, actor);
    await expect(command({ ...edit, id: administrator.id, expectedRevision: administrator.revision,
      template: { ...template, name: administrator.name } }, actor)).rejects.toThrow("至少要保留一个");
    expect((await db().transaction(loadState)).accounts.find((a) => a.id === actor)?.menus).toContain("settings");
  });

  it("角色详情可以批量添加、移除并转入其他角色，且不会改动账号资料", async () => {
    const actor = "chenmo";
    const first = "zhouhang";
    const second = "xunuo";
    const permissions = { ...ROLES.member.preset, canCreate: false };
    const template = { name: "项目观察员", description: "", permissions };
    await command({ type: "saveRoleTemplate", template }, actor);
    const [role] = await db().select().from(roleTemplates);
    await command({ type: "setMember", id: first, active: true, gitee: "repo-user" }, actor);
    await command({ type: "setMember", id: second, active: false }, actor);

    const add = {
      type: "moveRoleMembers",
      roleId: role.id,
      members: [{ id: first, fromRoleId: "member" }, { id: second, fromRoleId: "member" }],
    };
    await expect(command(add, first)).rejects.toThrow("需要系统设置权限");
    const stale = { ...add, members: [add.members[0], { ...add.members[1], fromRoleId: "guest" }] };
    await expect(command(stale, actor)).rejects.toThrow("成员角色已变更");
    expect((await db().transaction(loadState)).accounts.filter((a) => a.roleTemplateId === role.id)).toHaveLength(0);
    await command(add, actor);
    await command(add, actor);
    const assigned = (await db().transaction(loadState)).accounts.filter((a) => accountRoleId(a) === role.id);
    expect(assigned).toHaveLength(2);
    expect(assigned.find((a) => a.id === first)).toMatchObject({ gitee: "repo-user", active: true, canCreate: false });
    expect(assigned.find((a) => a.id === second)).toMatchObject({ active: false, canCreate: false });

    await command({ type: "moveRoleMembers", roleId: "guest", members: [{ id: first, fromRoleId: role.id }] }, actor);
    await command({ type: "saveRoleTemplate", id: role.id, expectedRevision: role.revision,
      template: { ...template, permissions: { ...permissions, scope: "all" } } }, actor);
    const snapshot = await db().transaction(loadState);
    const moved = snapshot.accounts.find((a) => a.id === first)!;
    expect(accountRoleId(moved)).toBe("guest");
    expect(moved).toMatchObject({ gitee: "repo-user", scope: "selected", canCreate: false, menus: ["projects"] });
    expect(snapshot.accounts.find((a) => a.id === second)).toMatchObject({ roleTemplateId: role.id, scope: "all" });
    await expect(command({ type: "moveRoleMembers", roleId: "member", members: [{ id: actor, fromRoleId: "admin" }] }, actor))
      .rejects.toThrow("至少要保留一个");
  });

});

describe("飞书登录回归", () => {
  it("禁用本地登录时仍能授权，校验 state，并用原账号创建会话", async () => {
    vi.stubEnv("LOCAL_AUTH_ENABLED", "false");
    vi.stubEnv("FEISHU_APP_ID", "test-app");
    vi.stubEnv("FEISHU_APP_SECRET", "test-secret");
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ code: 0, access_token: "test-access" }))
      .mockResolvedValueOnce(Response.json({ code: 0, data: { open_id: "feishu-existing", union_id: "feishu-union", name: "飞书更新名称" } }));
    vi.stubGlobal("fetch", fetch);
    try {
      await db().execute(sql`truncate accounts cascade`);
      const id = await withWriteLock((tx) => loginFeishu(tx, { open_id: "feishu-existing", union_id: "feishu-union", name: "飞书管理员" }));
      const begin = await startFeishuLogin();
      const location = new URL(begin.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(FEISHU_ENDPOINTS.authorize);
      expect(location.searchParams.get("redirect_uri")).toBe("http://localhost:3000/api/auth/feishu/callback");
      const state = location.searchParams.get("state");
      expect(state).toBe(requestSession.oauthState);
      const callback = new URL("http://localhost:3000/api/auth/feishu/callback?code=test-code");
      callback.searchParams.set("state", "wrong-state");
      expect(new URL((await finishFeishuLogin(new Request(callback))).headers.get("location")!).pathname).toBe("/login");
      expect(fetch).not.toHaveBeenCalled();

      await startFeishuLogin();
      callback.searchParams.set("state", requestSession.oauthState);
      const finished = await finishFeishuLogin(new Request(callback));
      expect(finished.headers.get("location")).toBe("http://localhost:3000/");
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([FEISHU_ENDPOINTS.token, FEISHU_ENDPOINTS.userInfo]);
      const account = await sessionAccount(requestSession.token);
      expect(account?.id).toBe(id);
      expect(isAdmin(account!)).toBe(true);
      expect(await db().select({ id: accounts.id }).from(accounts)).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});

describe("本地账号与邀请", () => {
  it("并发初始化只创建一位管理员，邀请只能兑换一次，正式账号无法通过演示入口使用", async () => {
    const setupCode = randomBytes(32).toString("hex");
    const password = randomBytes(16).toString("hex");
    vi.stubEnv("LOCAL_AUTH_ENABLED", "true");
    vi.stubEnv("LOCAL_AUTH_SETUP_TOKEN", setupCode);
    try {
      await db().execute(sql`truncate accounts cascade`);
      await expect(registerLocal({ username: "invalid", name: "无效", password, code: randomBytes(32).toString("hex") }))
        .rejects.toThrow("邀请码无效");
      const input = { username: "admin", name: "本地管理员", password, code: setupCode };
      const outcomes = await Promise.allSettled([registerLocal(input), registerLocal({ ...input, username: "second-admin" })]);
      expect(outcomes.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
      const [credential] = await db().select().from(localCredentials);
      const admin = await loginLocal({ username: credential.username, password });
      expect(isAdmin((await sessionAccount(admin.token))!)).toBe(true);
      expect(credential.passwordHash).not.toContain(password);
      await expect(registerLocal({ ...input, username: "late-admin" })).rejects.toThrow("管理员初始化已关闭");

      const { code } = await issueMemberInvitation(admin.token);
      const [invitation] = await db().select().from(memberInvitations);
      expect(invitation.tokenHash).toBe(sessionHash(code));
      const memberInput = { username: "member", name: "成员", password, code };
      await expect(registerLocal({ ...memberInput, username: credential.username })).rejects.toThrow("用户名已被使用");
      const claims = await Promise.allSettled([registerLocal(memberInput), registerLocal(memberInput)]);
      expect(claims.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
      const member = claims.find((claim) => claim.status === "fulfilled")!;
      const memberAccount = (await sessionAccount(member.value.token))!;
      expect(isAdmin(memberAccount)).toBe(false);
      await expect(issueMemberInvitation(member.value.token)).rejects.toThrow("只有管理员");
      await expect(registerLocal({ ...memberInput, username: "replay" })).rejects.toThrow("邀请码无效");

      const expired = await issueMemberInvitation(admin.token);
      await db().update(memberInvitations).set({ expiresAt: new Date(0) }).where(eq(memberInvitations.tokenHash, sessionHash(expired.code)));
      await expect(registerLocal({ ...memberInput, username: "expired", code: expired.code })).rejects.toThrow("邀请码无效");

      for (let attempt = 0; attempt < 5; attempt++) {
        await expect(loginLocal({ username: "member", password: "wrong-password" })).rejects.toThrow("用户名或密码错误");
      }
      await expect(loginLocal({ username: "member", password })).rejects.toThrow("暂时无法登录");
      await db().update(localCredentials).set({ retryAfter: new Date(0) }).where(eq(localCredentials.accountId, memberAccount.id));
      await expect(loginLocal({ username: "member", password })).resolves.toHaveProperty("token");
      await db().update(accounts).set({ active: false }).where(eq(accounts.id, memberAccount.id));
      await expect(loginLocal({ username: "member", password })).rejects.toThrow("用户名或密码错误");
      expect(await sessionAccount(member.value.token)).toBeNull();

      const feishu = await withWriteLock((tx) => loginFeishu(tx, { open_id: "feishu-after-local", name: "飞书成员" }));
      const [feishuMember] = await db().select().from(accounts).where(eq(accounts.id, feishu));
      expect(feishuMember.menus).not.toContain("settings");

      await db().delete(accounts).where(eq(accounts.id, feishu));
      vi.stubEnv("LOCAL_AUTH_ENABLED", "false");
      await expect(withWriteLock((tx) => seedDemo(tx, true))).rejects.toThrow("数据库含正式账号");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("通知真实数据库与多实例", () => {
  const at = (s: string) => new Date(`2026-11-${s}+08:00`);
  it("缺陷登记只向负责人入队一次，私聊重试和详情维护保留数据", async () => {
    const send = vi.spyOn(messenger, "send")
      .mockResolvedValueOnce({ status: "failed", error: "暂时不可用" })
      .mockResolvedValue({ status: "sent", messageId: "defect-message" });
    vi.stubEnv("FEISHU_APP_ID", "test-app");
    vi.stubEnv("FEISHU_APP_SECRET", "test-secret");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("06T21:00:00"));
    const submit = async (accountId: string, body: unknown, status = 200) => {
      requestSession.token = (await withWriteLock((tx) => createSession(tx, accountId))).token;
      const response = await postCommand(new Request("http://localhost:3000/api/commands", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify(body),
      }));
      expect(response.status).toBe(status);
      return response.json();
    };
    const readDefects = async () => (await db().transaction(loadState)).items.find((item) => item.id === "T2b")!.defects;
    try {
      await db().update(accounts).set({ feishuOpenId: "ou_defect_owner" }).where(eq(accounts.id, "linyue"));
      const defect = { title: "保存后结果丢失", description: "重新打开后可复现", owner: "linyue", severity: "P1", foundAt: "测试" };
      const register = { type: "addDefect", id: "T2b", requestId: randomUUID(), defect };
      const next = await submit("zhouhang", register);
      const defectId = next.result.id;
      expect((await submit("zhouhang", register)).result.id).toBe(defectId);
      await submit("zhouhang", { ...register, defect: { ...defect, title: "不同的内容" } }, 409);
      expect((await readDefects()).filter(({ id }) => id === defectId)).toEqual([expect.objectContaining({ ...defect, by: "zhouhang", status: "open" })]);

      const logs = () => db().select().from(notificationLog).where(eq(notificationLog.type, "defect"));
      expect(await logs()).toEqual([expect.objectContaining({ objectId: defectId, recipient: "account:linyue", status: "pending" })]);
      expect((await runNotifications({ now: at("06T21:00:30"), directOnly: true })).failed).toBe(1);
      expect((await runNotifications({ now: at("06T21:05:00") })).sent).toBe(1);
      expect(send).toHaveBeenCalledTimes(2);
      const [type, target, card, uuid, dryRun] = send.mock.calls[0];
      expect([type, target, dryRun]).toEqual(["open_id", "ou_defect_owner", false]);
      expect(send.mock.calls[1][3]).toBe(uuid);
      expect(JSON.stringify(card)).toContain("保存后结果丢失");
      expect(JSON.stringify(card)).toContain("严重程度：P1");
      expect(JSON.stringify(card)).toContain("/item/T2b?tab=quality");

      const edit = { type: "editDefect", id: "T2b", defectId, expected: 0, defect: { ...defect, title: "保存后结果未同步" } };
      await submit("zhaoyi", edit, 403);
      await submit("linyue", edit);
      await submit("linyue", edit, 409);
      await submit("linyue", { type: "fixDefect", id: "T2b", defectId });
      expect((await readDefects()).find(({ id }) => id === defectId)).toMatchObject({ title: edit.defect.title, status: "fixed", revision: 2 });
      await submit("linyue", { type: "reopenDefect", id: "T2b", defectId });
      expect((await readDefects()).find(({ id }) => id === defectId)).toMatchObject({ ...edit.defect, status: "open", revision: 3 });
      expect(await logs()).toEqual([expect.objectContaining({ status: "sent", attempts: 2 })]);
    } finally {
      send.mockRestore();
      vi.unstubAllEnvs();
      vi.useRealTimers();
    }
  });
  it("动态 @ 走同一事务入队，编辑只提醒新增成员，撤回取消待发送提醒", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("06T21:00:00"));
    const submit = async (accountId: string, body: unknown, status = 200) => {
      requestSession.token = (await withWriteLock((tx) => createSession(tx, accountId))).token;
      const response = await postCommand(new Request("http://localhost:3000/api/commands", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify(body),
      }));
      expect(response.status).toBe(status);
      return response.json();
    };
    const mentionRows = () => db().select().from(notificationLog).where(eq(notificationLog.type, "mention"));
    try {
      const posted = await submit("zhouhang", {
        type: "postUpdate", id: "T2b", text: `请@林悦 留意这条测试正文 ${"内容".repeat(45)} 尾部超出预览`,
        mentionIds: ["linyue", "linyue", "zhaoyi"], progress: 65,
      });
      const updateId = posted.result.id;
      const edit = { type: "editUpdate", id: "T2b", updateId, expected: null, text: "@林悦 @赵一 补充说明", mentionIds: ["linyue", "zhaoyi"] };
      await submit("linyue", edit, 403);
      expect((await mentionRows()).map((r) => r.recipient)).toEqual(["account:linyue"]);

      const fast = await runNotifications({ now: at("06T21:00:30"), dryRun: true, directOnly: true });
      expect(fast).toMatchObject({ dry_run: 1, queued: 0 });
      expect(await db().select().from(notificationLog)).toHaveLength(1);
      const [direct] = await mentionRows();
      expect(direct.status).toBe("dry_run");
      expect(JSON.stringify(direct.batch?.card)).toContain(`/item/T2b?update=${updateId}`);
      expect(JSON.stringify(direct.batch?.card)).toContain("测试正文");
      expect(JSON.stringify(direct.batch?.card)).not.toContain("尾部超出预览");

      vi.setSystemTime(at("06T21:02:00"));
      await submit("zhouhang", edit);
      await submit("zhouhang", edit, 409);
      await submit("zhouhang", {
        type: "retractUpdate", id: "T2b", updateId, expected: at("06T21:02:00").toISOString(),
      });
      await runNotifications({ now: at("06T21:02:30"), dryRun: true, directOnly: true });
      expect((await mentionRows()).map(({ recipient, status }) => [recipient, status]).sort()).toEqual([
        ["account:linyue", "dry_run"], ["account:zhaoyi", "cancelled"],
      ]);
      const item = (await db().transaction(loadState)).items.find((item) => item.id === "T2b");
      expect(item?.progress).toBe(65);
      expect(item?.updates.find((update) => update.id === updateId)).toMatchObject({
        text: "", retractedAt: expect.any(String), mentions: [],
      });
    } finally { vi.useRealTimers(); }
  });
  it("演练合并、幂等与跨日不重复催同一风险，不调用网络", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("不应调用网络"));
    try {
      const first = await runNotifications({ now: at("06T10:00:00"), dryRun: true });
      expect(first.dry_run).toBeGreaterThan(0);
      const rows = await db().select().from(notificationLog);
      const onePerson = rows.filter((r) => r.recipient === rows[0].recipient);
      expect(new Set(onePerson.map((r) => r.batch?.id)).size).toBe(1);
      expect((await runNotifications({ now: at("06T10:05:00"), dryRun: true })).queued).toBe(0);
      await runNotifications({ now: at("09T10:00:00"), dryRun: true });
      const next = await db().select().from(notificationLog);
      for (const sent of rows.filter((r) => r.type === "event")) {
        expect(next.filter((r) => r.type === "event" && r.objectId === sent.objectId && r.recipient === sent.recipient && r.window === sent.window)).toHaveLength(1);
      }
      expect(fetcher).not.toHaveBeenCalled();
    } finally { fetcher.mockRestore(); }
  });
  it("升级沿用同一次逾期的旧版发送记录，新阶段仍可升级", async () => {
    await command({ type: "edit", id: "T2b", patch: { due: "2026-11-05" } }, "chenmo");
    await command({ type: "edit", id: "P1", patch: { feishuChatId: "oc_test" } }, "chenmo");
    const state = await db().transaction(loadState);
    const first = planRiskNotices(state, at("06T10:00:00")).find((n) => n.objectId === "overdue:T2b")!;
    const legacy = { ...first, window: "5980800" };
    await db().insert(notificationLog).values({
      id: "legacy", type: "event", objectId: legacy.objectId, recipient: legacy.recipient, window: legacy.window,
      status: "dry_run", mode: "dry_run", payload: legacy, sentAt: at("06T10:00:00"),
    });
    await runNotifications({ now: at("09T10:00:00"), dryRun: true });
    const logs = await db().select().from(notificationLog);
    expect(logs.filter((row) => row.objectId === legacy.objectId && row.recipient === legacy.recipient).map((r) => r.id)).toEqual(["legacy"]);
    expect(logs.find((r) => r.objectId === "overdue_escalated:T2b" && r.recipient === "chat:oc_test")?.status).toBe("dry_run");
  });

  it("真实命令写入交接队列，过时接收人取消，与摘要去重，复提启用新验收轮次", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const setTime = (s: string) => vi.setSystemTime(at(s));
    const post = async (accountId: string, body: unknown) => {
      requestSession.token = (await withWriteLock((tx) => createSession(tx, accountId))).token;
      const response = await postCommand(new Request("http://localhost:3000/api/commands", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify(body),
      }));
      expect(response.status).toBe(200);
      return (await response.json()).result;
    };
    const logs = (objectId: string) => db().select().from(notificationLog).where(and(eq(notificationLog.type, "handoff"), eq(notificationLog.objectId, objectId)));
    try {
      setTime("06T09:05:00");
      const { id: parentId } = await post("chenmo", { type: "addItem", item: {
        parentId: null, kind: "project", title: "飞书隔离验收", owner: "chenmo", due: "2026-11-10",
      }});
      const { id } = await post("chenmo", { type: "addItem", item: {
        parentId, kind: "task", title: "需要交接的本地任务", owner: "wanglei", assignees: ["wanglei", "xunuo"],
        verifiers: ["linyue"], due: "2026-11-07",
      }});
      await post("chenmo", { type: "edit", id, patch: { assignees: ["wanglei", "zhouhang"] } });
      await runNotifications({ now: at("06T09:30:00"), dryRun: true });
      const assigns = await logs(`assign:${id}`);
      expect(assigns.find((r) => r.recipient === "account:xunuo")?.status).toBe("cancelled");
      expect(assigns.find((r) => r.recipient === "account:zhouhang")?.status).toBe("dry_run");
      const wanglei = assigns.find((r) => r.recipient === "account:wanglei")!;
      expect(wanglei.payload.handoff).toMatchObject({ roles: ["负责人", "执行人"] });
      const card = JSON.stringify(wanglei.batch?.card);
      expect(card).toContain("明天截止");
      expect(card.split(`/item/${id}`).length - 1).toBe(1);
      for (const digest of (await db().select().from(notificationLog)).filter((r) => r.type === "daily" && r.recipient === "account:wanglei")) {
        expect(digest.payload.report.sections.flatMap((s) => s.lines).some((line) => line.itemId === id)).toBe(false);
      }

      setTime("06T10:05:00");
      await post("wanglei", { type: "submit", id, deliverable: "本地验收交付物", note: "" });
      await post("chenmo", { type: "edit", id, patch: { verifiers: ["zhaoyi"] } });
      await runNotifications({ now: at("06T10:10:00"), dryRun: true });
      const reviews = await logs(`review_requested:${id}`);
      expect(reviews.find((r) => r.recipient === "account:linyue")?.status).toBe("cancelled");
      const transferred = reviews.find((r) => r.recipient === "account:zhaoyi")!;
      expect(transferred.status).toBe("dry_run");
      expect(transferred.payload.report.tone).toBe("purple");

      setTime("06T10:15:00");
      await post("zhaoyi", { type: "verify", id, pass: false, note: "需要补充退款口径" });
      await runNotifications({ now: at("06T10:20:00"), dryRun: true });
      const rejected = await logs(`review_rejected:${id}`);
      expect(rejected.map((r) => r.recipient).sort()).toEqual(["account:wanglei", "account:zhouhang"]);
      expect(rejected.every((r) => r.status === "dry_run" && JSON.stringify(r.batch?.card).includes("需要补充退款口径"))).toBe(true);

      setTime("06T10:25:00");
      await post("wanglei", { type: "submit", id, deliverable: "修订后的交付物", note: "" });
      await runNotifications({ now: at("06T10:30:00"), dryRun: true });
      expect((await logs(`review_requested:${id}`)).filter((r) => r.recipient === "account:zhaoyi" && r.status === "dry_run")).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
  it("生产发布交接真实落库，已替换版本的线上提醒被取消", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("06T10:05:00"));
    const post = async (accountId: string, body: unknown) => {
      requestSession.token = (await withWriteLock((tx) => createSession(tx, accountId))).token;
      const response = await postCommand(new Request("http://localhost:3000/api/commands", {
        method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify(body),
      }));
      const result = await response.json();
      expect(response.status, JSON.stringify(result.reason)).toBe(200);
      return result.result;
    };
    try {
      const { id } = await post("chenmo", { type: "addItem", item: {
        parentId: "P1", kind: "feature", title: "发布落库回归", owner: "wanglei", verifiers: ["linyue"],
        assignees: ["wanglei", "xunuo"], acceptance: ["筛选结果符合样本"], due: "2026-11-09",
      } });
      const item = async () => (await db().select().from(workItems).where(eq(workItems.id, id)))[0].data;
      const handoffs = async (kind: string) => db().select().from(notificationLog).where(eq(notificationLog.objectId, `${kind}:${id}`));
      expect((await item()).checklist).toEqual([]);
      await post("wanglei", { type: "submit", id, deliverable: "测试环境", note: "" });
      await post("linyue", { type: "verify", id, pass: true, note: "" });
      const first = await item();
      expect(first.releaseCycle).toBeDefined();
      expect(first).toMatchObject({ status: "review", productionStage: "release" });
      expect((await db().transaction(loadState)).items.find((entry) => entry.id === id)?.status).toBe("release");
      expect(first.doneAt).toBeUndefined();
      expect(await handoffs("release_requested")).toEqual(expect.arrayContaining([expect.objectContaining({ recipient: "account:xunuo", status: "pending" }), expect.objectContaining({ recipient: "account:wanglei", status: "pending" })]));
      await post("xunuo", { type: "publish", id, cycle: first.releaseCycle!.id, version: "v1" });
      expect(await item()).toMatchObject({ status: "review", productionStage: "production-review" });
      expect((await db().transaction(loadState)).items.find((entry) => entry.id === id)?.status).toBe("production-review");
      expect((await handoffs("production_review_requested"))[0]).toMatchObject({ recipient: "account:linyue", status: "pending" });
      await post("xunuo", { type: "recordReleaseIssue", id, cycle: first.releaseCycle!.id,
        publicationId: (await item()).publication!.id, note: "回滚 v1" });
      await post("xunuo", { type: "publish", id, cycle: (await item()).releaseCycle!.id, version: "v2" });
      await runNotifications({ now: at("06T10:15:00"), dryRun: true });
      expect((await handoffs("release_requested")).every((row) => row.status === "cancelled")).toBe(true);
      const online = await handoffs("production_review_requested");
      expect(online.find((row) => row.status === "cancelled")?.payload.report.sections[0].lines[0].detail).toContain("v1");
      const current = online.find((row) => row.status === "dry_run");
      expect(current?.recipient).toBe("account:linyue");
      expect(JSON.stringify(current?.batch?.card)).toContain("v2");
      await post("linyue", { type: "verifyProduction", id, publicationId: (await item()).publication!.id, pass: false, note: "线上结果需修正" });
      expect((await handoffs("review_rejected")).find((row) => row.recipient === "account:wanglei")?.status).toBe("pending");
    } finally {
      vi.useRealTimers();
    }
  });
  it("夜间落库，周末非urgent保留，周一补发；关闭规则取消延迟提醒", async () => {
    const night = await runNotifications({ now: at("06T21:00:00"), dryRun: true });
    expect(night.queued).toBeGreaterThan(0); expect(night.dry_run).toBe(0);
    const pending = await db().select().from(notificationLog);
    expect(pending.every((r) => r.status === "pending")).toBe(true);
    const weekend = await runNotifications({ now: at("07T10:00:00"), dryRun: true });
    expect(weekend.dry_run).toBeGreaterThan(0);
    const waiting = (await db().select().from(notificationLog)).filter((r) => r.status === "pending");
    expect(waiting.length).toBeGreaterThan(0);
    expect(waiting.every((r) => r.payload.level !== "urgent")).toBe(true);
    const monday = await runNotifications({ now: at("09T09:00:00"), dryRun: true });
    expect(monday.dry_run).toBeGreaterThan(0);
    await db().delete(notificationLog);
    await runNotifications({ now: at("06T21:00:00"), dryRun: true });
    await db().update(rules).set({ data: sql`jsonb_set(data, '{enabled}', 'false')` });
    const off = await runNotifications({ now: at("09T09:00:00"), dryRun: true });
    expect(off.dry_run).toBe(0); expect(off.cancelled).toBeGreaterThan(0);
  });
  it("归档后待发送提醒取消，不发送旧项目卡片", async () => {
    await runNotifications({ now: at("06T21:00:00"), dryRun: true });
    await command({ type: "archive", id: "P1", reason: "停止提醒" }, "chenmo");
    await command({ type: "archive", id: "P2", reason: "停止提醒" }, "chenmo");
    await command({ type: "archive", id: "P3", reason: "停止提醒" }, "chenmo");
    const result = await runNotifications({ now: at("09T10:00:00"), dryRun: true });
    expect(result.dry_run).toBe(0); expect(result.cancelled).toBeGreaterThan(0);
    expect((await db().select().from(notificationLog)).filter((r) => r.status === "pending")).toHaveLength(0);
  });
  it("同一提醒窗口取消后恢复可重新排队，已发送记录不重发", async () => {
    await command({ type: "edit", id: "T2b", patch: { due: "2026-11-05" } }, "chenmo");
    await runNotifications({ now: at("06T21:00:00"), dryRun: true });
    const waiting = (await db().select().from(notificationLog)).filter((r) => r.status === "pending" && r.payload.itemId && ["P1", "F1", "T2b", "T2c"].includes(r.payload.itemId));
    expect(waiting.length).toBeGreaterThan(0);
    await command({ type: "archive", id: "P1", reason: "停止提醒" }, "chenmo");
    await runNotifications({ now: at("06T21:05:00"), dryRun: true });
    const cancelled = (await db().select().from(notificationLog)).filter((r) => waiting.some((w) => w.id === r.id) && r.status === "cancelled");
    expect(cancelled.length).toBeGreaterThan(0);
    await command({ type: "unarchive", id: "P1", reason: "继续提醒" }, "chenmo");
    await runNotifications({ now: at("06T21:10:00"), dryRun: true });
    const resumed = await db().select().from(notificationLog);
    // 暂停期间取消的同一风险可以恢复排队；已发送的风险保持去重。
    for (const old of cancelled) expect(resumed.some((r) => r.objectId === old.objectId && r.recipient === old.recipient && r.status === "pending")).toBe(true);
    await db().delete(notificationLog);
    await runNotifications({ now: at("06T10:00:00"), dryRun: true });
    await command({ type: "archive", id: "P1", reason: "归档" }, "chenmo");
    await runNotifications({ now: at("06T10:05:00"), dryRun: true });
    await command({ type: "unarchive", id: "P1", reason: "恢复" }, "chenmo");
    expect((await runNotifications({ now: at("06T10:10:00"), dryRun: true })).dry_run).toBe(0);
  });
  it("日报和周报同日期幂等、绑定项目才发周报", async () => {
    await command({ type: "edit", id: "P1", patch: { feishuChatId: "oc_test" } }, "chenmo");
    const run = await runNotifications({ now: at("06T17:00:00"), dryRun: true });
    expect(run.dry_run).toBeGreaterThan(0);
    const rows = await db().select().from(notificationLog);
    const weekly = rows.filter((r) => r.type === "weekly");
    expect(weekly).toHaveLength(1);
    expect(weekly[0].batch?.card.header.template).toBe("wathet");
    expect(weekly[0].batch?.card.elements).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tag: "column_set",
        columns: [
          expect.objectContaining({ elements: [expect.objectContaining({ text: expect.objectContaining({ content: expect.stringMatching(/^实际进度\n\*\*\d+%\*\*$/) }) })] }),
          expect.objectContaining({ elements: [expect.objectContaining({ text: expect.objectContaining({ content: expect.stringMatching(/^计划进度\n\*\*\d+%\*\*$/) }) })] }),
        ],
      }),
    ]));
    expect(rows.some((r) => r.type === "daily")).toBe(true);
    expect((await runNotifications({ now: at("06T17:05:00"), dryRun: true })).queued).toBe(0);
    const snapshot = await db().transaction(loadState);
    expect(snapshot.items.find((x) => x.id === "P1")?.feishuChatId).toBe("oc_test");
    await expect(command({ type: "edit", id: "T2b", patch: { feishuChatId: "oc_bad" } }, "chenmo")).rejects.toThrow("只有项目");
    await expect(command({ type: "edit", id: "P1", patch: { feishuChatId: "oc_bad" } }, "guest")).rejects.toThrow();
  });
  it("已有其他实例持锁则跳过，锁释放后能执行", async () => {
    const reserved = await db().$client.reserve();
    try {
      await reserved`select pg_advisory_lock(${NOTIFY_LOCK})`;
      const run = await runNotifications({ now: at("06T10:00:00"), dryRun: true });
      expect(run.locked).toBe(false); expect(run.queued).toBe(0);
    } finally { await reserved`select pg_advisory_unlock(${NOTIFY_LOCK})`; reserved.release(); }
    expect((await runNotifications({ now: at("06T10:00:00"), dryRun: true })).locked).toBe(true);
  });
  it("正式模式无 open_id 写失败，其他接收人继续，演练不抑制正式发送", async () => {
    await runNotifications({ now: at("06T10:00:00"), dryRun: true });
    const oldId = process.env.FEISHU_APP_ID; const oldSecret = process.env.FEISHU_APP_SECRET;
    process.env.FEISHU_APP_ID = "test-id"; process.env.FEISHU_APP_SECRET = "test-secret";
    try {
      const result = await runNotifications({ now: at("06T10:00:00") });
      expect(result.queued).toBeGreaterThan(0); expect(result.failed).toBe(result.queued);
      const failed = (await db().select().from(notificationLog)).filter((r) => r.mode === "live");
      expect(failed.every((r) => r.status === "failed" && r.error?.includes("feishu_open_id"))).toBe(true);
    } finally {
      if (oldId === undefined) delete process.env.FEISHU_APP_ID; else process.env.FEISHU_APP_ID = oldId;
      if (oldSecret === undefined) delete process.env.FEISHU_APP_SECRET; else process.env.FEISHU_APP_SECRET = oldSecret;
    }
  });
  it("管理员本人测试落库，成员被拒绝", async () => {
    const state = await db().transaction(loadState);
    const admin = state.accounts.find((a) => a.menus.includes("settings"))!;
    const member = state.accounts.find((a) => !a.menus.includes("settings"))!;
    await expect(testNotification(member)).rejects.toThrow("管理员");
    const result = await testNotification(admin);
    expect(result.status).toBe("dry_run");
    const [row] = await db().select().from(notificationLog);
    expect(row.type).toBe("test"); expect(row.recipient).toBe(`account:${admin.id}`);
    await runNotifications({ now: at("06T10:00:00"), dryRun: true });
    expect((await db().select().from(notificationLog).where(eq(notificationLog.id, row.id)))[0].status).toBe("dry_run");
  });
});
