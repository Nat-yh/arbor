import { describe, expect, it } from "vitest";
import { diffPatch, editLogText, readableLog } from "@/lib/changes";

const names: Record<string, string> = { linyue: "林悦", chenmo: "陈默", zhouhang: "周航" };
const name = (id: string) => names[id] ?? id;

describe("修改记录文案", () => {
  it("只记录真正变化的字段，空值彼此相等", () => {
    const before = { title: "审批详情页", owner: "linyue", verifiers: [] as string[], due: "2026-11-08", estimate: 3, ai: undefined, desc: undefined };
    const changes = diffPatch(before, { title: "审批详情页", owner: "linyue", verifiers: ["chenmo", "zhouhang"], due: "2026-11-12", estimate: 3, ai: false, desc: "" });
    expect(changes.map((c) => c.key)).toEqual(["verifiers", "due"]);
    expect(editLogText(changes, name)).toBe("修改了 验证人：无 → 陈默、周航；截止：11/08 → 11/12");
  });

  it("长文本只提示已更新，成员显示加入 / 移出", () => {
    const changes = diffPatch({ desc: "旧", members: ["linyue", "chenmo"] }, { desc: "新", members: ["linyue", "zhouhang"] });
    expect(editLogText(changes, name)).toBe("修改了 背景 / 说明已更新；加入 周航，移出 陈默");
  });

  it("旧版 JSON 记录转成可读文案并去掉没变的字段", () => {
    const legacy = '修改：title："审批详情页" → "审批详情页"；desc：未设置 → ""；owner："linyue" → "linyue"；verifiers：[] → ["chenmo","zhouhang"]；estimate：3 → 3；ai：未设置 → false';
    expect(readableLog(legacy, name)).toBe("修改了 验证人：无 → 陈默、周航");
    expect(readableLog('修改：title："a" → "a"', name)).toBe("保存了属性（没有实际变化）");
    expect(readableLog("修改：标题，截止 11/08 → 11/12", name)).toBe("修改：标题，截止 11/08 → 11/12");
  });
});
