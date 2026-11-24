import type { Update } from "./model";

export const updateKey = (update: Update, index: number) => update.id ?? `legacy-${index}`;

export function editableUpdate(update: Update, accountId: string) {
  return update.by === accountId && !update.retractedAt &&
    (!!update.id || !/^(提交验收：|Gitea 评论：)/.test(update.text));
}

export function hasMention(text: string, name: string) {
  return findMention(text, name) !== -1;
}

export function findMention(text: string, name: string, from = 0) {
  // Mentions can follow prose directly. A boundary after the name distinguishes longer names.
  const token = `@${name}`;
  let offset = text.indexOf(token, from);
  while (offset !== -1) {
    const before = text[offset - 1];
    const after = text[offset + token.length];
    if (before !== "@" && (!after || /[\s\p{P}]/u.test(after))) return offset;
    offset = text.indexOf(token, offset + token.length);
  }
  return -1;
}
