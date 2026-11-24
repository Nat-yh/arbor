import { assigneeIds, person, type WorkItem } from "@/lib/model";
import { cx } from "./ui";

function deliveryLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" || url.protocol === "http:") return url.href;
  } catch {
    // 交付物也可以是文字说明。
  }
}

export default function ReviewSubmission({ item, inline = false, showAuthor = false }: { item: WorkItem; inline?: boolean; showAuthor?: boolean }) {
  const deliverable = item.deliverable || item.pr?.url;
  if (!deliverable) return null;

  const link = deliveryLink(deliverable);
  // 历史记录已保存提交时的交付物和说明，按本次提交匹配。
  const prefix = `提交验收：${deliverable}`;
  const submission = item.updates.findLast(({ id, date, text }) =>
    !id && date === item.reviewSince && (text === prefix || text.startsWith(`${prefix}。`)));
  const note = submission?.text.slice(prefix.length + 1);
  const author = submission?.by ?? (assigneeIds(item).length === 1 ? item.assignee : undefined);

  return (
    <div className={cx("min-w-0 text-xs text-fg-2", inline ? "flex max-w-full items-center gap-2 whitespace-nowrap" : "space-y-0.5")}>
      {showAuthor && author && <p className="text-fg-3">{person(author).name} 已提交</p>}
      {link
        ? <a href={link} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}
            className={cx("inline-block max-w-full truncate align-bottom font-medium text-accent-fg underline-offset-2 hover:underline", inline && "shrink-0")} title={deliverable}>打开交付物 <span aria-hidden="true">↗</span></a>
        : <p className={inline ? "min-w-0 truncate" : "break-words"} title={inline ? deliverable : undefined}>交付物：{deliverable}</p>}
      {note && <p className={inline ? "min-w-0 truncate" : "whitespace-pre-wrap break-words"} title={inline ? note : undefined}>{note}</p>}
    </div>
  );
}
