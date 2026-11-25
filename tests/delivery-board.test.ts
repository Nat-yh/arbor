import { describe, expect, it } from "vitest";
import { applyCommand } from "../src/lib/commands";
import { deliveryCommand, deliveryMoves } from "../src/lib/delivery-board";
import { demoState } from "../src/lib/demo";
import type { Status } from "../src/lib/model";
import { statusOf } from "../src/lib/tree";

const today = "2026-11-25";

function setup() {
  let state = demoState(today);
  let sequence = 0;
  const execute = (accountId: string, command: unknown) => {
    state = applyCommand(state, { accountId, today, newId: `board-${++sequence}` }, command).state;
  };
  execute("chenmo", {
    type: "addItem",
    item: {
      parentId: "P1", kind: "feature", title: "导出权限", due: today,
      owner: "chenmo", assignee: "zhouhang", verifiers: ["linyue"], acceptance: ["仅财务人员可导出"],
    },
  });
  const item = () => state.items.find((entry) => entry.id === "board-1")!;
  const targets = (actor: string) => deliveryMoves(state.items, item(), state.accounts.find(({ id }) => id === actor)!);
  const move = (actor: string, to: Status, value?: string) => {
    const target = targets(actor).find((entry) => entry.to === to);
    expect(target).toBeDefined();
    execute(actor, deliveryCommand(item(), statusOf(state.items, item()), target!, value));
    expect(statusOf(state.items, item())).toBe(to);
  };
  return { execute, item, targets, move, snapshot: () => state };
}

describe("交付看板", () => {
  it("按执行人和验收人各自的权限完成生产交付", () => {
    const board = setup();
    expect(board.targets("zhouhang").map(({ to }) => to)).not.toContain("done");
    board.move("zhouhang", "doing");
    board.move("zhouhang", "review", "测试环境已核对");
    expect(board.targets("zhouhang")).toEqual([{ to: "doing", action: "status" }]);
    expect(board.targets("linyue").map(({ to }) => to)).not.toContain("done");
    board.move("linyue", "release");
    expect(board.targets("linyue")).toEqual([]);
    board.move("zhouhang", "production-review", "v2.4");
    board.move("linyue", "done");
    expect(board.item().publication?.version).toBe("v2.4");
    expect(board.item().checks.map(({ type }) => type)).toEqual(["测试验收", "线上验收"]);
  });

  it("阻塞和打回保留原因，并由既有命令拦截空原因", () => {
    const board = setup();
    expect(() => board.move("zhouhang", "blocked")).toThrow("阻塞必须填写原因");
    board.move("zhouhang", "blocked", "等待权限接口");
    expect(board.item().blockedReason).toBe("等待权限接口");
    board.move("zhouhang", "review", "测试环境已核对");
    expect(() => board.move("linyue", "doing")).toThrow("打回需要写明原因");
    board.move("linyue", "doing", "补测访客权限");
    expect(board.item().checks.at(-1)?.note).toBe("补测访客权限");
  });

  it("拒绝状态或提交轮次已变化的拖动", () => {
    const board = setup();
    const start = deliveryCommand(board.item(), "todo", { to: "doing", action: "status" });
    board.move("zhouhang", "review", "第一轮");
    expect(() => board.execute("zhouhang", start)).toThrow("交付状态已变化");
    const verify = deliveryCommand(board.item(), "review", { to: "release", action: "accept" });
    board.move("zhouhang", "doing");
    board.move("zhouhang", "review", "第二轮");
    expect(() => board.execute("linyue", verify)).toThrow("交付状态已变化");
  });

  it("有未完成子任务的需求以汇总状态为准", () => {
    const state = setup().snapshot();
    const parent = state.items.find(({ id }) => id === "F1")!;
    const manager = state.accounts.find(({ id }) => id === "chenmo")!;
    expect(statusOf(state.items, parent)).toBe("doing");
    expect(deliveryMoves(state.items, parent, manager)).toEqual([]);
  });
});
