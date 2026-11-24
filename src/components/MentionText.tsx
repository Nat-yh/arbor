import type { ReactNode } from "react";
import type { Update } from "@/lib/model";
import { findMention } from "@/lib/updates";
import { Avatar } from "./ui";

export type Mentions = NonNullable<Update["mentions"]>;
export const mentionTagClass = "inline-flex max-w-full items-center gap-1 rounded-full bg-accent-soft py-0.5 pl-1.5 pr-1.5 align-middle text-xs font-medium leading-4 text-accent-fg";

export function MentionTag({ id, name }: Mentions[number]) {
  return (
    <span className={mentionTagClass}>
      <span className="shrink-0">@</span>
      <span aria-hidden="true" className="inline-flex shrink-0"><Avatar id={id} size={4} /></span>
      <span className="truncate" title={name}>{name}</span>
    </span>
  );
}

export function mentionRanges(text: string, mentions: Mentions = []) {
  const candidates = mentions.flatMap((mention) => {
    const matches: { start: number; end: number; mention: typeof mention }[] = [];
    const length = mention.name.length + 1;
    for (let start = findMention(text, mention.name); start !== -1; start = findMention(text, mention.name, start + length)) {
      matches.push({ start, end: start + length, mention });
    }
    return matches;
  }).sort((a, b) => a.start - b.start || b.end - a.end);

  const ranges: typeof candidates = [];
  let at = 0;
  for (const range of candidates) {
    if (range.start < at) continue;
    ranges.push(range);
    at = range.end;
  }
  return ranges;
}

export function MentionText({ text, mentions }: { text: string; mentions?: Mentions }) {
  if (!mentions?.length) return text;
  const parts: ReactNode[] = [];
  let at = 0;
  for (const { start, end, mention } of mentionRanges(text, mentions)) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(<MentionTag key={start} {...mention} />);
    at = end;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}
