import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { demoState } from "../src/lib/demo";
import { clientState } from "../src/lib/server-state";
import { canUseTeam } from "../src/lib/access";

const fake = vi.hoisted(() => ({ store: undefined as unknown }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(), usePathname: () => "/projects", useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("../src/lib/store", () => ({ useStore: () => fake.store, useOptionalStore: () => fake.store, usePracticeActive: () => false }));
vi.mock("../src/components/Toast", () => ({ useToast: () => vi.fn() }));
import { ItemView } from "../src/app/item/[id]/ItemDetail";
import { TipProvider } from "../src/components/kit";

beforeEach(() => {
  const state = demoState("2026-11-10");
  const item = state.items.find((x) => x.id === "P1")!;
  Object.assign(item, { rework: 0, acceptance: [], deliverable: "", progress: 0, updates: [], log: [] });
  state.items = [item];
  const snapshot = clientState(state, "chenmo");
  fake.store = { ...snapshot, get: (id: string) => snapshot.items.find((x) => x.id === id), can: (key: string) => key === "team" ? canUseTeam(snapshot.items, snapshot.acc) : snapshot.acc.menus.includes(key as never), visible: snapshot.items, projects: snapshot.items };
});
describe("项目详情空集合渲染", () => {
  it("空项目显示两个状态计数，不产生孤立的 0 或项目进度", () => {
    const html = renderToStaticMarkup(createElement(TipProvider, null, createElement(ItemView, { id: "P1", mode: "page" })));
    expect(html).toMatch(/进行中 <span[^>]*>0<\/span>/);
    expect(html).toMatch(/未开始 <span[^>]*>0<\/span>/);
    expect(html.match(/>0</g)).toHaveLength(2);
    expect(html).not.toMatch(/>\d+%<|title="实际 \d+%/);
  });
});
