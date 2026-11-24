"use client";

import { useRef, useState, type ClipboardEvent } from "react";
import { ImagePlus, X } from "lucide-react";
import { ATTACHMENT_TYPES, attachmentError, attachmentMime, MAX_ITEM_SCREENSHOTS } from "@/lib/attachments";
import { btnGhost, cx, iconBtn, sm } from "./ui";

const imageExtensions = Object.entries(ATTACHMENT_TYPES)
  .filter(([mime]) => mime.startsWith("image/"))
  .flatMap(([, extensions]) => extensions.map((extension) => `.${extension}`))
  .join(",");

export function useScreenshotDraft(initial: File[] = [], existingCount = 0) {
  const [files, setFiles] = useState(initial);
  const [error, setError] = useState("");

  function add(selected: File[]) {
    if (!selected.length) return;
    const next = [...files];
    let failure = "";
    for (const file of selected) {
      if (existingCount + next.length >= MAX_ITEM_SCREENSHOTS) {
        failure = `最多添加 ${MAX_ITEM_SCREENSHOTS} 张截图`;
        break;
      }
      const mime = attachmentMime(file.name, file.type);
      const invalid = mime.startsWith("image/") ? attachmentError({ name: file.name, mime, size: file.size }) : "请选择图片作为截图";
      if (invalid) failure = `${file.name}：${invalid}`;
      else next.push(file);
    }
    setFiles(next);
    setError(failure);
  }

  return {
    files, error, add, full: existingCount + files.length >= MAX_ITEM_SCREENSHOTS,
    onPaste(event: ClipboardEvent<HTMLElement>) {
      if (!event.currentTarget.contains(event.target as Node) || !event.clipboardData.files.length) return;
      event.preventDefault();
      add(Array.from(event.clipboardData.files));
    },
    remove(index: number) { setFiles((current) => current.filter((_, position) => position !== index)); setError(""); },
    clear() { setFiles([]); setError(""); },
  };
}

export function DraftScreenshots({ draft, busy = false, compact = false }: {
  draft: ReturnType<typeof useScreenshotDraft>; busy?: boolean; compact?: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const full = draft.full;
  return (
    <div
      role="group"
      aria-label="添加截图"
      className={cx("min-w-0 rounded-lg", compact ? "py-1" : "border border-line px-2 py-1", dragging && "ring-2 ring-accent")}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={(event) => {
        if (!event.dataTransfer.files.length) return;
        event.preventDefault();
        setDragging(false);
        if (!busy) draft.add(Array.from(event.dataTransfer.files));
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || full} className={cx(btnGhost, sm)} onClick={() => input.current?.click()}><ImagePlus />添加截图</button>
        <span className="text-[11px] text-fg-4" role={busy && draft.files.length ? "status" : undefined}>
          {busy && draft.files.length ? "正在保存截图…" : full ? "已达到截图上限" : "可粘贴或拖入 · 每张 ≤10MB"}
        </span>
        <input ref={input} type="file" multiple accept={imageExtensions} hidden
          onChange={(event) => { if (!busy) draft.add(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
      </div>
      {draft.files.length > 0 && <ul className="mt-1 flex flex-wrap gap-1">
        {draft.files.map((file, index) => (
          <li key={`${index}-${file.name}`} className="flex max-w-full items-center gap-1 rounded bg-sunken pl-2 text-xs">
            <span className="max-w-44 truncate" title={file.name}>{file.name}</span>
            <button type="button" disabled={busy} className={iconBtn} aria-label={`移除截图 ${file.name}`} onClick={() => draft.remove(index)}><X /></button>
          </li>
        ))}
      </ul>}
      {draft.error && <p role="alert" className="mt-1 text-xs text-danger">{draft.error}</p>}
    </div>
  );
}
