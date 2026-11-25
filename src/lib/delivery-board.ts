import { canManage, canVerifyDelivery, type Account } from "./access";
import type { Command } from "./commands";
import { isAssignee, requiresProduction, usesAcceptanceCriteria, type Status, type WorkItem } from "./model";
import { isInactive, isLeaf, openChecks, statusOf, type Items } from "./tree";

export const deliveryColumns = ["todo", "doing", "blocked", "review", "release", "production-review", "done", "cancelled"] as const;

export type DeliveryBoardCommand = Extract<Command, { type: "setStatus" | "submit" | "verify" | "publish" | "recordReleaseIssue" | "verifyProduction" }>;
type MoveAction = "status" | "submit" | "accept" | "reject" | "publish" | "acceptOnline" | "rejectOnline" | "rollback";
export type DeliveryMove = { to: Status; action: MoveAction };

export function deliveryMoves(items: Items, item: WorkItem, account: Account, from = statusOf(items, item)): DeliveryMove[] {
  if (item.kind === "project" || isInactive(items, item)) return [];
  const leaf = isLeaf(items, item.id);
  const production = requiresProduction(item);
  const assignee = isAssignee(item, account.id);
  const canEdit = leaf && (assignee || canManage(items, item, account));
  const canAccept = canVerifyDelivery(items, item, account);

  if (from === "review") {
    const moves: DeliveryMove[] = [];
    if (canAccept && (leaf || production || usesAcceptanceCriteria(item))) {
      moves.push({ to: production ? "release" : "done", action: "accept" });
      if (leaf || production) moves.push({ to: "doing", action: "reject" });
    } else if (canEdit) {
      moves.push({ to: "doing", action: "status" });
    }
    return moves;
  }
  if (from === "release") {
    return production && assignee && item.releaseCycle ? [{ to: "production-review", action: "publish" }] : [];
  }
  if (from === "production-review" || (from === "done" && production)) {
    if (!production || !item.publication || !item.releaseCycle) return [];
    const moves: DeliveryMove[] = [];
    if (from === "production-review" && canAccept) {
      moves.push({ to: "done", action: "acceptOnline" }, { to: "doing", action: "rejectOnline" });
    }
    if (assignee) moves.push({ to: "release", action: "rollback" });
    return moves;
  }
  if (!canEdit) return [];
  if (from === "done") return [{ to: "doing", action: "status" }];

  const moves: DeliveryMove[] = [
    { to: "todo", action: "status" }, { to: "doing", action: "status" },
    { to: "blocked", action: "status" }, { to: "review", action: "submit" },
  ];
  if (item.kind === "task" && !openChecks(items, item).length) moves.push({ to: "done", action: "status" });
  return moves.filter(({ to }) => to !== from);
}

export function deliveryCommand(
  item: WorkItem, from: Status, move: DeliveryMove, value = "", verifiers?: string[], note = "",
): DeliveryBoardCommand | undefined {
  const id = item.id;
  const expectedDelivery = { status: from, reviewToken: from === "review" ? item.reviewToken ?? null : null };
  switch (move.action) {
    case "status":
      if (move.to === "todo" || move.to === "doing" || move.to === "done" || move.to === "blocked") {
        return { type: "setStatus", id, status: move.to, reason: value, expectedDelivery };
      }
      return undefined;
    case "submit":
      return { type: "submit", id, deliverable: value, verifiers, note, expectedDelivery };
    case "accept":
    case "reject":
      return { type: "verify", id, pass: move.action === "accept", note: value, expectedDelivery };
    case "publish":
      return item.releaseCycle && { type: "publish", id, cycle: item.releaseCycle.id, version: value };
    case "acceptOnline":
    case "rejectOnline":
      return item.publication && { type: "verifyProduction", id, publicationId: item.publication.id, pass: move.action === "acceptOnline", note: value };
    case "rollback":
      return item.releaseCycle && item.publication && {
        type: "recordReleaseIssue", id, cycle: item.releaseCycle.id, publicationId: item.publication.id, note: value,
      };
  }
}
