import { applyRole } from "./access";
import { DEFAULT_RULES } from "./alerts";
import { DEMO_PEOPLE } from "./demo-people";
import { MOCK_ITEMS } from "./mock";
import { dateOffset, daysBetween, today, type Person } from "./model";
import type { AppState } from "./state";

/** 示例基准日期整体平移，逾期、待验收、即将到期的相对关系保持不变。 */
export function demoState(date = today()): AppState {
  const delta = daysBetween("2026-11-05", date);
  const items = JSON.parse(JSON.stringify(MOCK_ITEMS), (_key, value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? dateOffset(value, delta) : value);
  const people: Person[] = [...DEMO_PEOPLE, { id: "guest", name: "演示访客", title: "业务方", kind: "pm", role: "member" }];
  return {
    items, people, rules: structuredClone(DEFAULT_RULES), repoEvents: [],
    accounts: people.map((p) => ({ ...applyRole({ id: p.id, active: true, menus: [], scope: "joined", projects: p.id === "guest" ? ["P1"] : [], perf: "self", canCreate: true }, p.id === "guest" ? "guest" : p.role === "admin" ? "admin" : "member"), gitee: p.id })),
  };
}
