"use client";

import { AtSign } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode, type RefObject } from "react";
import { canSeeProject, membersOf } from "@/lib/access";
import { person, type WorkItem } from "@/lib/model";
import { useStore } from "@/lib/store";
import { projectOf } from "@/lib/tree";
import { hasMention } from "@/lib/updates";
import { mentionRanges, mentionTagClass, type Mentions } from "./MentionText";
import { Avatar, cx, hueOf } from "./ui";
import { Pop, PopAnchor, PopContent } from "./kit";

export type { Mentions } from "./MentionText";

type Selection = { start: number; end: number };
type Props = Omit<ComponentPropsWithoutRef<"div">, "onChange" | "children" | "onInput"> & {
  item: WorkItem;
  value: string;
  onChange: (text: string) => void;
  mentions: Mentions;
  onMentions: (mentions: Mentions) => void;
  inputRef?: RefObject<HTMLDivElement | null>;
  placeholder?: string;
  footer: (mentionButton: ReactNode) => ReactNode;
};

const mentionQuery = /(?<!@)@([^\s@\p{P}]*)$/u;
const limit = 20000;
const chipSelector = "[data-mention-id]";
// Keep the final empty line addressable by the browser caret; never save the marker.
const lineEndMarker = "\u200B";

function queryAt(text: string, caret: number) {
  const match = mentionQuery.exec(text.slice(0, caret));
  return match ? { start: match.index, query: match[1] } : null;
}

function readText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replaceAll(lineEndMarker, "");
  if (node instanceof HTMLElement) {
    if (node.dataset.mentionId) return "@" + node.dataset.mentionName;
    if (node.tagName === "BR") return "\n";
  }
  return Array.from(node.childNodes).map((child, index) => {
    // Browsers can insert block wrappers around lines from undo or IME.
    const separator = index > 0 && child instanceof HTMLElement && /^(DIV|P)$/.test(child.tagName) ? "\n" : "";
    return separator + readText(child);
  }).join("");
}

function readSelection(editor: HTMLElement): Selection | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return null;
  const before = document.createRange();
  before.selectNodeContents(editor);
  before.setEnd(range.startContainer, range.startOffset);
  const start = readText(before.cloneContents()).length;
  before.setEnd(range.endContainer, range.endOffset);
  return { start, end: readText(before.cloneContents()).length };
}

function placeCaret(editor: HTMLElement, offset: number) {
  const range = document.createRange();
  const selection = window.getSelection();
  for (const child of editor.childNodes) {
    const length = readText(child).length;
    if (offset <= length) {
      if (child.nodeType === Node.TEXT_NODE) range.setStart(child, offset);
      else if (offset === 0) range.setStartBefore(child);
      else range.setStartAfter(child);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    offset -= length;
  }
  range.selectNodeContents(editor);
  range.collapse(false);
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function editorChip({ id, name }: Mentions[number]) {
  const chip = document.createElement("span");
  chip.className = mentionTagClass;
  chip.contentEditable = "false";
  chip.dataset.mentionId = id;
  chip.dataset.mentionName = name;
  const mark = document.createElement("span");
  mark.textContent = "@";
  const member = person(id);
  const avatar = document.createElement("span");
  const hue = hueOf(id);
  avatar.className = "relative inline-flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full text-[9px]";
  avatar.style.background = "oklch(0.93 0.045 " + hue + ")";
  avatar.style.color = "oklch(0.42 0.11 " + hue + ")";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = member.name.slice(-1);
  if (member.avatarUrl?.startsWith("https://")) {
    const photo = document.createElement("img");
    photo.alt = "";
    photo.className = "absolute inset-0 size-full object-cover";
    photo.addEventListener("error", () => photo.remove(), { once: true });
    photo.src = member.avatarUrl;
    avatar.append(photo);
  }
  const label = document.createElement("span");
  label.className = "truncate";
  label.textContent = name;
  chip.append(mark, avatar, label);
  return chip;
}

function writeEditor(editor: HTMLElement, text: string, mentions: Mentions) {
  const fragment = document.createDocumentFragment();
  let offset = 0;
  for (const { start, end, mention } of mentionRanges(text, mentions)) {
    fragment.append(text.slice(offset, start), editorChip(mention));
    offset = end;
  }
  fragment.append(text.slice(offset) + (text.endsWith("\n") ? lineEndMarker : ""));
  editor.replaceChildren(fragment);
}

function editorMentions(editor: HTMLElement, text: string): Mentions {
  const unique = new Map<string, string>();
  for (const chip of editor.querySelectorAll<HTMLElement>(chipSelector)) {
    const { mentionId: id, mentionName: name } = chip.dataset;
    if (id && name && hasMention(text, name)) unique.set(id, name);
  }
  return Array.from(unique, ([id, name]) => ({ id, name }));
}

export function MentionInput({ item, value, onChange, mentions, onMentions, inputRef, placeholder, footer, onKeyDown, className, ...props }: Props) {
  const { items, accounts, mentionCandidates, me } = useStore();
  const project = projectOf(items, item);
  const allowed = mentionCandidates?.[project.id] ?? membersOf(items, project)
    .filter((id) => id !== me && accounts.some((account) => account.id === id && canSeeProject(items, project, account)));
  const fallbackRef = useRef<HTMLDivElement>(null);
  const input = inputRef ?? fallbackRef;
  const mentionTrigger = useRef<HTMLButtonElement>(null);
  const lastSelection = useRef<Selection | null>(null);
  const composing = useRef(false);
  const menuId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [cursor, setCursor] = useState(0);
  const match = caret === null ? null : queryAt(value, caret);
  const query = match?.query.toLowerCase();
  const matches = query === undefined ? [] : allowed.map((id) => person(id))
    .filter(({ name, title }) => name.toLowerCase().includes(query) || title.toLowerCase().includes(query)).slice(0, 8);
  const active = Math.min(cursor, matches.length - 1);

  // Keep the editable DOM intact during typing and IME. Rebuild it for external resets or edits.
  useLayoutEffect(() => {
    const editor = input.current;
    if (!editor || composing.current) return;
    const existingText = readText(editor);
    const existing = editorMentions(editor, existingText);
    if (existingText === value && existing.length === mentions.length &&
        existing.every(({ id }) => mentions.some((mention) => mention.id === id))) return;
    writeEditor(editor, value, mentions);
    lastSelection.current = null;
  }, [input, value, mentions]);

  function trackSelection() {
    const editor = input.current;
    if (!editor) return;
    const selection = readSelection(editor);
    if (selection) lastSelection.current = selection;
    const next = selection && selection.start === selection.end ? selection.start : null;
    if (next !== caret) {
      setCaret(next);
      setCursor(0);
    }
  }

  function syncEditor(editor: HTMLElement) {
    const text = editor.childNodes.length === 1 && editor.firstChild?.nodeName === "BR" ? "" : readText(editor);
    if (text.length > limit) {
      writeEditor(editor, value, mentions);
      placeCaret(editor, value.length);
      return;
    }
    onChange(text);
    onMentions(editorMentions(editor, text));
    trackSelection();
  }

  function replace(selection: Selection, addition: string, selected = mentions) {
    const editor = input.current;
    if (!editor) return;
    const text = value.slice(0, selection.start) + addition + value.slice(selection.end);
    if (text.length > limit) return;
    const next = selection.start + addition.length;
    const remaining = selected.filter(({ name }) => hasMention(text, name));
    writeEditor(editor, text, remaining);
    onChange(text);
    onMentions(remaining);
    editor.focus();
    placeCaret(editor, next);
    lastSelection.current = { start: next, end: next };
    setCaret(next);
    setCursor(0);
  }

  function currentSelection() {
    return (input.current && readSelection(input.current)) ?? lastSelection.current ?? { start: value.length, end: value.length };
  }

  function pick(index: number) {
    const selected = matches[index];
    if (caret === null || !match || !selected) return;
    const alreadySelected = mentions.some(({ id }) => id === selected.id);
    if (!alreadySelected && mentions.length >= 20) return;
    replace({ start: match.start, end: caret }, "@" + selected.name + " ",
      alreadySelected ? mentions : [...mentions, { id: selected.id, name: selected.name }]);
  }

  function removeAdjacentMention(key: "Backspace" | "Delete") {
    const { start, end } = currentSelection();
    if (start !== end) return false;
    const ranges = mentionRanges(value, mentions);
    const mention = key === "Backspace"
      ? ranges.find(({ end }) => end === start || (end + 1 === start && /[ \u00a0]/.test(value[end])))
      : ranges.find((range) => range.start === start);
    if (!mention) return false;
    const boundary = key === "Backspace" ? start : mention.end;
    replace({ start: mention.start, end: boundary }, "");
    return true;
  }

  const mentionButton = <button ref={mentionTrigger} type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => {
    const selection = currentSelection();
    if (selection.start === selection.end && queryAt(value, selection.start)) {
      input.current?.focus();
      if (input.current) placeCaret(input.current, selection.start);
      setCaret(selection.start);
      setCursor(0);
      return;
    }
    replace(selection, "@");
  }} className="inline-flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-xs text-fg-3 hover:bg-hover hover:text-accent-fg">
    <AtSign aria-hidden className="size-3.5" />提及成员
  </button>;

  return <Pop open={!!match} onOpenChange={(open) => { if (!open) setCaret(null); }}>
    <PopAnchor asChild><div {...props} ref={input} contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true"
      aria-placeholder={placeholder} data-placeholder={placeholder} data-empty={value ? undefined : ""}
      className={cx("whitespace-pre-wrap wrap-anywhere outline-none data-[empty]:before:pointer-events-none data-[empty]:before:text-fg-4 data-[empty]:before:content-[attr(data-placeholder)]", className)}
      aria-autocomplete="list" aria-controls={match ? menuId : undefined}
      aria-activedescendant={active >= 0 ? menuId + "-" + active : undefined}
      onFocus={trackSelection}
      onBlur={() => setCaret(null)}
      onMouseUp={trackSelection}
      onKeyUp={(event) => { if (event.key !== "Escape") trackSelection(); }}
      onCompositionStart={() => { composing.current = true; setCaret(null); }}
      onCompositionEnd={(event) => { composing.current = false; syncEditor(event.currentTarget); }}
      onInput={(event) => { if (!composing.current) syncEditor(event.currentTarget); }}
      onPaste={(event) => {
        if (event.clipboardData.files.length) return;
        event.preventDefault();
        replace(currentSelection(), event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n"));
      }}
      onDrop={(event) => {
        if (event.dataTransfer.files.length) return;
        event.preventDefault();
        const text = event.dataTransfer.getData("text/plain").replace(/\r\n?/g, "\n");
        if (text) replace(currentSelection(), text);
      }}
      onCopy={(event) => {
        const selection = readSelection(event.currentTarget);
        if (!selection || selection.start === selection.end) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", value.slice(selection.start, selection.end));
      }}
      onCut={(event) => {
        const selection = readSelection(event.currentTarget);
        if (!selection || selection.start === selection.end) return;
        event.preventDefault();
        event.clipboardData.setData("text/plain", value.slice(selection.start, selection.end));
        replace(selection, "");
      }}
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || composing.current) return;
        if ((event.key === "Backspace" || event.key === "Delete") && removeAdjacentMention(event.key)) {
          event.preventDefault();
          return;
        }
        if (match) {
          if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); setCaret(null); return;
          }
          if (matches.length && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
            event.preventDefault();
            const next = (active + (event.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
            setCursor(next);
            document.getElementById(menuId + "-" + next)?.scrollIntoView({ block: "nearest" });
            return;
          }
          if (active >= 0 && event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
            event.preventDefault(); pick(active); return;
          }
        }
        onKeyDown?.(event);
        if (event.key === "Enter" && !event.defaultPrevented) {
          event.preventDefault();
          replace(currentSelection(), "\n");
        }
      }} /></PopAnchor>
    {match && <PopContent className="z-[60]! w-60 border border-line" alignOffset={8}
      onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}
      onInteractOutside={(event) => {
        const target = event.detail.originalEvent.target;
        if (target instanceof Node && (input.current?.contains(target) || mentionTrigger.current?.contains(target))) event.preventDefault();
      }}>
      <ul id={menuId} role="listbox" aria-label="选择要提及的成员" className="max-h-48 overflow-y-auto">
        {matches.map((candidate, index) => (
          <li id={menuId + "-" + index} key={candidate.id} role="option" aria-selected={index === active}>
            <button type="button" tabIndex={-1} onMouseDown={(event) => event.preventDefault()} onClick={() => pick(index)}
              className={cx("flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs", index === active ? "bg-hover" : "hover:bg-hover")}>
              <Avatar id={candidate.id} size={5} />
              <span className="min-w-0 flex-1 truncate">{candidate.name}</span>
              <span className="truncate text-fg-3">{candidate.title}</span>
            </button>
          </li>
        ))}
      </ul>
      {!matches.length && <p className="px-2 py-1.5 text-xs text-fg-3">没有匹配的项目成员</p>}
    </PopContent>}
    {footer(mentionButton)}
  </Pop>;
}
