import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { Account } from "../src/lib/access";
const fake = vi.hoisted(() => ({ acc: null as Account | null, projects: [] as { id: string }[] }));
vi.mock("../src/lib/auth", () => ({ SESSION_COOKIE: "arbor_session", sessionAccount: async () => fake.acc?.active ? fake.acc : null }));
vi.mock("../src/lib/db", () => ({ db: () => ({ select: () => ({ from: () => ({ where: () => ({ limit: async () => fake.projects }) }) }) }) }));
import { proxy } from "../src/proxy";
const request = () => proxy(new NextRequest("http://localhost:3000/team"));
beforeEach(() => { fake.acc = { id: "member", active: true, menus: ["projects"], scope: "joined", projects: [], perf: "self", canCreate: true }; fake.projects = []; });
describe("团队路由菜单边界", () => {
  it("普通成员直访403；可见项目负责人、管理员和显式授权账号可访问", async () => {
    expect((await request()).status).toBe(403);
    fake.projects = [{ id: "P1" }]; expect((await request()).headers.get("x-middleware-next")).toBe("1");
    fake.projects = []; fake.acc!.menus.push("settings"); expect((await request()).headers.get("x-middleware-next")).toBe("1");
    fake.acc!.menus = ["projects", "team"]; expect((await request()).headers.get("x-middleware-next")).toBe("1");
  });
  it("显式关闭优先于管理员/项目负责人默认授权；停用后不能访问", async () => {
    fake.acc!.menus = ["projects", "settings", "team:off"]; fake.projects = [{ id: "P1" }];
    expect((await request()).status).toBe(403);
    fake.acc!.active = false; expect((await request()).status).toBe(307);
  });
});
