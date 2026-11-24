import { canSee } from "../access";
import { dateOffset, today, type WorkItem } from "../model";
import type { AppState } from "../state";
import { isInactive } from "../tree";
import { updateKey } from "../updates";
import type { Notice } from "./plan";

export function mentionNotices(before: WorkItem | undefined, item: WorkItem, id: string, now: Date): Notice[] {
  const find = (x?: WorkItem) => x?.updates.find((update, index) => updateKey(update, index) === id);
  const update = find(item);
  if (!update || update.retractedAt) return [];
  const previous = new Set(find(before)?.mentions?.map(({ id }) => id));
  return (update.mentions ?? []).filter(({ id }) => !previous.has(id)).map(({ id: recipientId }) => {
    const recipient = `account:${recipientId}`;
    return {
      type: "mention", objectId: `mention:${item.id}:${id}`, recipient, window: id, level: "info",
      itemId: item.id, updateId: id, expires: dateOffset(today(now), 7),
      report: { title: "有一条动态提到了你", to: recipient, sections: [] },
    };
  });
}

export function validMention(state: AppState, notice: Notice): Notice | undefined {
  const item = state.items.find((x) => x.id === notice.itemId);
  const recipient = state.accounts.find((account) => notice.recipient === `account:${account.id}`);
  if (!item || !recipient || isInactive(state.items, item) || !canSee(state.items, item, recipient)) return;
  const update = item.updates.find((entry, index) => updateKey(entry, index) === notice.updateId);
  if (!update || update.retractedAt || !update.mentions?.some(({ id }) => id === recipient.id)) return;
  const author = state.people.find(({ id }) => id === update.by)?.name ?? "有成员";
  const characters = Array.from(update.text.replace(/\s+/g, " ").trim());
  const excerpt = characters.slice(0, 80).join("") + (characters.length > 80 ? "…" : "");
  return { ...notice, report: {
    ...notice.report, tone: "blue", action: { label: "查看动态", itemId: item.id, updateId: notice.updateId },
    sections: [{ heading: notice.report.title, variant: "handoff", lines: [{
      text: item.title, itemId: item.id, updateId: notice.updateId,
      context: `${author}提到了你`, detail: `「${excerpt}」`,
    }] }],
  } };
}
