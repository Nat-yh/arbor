import { canSee } from "../access";
import { dateOffset, today } from "../model";
import type { AppState } from "../state";
import { isInactive } from "../tree";
import type { Notice } from "./plan";

export function defectNotice(state: AppState, itemId: string, defectId: string, now: Date): Notice | undefined {
  const defect = state.items.find((item) => item.id === itemId)?.defects.find((entry) => entry.id === defectId);
  if (!defect) return;
  const recipient = `account:${defect.owner}`;
  return validDefectNotice(state, {
    type: "defect", objectId: defectId, recipient, window: itemId, itemId,
    level: "info", expires: dateOffset(today(now), 7),
    report: { title: "", to: recipient, sections: [] },
  });
}

export function validDefectNotice(state: AppState, notice: Notice): Notice | undefined {
  const item = state.items.find(({ id }) => id === notice.itemId);
  const defect = item?.defects.find(({ id }) => id === notice.objectId);
  const owner = state.accounts.find(({ id }) => id === defect?.owner);
  if (!item || !defect || !owner || notice.recipient !== `account:${owner.id}` ||
      isInactive(state.items, item) || !canSee(state.items, item, owner)) return;

  return { ...notice, report: {
    title: "有一个缺陷由你负责",
    to: notice.recipient,
    tone: defect.severity <= "P1" ? "red" : "blue",
    action: { label: "查看关联工作项", itemId: item.id, tab: "quality" },
    sections: [{
      heading: "缺陷登记", format: "plain", lines: [
        { text: `缺陷：${defect.title}` },
        { text: `严重程度：${defect.severity}` },
        { text: `关联工作项：${item.title}` },
      ],
    }],
  } };
}
